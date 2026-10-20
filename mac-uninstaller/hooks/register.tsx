// mac-uninstaller: a pane that uninstalls a Mac app together with the files it
// leaves in ~/Library, opened with /mac-uninstaller.
//
// Safety rules, enforced here and not left to the UI:
//  - Nothing is deleted. Marked items go to the Trash (Put Back works), after
//    a confirmation that names the app, how many items and how much space.
//  - Every path is checked again right before it's moved: the app itself must
//    be a .app in /Applications or ~/Applications, and a leftover must sit
//    directly in one of the ~/Library places apps write to (isRemovableLeftover).
//  - Only files named after the app's bundle ID are marked by default. Name
//    matches and shared containers are listed unmarked, to be checked first.
//  - macOS's own apps aren't listed, and an app that's running isn't moved.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AppInfo, Leftover, Orphan, View } from '../types'
import {
  APP_FOLDERS,
  finderTrashScript,
  findOrphans,
  humanSize,
  isRemovableApp,
  isRemovableLeftover,
  isSystemApp,
  leftoverReason,
  markedByDefault,
  matchesQuery,
  matchLeftover,
  mergeLeftovers,
  parseDu,
  parseFindings,
  parseInfoPlist,
  PLACES,
  tildify,
} from './uninstaller'
import type { Place } from './uninstaller'

const PANE = 'mac-uninstaller'
const FINDINGS_REL = '.claude/mac-uninstaller/findings.json'

const view = atom({ plugin: 'mac-uninstaller', key: 'view' } as const, 'apps' as View)
const apps = atom({ plugin: 'mac-uninstaller', key: 'apps' } as const, [] as AppInfo[])
const query = atom({ plugin: 'mac-uninstaller', key: 'query' } as const, '')
const app = atom({ plugin: 'mac-uninstaller', key: 'app' } as const, null as AppInfo | null)
const leftovers = atom({ plugin: 'mac-uninstaller', key: 'leftovers' } as const, [] as Leftover[])
const orphans = atom({ plugin: 'mac-uninstaller', key: 'orphans' } as const, [] as Orphan[])
// Paths in the app view, bundle IDs in the orphans view
const marked = atom({ plugin: 'mac-uninstaller', key: 'marked' } as const, [] as string[])
const busy = atom({ plugin: 'mac-uninstaller', key: 'busy' } as const, '')
const message = atom({ plugin: 'mac-uninstaller', key: 'message' } as const, '')

type $ = EngineInterface

let paneOpen = false

/** How many processes (plutil, du, mdfind) run at once. */
const JOBS = 4

async function homeOf($: $): Promise<string> {
  return ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
}

/** Run one action with the busy line shown, and errors caught into the message line. */
async function task($: $, label: string, work: () => Promise<void>) {
  if (await read($, busy)) return
  await update($, busy, () => label)
  await update($, message, () => '')
  try {
    await work()
  } catch (err) {
    await update($, message, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, busy, () => '')
  }
}

/** Run `work` on every item, JOBS at a time. */
async function eachLimited<T>(list: readonly T[], work: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < list.length) await work(list[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(JOBS, list.length) }, worker))
}

async function listNames($: $, dir: string): Promise<{ name: string; isLink: boolean }[]> {
  try {
    return await $.fs.list(dir)
  } catch {
    return [] // missing, or no permission to list it
  }
}

/** The .app bundles in the app folders, and one folder down (Adobe and others install in a folder). */
async function appPaths($: $, home: string): Promise<string[]> {
  const found: string[] = []
  for (const f of APP_FOLDERS) {
    const root = f.startsWith('/') ? f : home + '/' + f
    for (const c of await listNames($, root)) {
      if (c.name.startsWith('.')) continue
      if (c.name.endsWith('.app')) found.push(root + '/' + c.name)
      else if (c.name !== 'Utilities' && !c.isLink) {
        for (const d of await listNames($, root + '/' + c.name)) {
          if (d.name.endsWith('.app')) found.push(root + '/' + c.name + '/' + d.name)
        }
      }
    }
  }
  return found
}

/**
 * An app's Info.plist read through plutil; undefined when it has no bundle ID.
 * iPhone and iPad apps keep theirs in WrappedBundle, a link to the app inside.
 */
async function readApp($: $, path: string): Promise<AppInfo | undefined> {
  const wrapped = path + '/WrappedBundle/Info.plist'
  const plist = (await $.fs.exists(wrapped)) ? wrapped : path + '/Contents/Info.plist'
  try {
    const r = await $.process.run(['plutil', '-convert', 'json', '-o', '-', plist], { timeoutMs: 10_000 })
    if (r.exitCode === 0) return parseInfoPlist(r.stdout, path)
    // A plist holding dates or data can't become JSON: read the keys one by one
    const fields: Record<string, string> = {}
    for (const key of ['CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleShortVersionString']) {
      const k = await $.process.run(['plutil', '-extract', key, 'raw', '-o', '-', plist], { timeoutMs: 10_000 })
      if (k.exitCode === 0) fields[key] = k.stdout.trim()
    }
    return parseInfoPlist(JSON.stringify(fields), path)
  } catch {
    return undefined
  }
}

async function loadApps($: $): Promise<AppInfo[]> {
  const home = await homeOf($)
  const found: AppInfo[] = []
  await eachLimited(await appPaths($, home), async p => {
    const info = await readApp($, p)
    if (info && !isSystemApp(info)) found.push(info)
  })
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  await update($, apps, () => found)
  return found
}

async function refreshApps($: $) {
  await task($, 'Reading installed apps…', async () => {
    const list = await loadApps($)
    await update($, message, () => `${list.length} apps. Pick one to see what it left on this Mac.`)
  })
}

/** The size of a file or folder in bytes, 0 when du can't tell. */
async function measure($: $, path: string): Promise<number> {
  try {
    // du exits non-zero when some file can't be read; its stdout still has the total
    const r = await $.process.run(['du', '-sk', path], { timeoutMs: 600_000 })
    return Object.values(parseDu(r.stdout))[0] ?? 0
  } catch {
    return 0
  }
}

/** Each child of every place, with the place it's in. */
async function placeChildren($: $, home: string): Promise<{ path: string; name: string; place: Place }[]> {
  const out: { path: string; name: string; place: Place }[] = []
  for (const place of PLACES) {
    const dir = home + '/' + place.rel
    for (const c of await listNames($, dir)) out.push({ path: dir + '/' + c.name, name: c.name, place })
  }
  return out
}

async function readFindings($: $, home: string, id: string): Promise<Leftover[]> {
  const path = home + '/' + FINDINGS_REL
  try {
    if (!(await $.fs.exists(path))) return []
    return parseFindings(await $.fs.read(path), id, home)
  } catch {
    return []
  }
}

/** Show an app with everything it left behind, sizes filling in as they're measured. */
async function openApp($: $, picked: AppInfo) {
  if (await read($, busy)) return
  await update($, view, () => 'app')
  await update($, app, () => picked)
  await update($, marked, () => [])
  await task($, 'Looking for what ' + picked.name + ' left…', async () => {
    const home = await homeOf($)
    const installed = (await read($, apps)).length ? await read($, apps) : await loadApps($)
    const appRow: Leftover = {
      path: picked.path,
      size: 0,
      place: 'App',
      match: 'app',
      reason: [picked.version && 'Version ' + picked.version, picked.id].filter(Boolean).join(' · '),
    }
    const found: Leftover[] = [appRow]
    for (const c of await placeChildren($, home)) {
      const match = matchLeftover(c.name, c.place, picked, installed)
      if (match && isRemovableLeftover(c.path, home)) {
        found.push({
          path: c.path,
          size: 0,
          place: c.place.label,
          match,
          reason: leftoverReason(c.place, match),
          ...(c.place.shared ? { shared: true } : {}),
        })
      }
    }
    const rows = mergeLeftovers(found, await readFindings($, home, picked.id))
    await update($, leftovers, () => rows)
    await update($, marked, () => markedByDefault(rows))

    let done = 0
    await eachLimited(rows, async row => {
      const size = await measure($, row.path)
      await update($, leftovers, list => list.map(l => (l.path === row.path ? { ...l, size } : l)))
      await update($, busy, () => `Measuring ${++done} of ${rows.length}…`)
    })
    const extra = rows.length - 1
    await update($, message, () =>
      extra
        ? `${picked.name} left ${extra} item(s) behind. Press u to move what's marked to the Trash.`
        : `${picked.name} left nothing in the usual places. Press u to move the app to the Trash, or ask Claude to look deeper.`,
    )
  })
}

/** Re-read Claude's findings for the open app, after Claude has worked. */
async function refreshFindings($: $) {
  const picked = await read($, app)
  if ((await read($, view)) !== 'app' || !picked || (await read($, busy))) return
  const home = await homeOf($)
  const current = await read($, leftovers)
  const scan = current.filter(l => l.match !== 'claude')
  const findings = await readFindings($, home, picked.id)
  const rows = mergeLeftovers(scan, findings)
  await update($, leftovers, () => rows)
  const fresh = findings.filter(f => !current.some(c => c.path === f.path))
  if (fresh.length) await update($, message, () => `Claude found ${fresh.length} more item(s). Check them, then press u.`)
}

/**
 * Leftovers of apps that aren't installed any more, one row per bundle ID.
 * With `fresh`, the app list is read again first, for apps added or removed meanwhile.
 */
async function openOrphans($: $, fresh = false) {
  if (await read($, busy)) return
  await update($, view, () => 'orphans')
  await update($, marked, () => [])
  await update($, orphans, () => [])
  await task($, 'Looking for leftovers of removed apps…', async () => {
    const home = await homeOf($)
    const installed = !fresh && (await read($, apps)).length ? await read($, apps) : await loadApps($)
    const children = (await placeChildren($, home)).filter(c => isRemovableLeftover(c.path, home))
    const candidates = findOrphans(children, installed.map(a => a.id))

    // Spotlight knows apps outside the app folders (in Downloads, on other disks)
    const gone: Orphan[] = []
    await eachLimited(candidates, async o => {
      try {
        const r = await $.process.run(['mdfind', `kMDItemCFBundleIdentifier == '${o.id}'c`], { timeoutMs: 15_000 })
        if (r.stdout.split('\n').some(l => l.endsWith('.app'))) return
      } catch {
        // Spotlight off: keep it, the person reviews every row anyway
      }
      gone.push(o)
    })

    let done = 0
    await eachLimited(gone, async o => {
      let size = 0
      for (const p of o.paths) size += await measure($, p)
      await update($, orphans, list => [...list, { ...o, size }].sort((a, b) => b.size - a.size))
      await update($, busy, () => `Measuring ${++done} of ${gone.length}…`)
    })
    const list = await read($, orphans)
    await update($, message, () =>
      list.length
        ? `${list.length} removed apps left ${humanSize(list.reduce((n, o) => n + o.size, 0))}. Check each one, mark it, then press t.`
        : 'No leftovers from removed apps found.',
    )
  })
}

/** Whether the app is running, by any process launched from inside its bundle. */
async function isRunning($: $, a: AppInfo): Promise<boolean> {
  try {
    const r = await $.process.run(['pgrep', '-f', a.path + '/Contents/'], { timeoutMs: 10_000 })
    return r.exitCode === 0 && r.stdout.trim() !== ''
  } catch {
    return false
  }
}

/** Move `paths` to the Trash, keeping Put Back. Returns the paths still there and why. */
async function trash($: $, paths: readonly string[]): Promise<{ left: string[]; why: string }> {
  let why = ''
  let left = [...paths]
  // macOS 15 has a trash command; it can't move what needs an admin password,
  // so whatever is left goes through Finder, which asks for it.
  if (await $.fs.exists('/usr/bin/trash')) {
    const r = await $.process.run(['/usr/bin/trash', ...left], { timeoutMs: 300_000 })
    why = (r.stderr || r.stdout).trim()
    left = await stillThere($, left)
  }
  if (left.length) {
    const r = await $.process.run(['osascript', '-e', finderTrashScript(left)], { timeoutMs: 300_000 })
    why = (r.stderr || r.stdout).trim() || why
    left = await stillThere($, left)
  }
  return { left, why }
}

async function stillThere($: $, paths: readonly string[]): Promise<string[]> {
  const left: string[] = []
  for (const p of paths) if (await $.fs.exists(p)) left.push(p)
  return left
}

async function confirm($: $, question: string): Promise<boolean> {
  try {
    const choice = await $.ui.ask(question, { header: 'Trash', options: ['Move to Trash', 'Cancel'] })
    return choice === 'Move to Trash'
  } catch {
    return false // dismissed
  }
}

async function logMoved($: $, what: string, paths: readonly string[], bytes: number) {
  const log = ((await $.store.get('log')) as unknown[] | undefined) ?? []
  await $.store.set('log', [...log, { at: await $.clock.now(), what, paths, bytes }].slice(-200))
}

/** Move the open app and its marked leftovers to the Trash. */
async function uninstall($: $) {
  if (await read($, busy)) {
    await update($, message, () => 'Wait for the measuring to finish, then press u.')
    return
  }
  const picked = await read($, app)
  if (!picked) return
  const home = await homeOf($)
  const picks = await read($, marked)
  const rows = (await read($, leftovers)).filter(l => picks.includes(l.path))
  const chosen = rows.filter(l => (l.match === 'app' ? isRemovableApp(l.path, home) : isRemovableLeftover(l.path, home)))
  if (chosen.length === 0) {
    await update($, message, () => 'Mark items first ([ ] beside each row).')
    return
  }
  const withApp = chosen.some(l => l.match === 'app')
  if (withApp && (await isRunning($, picked))) {
    await update($, message, () => `${picked.name} is running. Quit it, then press u again.`)
    return
  }
  const bytes = chosen.reduce((n, l) => n + l.size, 0)
  const others = chosen.length - (withApp ? 1 : 0)
  const what = withApp
    ? `${picked.name}${others ? ` and ${others} leftover(s)` : ''}`
    : `${others} leftover(s) of ${picked.name} (the app stays)`
  if (!(await confirm($, `Move ${what}, ${humanSize(bytes)}, to the Trash?`))) return

  await task($, 'Moving to the Trash…', async () => {
    const paths = chosen.map(l => l.path)
    const { left, why } = await trash($, paths)
    const moved = paths.filter(p => !left.includes(p))
    const movedBytes = chosen.filter(l => moved.includes(l.path)).reduce((n, l) => n + l.size, 0)
    await update($, leftovers, list => list.filter(l => !moved.includes(l.path)))
    await update($, marked, () => left)
    if (moved.includes(picked.path)) await update($, apps, list => list.filter(a => a.path !== picked.path))
    await logMoved($, picked.id, moved, movedBytes)

    if (left.length) {
      await update($, message, () =>
        `Moved ${moved.length}, ${left.length} could not be moved (still marked)` +
        (why ? `: ${why.slice(0, 200)}` : '. Quit the app and try again.'),
      )
    } else {
      await update($, message, () =>
        `Moved ${moved.length} item(s), ${humanSize(movedBytes)}, to the Trash. Empty the Trash to get the space back.`,
      )
    }
  })
}

/** Move the marked orphans' files to the Trash. */
async function trashOrphans($: $) {
  if (await read($, busy)) {
    await update($, message, () => 'Wait for the scan to finish, then press t.')
    return
  }
  const home = await homeOf($)
  const picks = await read($, marked)
  const chosen = (await read($, orphans)).filter(o => picks.includes(o.id))
  const paths = chosen.flatMap(o => o.paths).filter(p => isRemovableLeftover(p, home))
  if (paths.length === 0) {
    await update($, message, () => 'Mark items first ([ ] beside each row).')
    return
  }
  const bytes = chosen.reduce((n, o) => n + o.size, 0)
  if (!(await confirm($, `Move what ${chosen.length} removed app(s) left, ${paths.length} item(s), ${humanSize(bytes)}, to the Trash?`))) return

  await task($, 'Moving to the Trash…', async () => {
    const { left, why } = await trash($, paths)
    const moved = paths.filter(p => !left.includes(p))
    const remaining = (await read($, orphans)).flatMap(o => {
      const rest = o.paths.filter(p => !moved.includes(p))
      return rest.length ? [{ ...o, paths: rest }] : []
    })
    await update($, orphans, () => remaining)
    await update($, marked, () => remaining.filter(o => picks.includes(o.id)).map(o => o.id))
    await logMoved($, 'orphans', moved, bytes)
    await update($, message, () =>
      left.length
        ? `Moved ${moved.length}, ${left.length} could not be moved (still marked)${why ? ': ' + why.slice(0, 200) : '.'}`
        : `Moved ${moved.length} item(s) to the Trash. Empty the Trash to get the space back.`,
    )
  })
}

async function toggleMark($: $, key: string) {
  await update($, marked, list => (list.includes(key) ? list.filter(x => x !== key) : [...list, key]))
}

async function back($: $) {
  if (await read($, busy)) return
  await update($, view, () => 'apps')
  await update($, app, () => null)
  await update($, marked, () => [])
  await update($, message, () => '')
}

/** Open the pane on the app list, or straight on the one app `args` names. */
async function start($: $, args: string) {
  await update($, view, () => 'apps')
  await update($, query, () => args.trim())
  await refreshApps($)
  const q = args.trim().toLowerCase()
  if (!q) return
  const list = (await read($, apps)).filter(a => matchesQuery(a, q))
  const exact = list.find(a => a.name.toLowerCase() === q || a.id.toLowerCase() === q)
  const only = exact ?? (list.length === 1 ? list[0] : undefined)
  if (only) await openApp($, only)
}

function fit(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text
  return text.slice(0, Math.max(1, width - 1)) + '…'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'mac_uninstaller_state',
      description:
        'Returns whether the /mac-uninstaller pane is open, which app it shows (name, bundle ID, path), the leftovers it lists and the paths the user marked. Use it before looking for more leftovers of an app, and when the user refers to "these" or what the uninstaller shows.',
      inputSchema: { type: 'object', properties: {} },
    })
    try {
      await $.command.register({
        name: 'mac-uninstaller',
        description: 'Uninstall a Mac app together with the files it leaves behind',
        argumentHint: '[app name]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/mac-uninstaller could not be registered: ' + (err instanceof Error ? err.message : String(err)))
    }
    return next(e)
  })

  on('command.run', { command: 'mac-uninstaller' }, async ($, e) => {
    const placed = await $.ui.open({ id: PANE, title: 'Mac Uninstaller', focus: true, closeOnEscape: true })
    paneOpen = true
    void start($, e.args)
    return placed.isPlaced ? {} : { text: 'Mac Uninstaller is ready; widen the terminal to see the pane.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // Claude may have written findings for the open app (via the skill): show them.
  on('turn.complete', async ($, e, next) => {
    if (paneOpen) void refreshFindings($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__mac-uninstaller__mac_uninstaller_state' }, async $ => {
    const home = await homeOf($)
    const findingsFile = home + '/' + FINDINGS_REL
    if (!paneOpen) {
      return {
        result: JSON.stringify({
          paneOpen: false,
          note: 'The /mac-uninstaller pane is not open. Do not tell the user it is open.',
          findingsFile,
        }),
      }
    }
    const v = await read($, view)
    const picked = await read($, app)
    return {
      result: JSON.stringify(
        {
          paneOpen: true,
          view: v,
          findingsFile,
          app: v === 'app' ? picked : null,
          marked: await read($, marked),
          leftovers: v === 'app' ? await read($, leftovers) : undefined,
          orphans: v === 'orphans' ? await read($, orphans) : undefined,
        },
        null,
        2,
      ),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const width = e.props.bodyColumns ?? 60
    const home = await homeOf($)

    const v = await read($, view)
    const picks = await read($, marked)
    const working = await read($, busy)
    const note = await read($, message)
    const nameWidth = Math.max(10, width - 14)

    const status = (
      <Box flexDirection="column">
        {working ? <Text color="yellow" wrap="truncate-end">{working}</Text> : null}
        {note ? <Text color="cyan" wrap="wrap">{note}</Text> : null}
        <Text> </Text>
      </Box>
    )

    const markRow = (key: string, i: number, label: string, size: number, detail: string, color?: string) => {
      const isMarked = picks.includes(key)
      return (
        <Box key={'row-' + i} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Button key={'mark-' + i} label={isMarked ? '[x]' : '[ ]'} plain onPress={() => void toggleMark($, key)} />
            <Box flexGrow={1}>
              <Button key={'name-' + i} label={fit(label, nameWidth)} plain onPress={() => void toggleMark($, key)} />
            </Box>
            <Text bold={size >= 1024 ** 3}>{humanSize(size)}</Text>
          </Box>
          <Text dimColor={!color} color={color} wrap="truncate-end">{'    ' + detail}</Text>
        </Box>
      )
    }

    const showInFinder = (path: string | undefined) => {
      if (path) void $.process.run(['open', '-R', path]).catch(() => undefined)
      else void update($, message, () => 'Mark an item to show it in Finder.')
    }

    if (v === 'app') {
      const picked = await read($, app)
      const rows = await read($, leftovers)
      const pickedBytes = rows.filter(l => picks.includes(l.path)).reduce((n, l) => n + l.size, 0)
      const total = rows.reduce((n, l) => n + l.size, 0)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text bold>{picked?.name ?? 'Mac Uninstaller'}</Text>
            {total ? <Text dimColor>{`${humanSize(total)} in ${rows.length} item(s)`}</Text> : null}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button
              key="uninstall"
              label={`Move to Trash (${picks.length}${pickedBytes ? ', ' + humanSize(pickedBytes) : ''})`}
              hotkey="u"
              plain
              onPress={() => void uninstall($)}
            />
            <Button key="back" label="All apps" hotkey="b" plain onPress={() => void back($)} />
            <Button key="rescan" label="Rescan" hotkey="r" plain onPress={() => picked && void openApp($, picked)} />
            <Button key="mark-all" label="Mark all" hotkey="a" plain onPress={() => void update($, marked, () => rows.map(l => l.path))} />
            <Button key="clear" label="Unmark" hotkey="c" plain onPress={() => void update($, marked, () => [])} />
            <Button
              key="reveal"
              label="Show in Finder"
              hotkey="f"
              plain
              onPress={() => showInFinder(rows.find(l => picks.includes(l.path))?.path)}
            />
          </Box>
          {status}
          {rows.map((l, i) =>
            markRow(
              l.path,
              i,
              tildify(l.path, home),
              l.size,
              l.place + (l.reason ? ' · ' + l.reason : ''),
              l.match === 'name' || l.shared ? 'yellow' : undefined,
            ),
          )}
        </Box>
      )
    }

    if (v === 'orphans') {
      const list = await read($, orphans)
      const pickedBytes = list.filter(o => picks.includes(o.id)).reduce((n, o) => n + o.size, 0)
      return (
        <Box flexDirection="column">
          <Text bold>Leftovers of removed apps</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button
              key="trash"
              label={`Move to Trash (${picks.length}${pickedBytes ? ', ' + humanSize(pickedBytes) : ''})`}
              hotkey="t"
              plain
              onPress={() => void trashOrphans($)}
            />
            <Button key="back" label="All apps" hotkey="b" plain onPress={() => void back($)} />
            <Button key="rescan" label="Rescan" hotkey="r" plain onPress={() => void openOrphans($, true)} />
            <Button key="mark-all" label="Mark all" hotkey="a" plain onPress={() => void update($, marked, () => list.map(o => o.id))} />
            <Button key="clear" label="Unmark" hotkey="c" plain onPress={() => void update($, marked, () => [])} />
            <Button
              key="reveal"
              label="Show in Finder"
              hotkey="f"
              plain
              onPress={() => showInFinder(list.find(o => picks.includes(o.id))?.paths[0])}
            />
          </Box>
          {status}
          {list.length === 0 && !working ? <Text dimColor>Nothing to show.</Text> : null}
          {list.map((o, i) =>
            markRow(o.id, i, o.id, o.size, `${o.places.join(', ')} · ${o.paths.length} item(s) · app not found on this Mac`),
          )}
        </Box>
      )
    }

    const all = await read($, apps)
    const q = await read($, query)
    const shown = all.filter(a => matchesQuery(a, q))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>Mac Uninstaller</Text>
          {all.length ? <Text dimColor>{`${all.length} apps`}</Text> : null}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="orphans" label="Leftovers of removed apps" hotkey="o" plain onPress={() => void openOrphans($)} />
          <Button key="reload" label="Reload" hotkey="r" plain onPress={() => void refreshApps($)} />
        </Box>
        {Input ? (
          <Input
            key="filter"
            label="Find"
            placeholder="app name"
            value={q}
            submitLabel="open"
            autoFocus
            onInput={value => void update($, query, () => value)}
            onSubmit={value => {
              const first = all.find(a => matchesQuery(a, value))
              if (first) void openApp($, first)
            }}
          />
        ) : null}
        {status}
        {all.length && !shown.length ? <Text dimColor>{`No app matches "${q}".`}</Text> : null}
        {shown.map((a, i) => (
          <Box key={'app-row-' + i} flexDirection="row" columnGap={1}>
            <Box flexGrow={1}>
              <Button key={'app-' + i} label={fit(a.name, nameWidth)} plain onPress={() => void openApp($, a)} />
            </Box>
            <Text dimColor>{a.version}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
