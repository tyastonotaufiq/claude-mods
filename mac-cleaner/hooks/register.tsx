// mac-cleaner: a pane that shows what's using space on this Mac and moves
// what you mark to the Trash, opened with /mac-cleaner.
//
// Safety rules, enforced here and not left to the UI:
//  - Nothing is deleted. Marked items go to the Trash (Put Back works), after
//    a confirmation that names how many items and how much space.
//  - Only items in the list can be trashed, and every path is checked again
//    against isTrashable() right before it's moved: inside ~, never a folder
//    directly in ~, never iCloud, Mail, Photos, Keychains, ~/.ssh and the like.
//  - Claude's findings file is validated the same way when it's read.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CleanItem, DiskSpace } from '../types'
import {
  finderTrashScript,
  humanSize,
  isTrashable,
  mergeItems,
  parseDf,
  parseDu,
  parseFindings,
  rowLabel,
  rowPaths,
  TARGETS,
  tildify,
} from './cleaner'

const PANE = 'mac-cleaner'
const FINDINGS_REL = '.claude/mac-cleaner/findings.json'

const items = atom({ plugin: 'mac-cleaner', key: 'items' } as const, [] as CleanItem[])
const marked = atom({ plugin: 'mac-cleaner', key: 'marked' } as const, [] as string[])
const busy = atom({ plugin: 'mac-cleaner', key: 'busy' } as const, '')
const message = atom({ plugin: 'mac-cleaner', key: 'message' } as const, '')
const disk = atom({ plugin: 'mac-cleaner', key: 'disk' } as const, { total: 0, free: 0 } as DiskSpace)
const scannedAt = atom({ plugin: 'mac-cleaner', key: 'scannedAt' } as const, 0)

type $ = EngineInterface

let paneOpen = false

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

async function readDisk($: $, home: string) {
  try {
    const r = await $.process.run(['df', '-k', home], { timeoutMs: 10_000 })
    await update($, disk, () => parseDf(r.stdout))
  } catch {
    // df failing only hides the free-space line
  }
}

/** The regular files directly in home: the only things there that may be trashed. */
async function homeFiles($: $, home: string): Promise<Set<string>> {
  try {
    const entries = await $.fs.list(home)
    return new Set(entries.filter(e => e.kind === 'file' && !e.isLink).map(e => home + '/' + e.name))
  } catch {
    return new Set()
  }
}

async function readFindings($: $, home: string): Promise<CleanItem[]> {
  const path = home + '/' + FINDINGS_REL
  try {
    if (!(await $.fs.exists(path))) return []
    return parseFindings(await $.fs.read(path), home, await homeFiles($, home))
  } catch {
    return []
  }
}

type Pending = { path: string; category: string; risk: CleanItem['risk']; reason: string }

/**
 * How many folders are measured at once. du mostly waits on the disk, which an
 * SSD serves in parallel: on a 170-folder scan, 4 jobs took about half as long
 * as one, and 8 were no faster than 4.
 */
const SCAN_JOBS = 4

/**
 * The folders the built-in scan measures, one per row. Whole targets (Gradle,
 * DerivedData…) come first: they're the slow ones, so they start while the
 * many small cache folders fill in around them instead of finishing last.
 */
async function scanPaths($: $, home: string): Promise<Pending[]> {
  const pending: Pending[] = []
  const children: Pending[] = []
  for (const t of TARGETS) {
    const abs = t.rel ? home + '/' + t.rel : home
    if (!(await $.fs.exists(abs))) continue
    if (t.expand) {
      let entries: Awaited<ReturnType<$['fs']['list']>> = []
      try {
        entries = await $.fs.list(abs)
      } catch {
        continue // no permission to list it
      }
      for (const c of entries) {
        if (c.isLink || (t.only && !t.only(c.name))) continue
        children.push({ path: abs + '/' + c.name, category: t.category, risk: t.risk, reason: t.reason })
      }
    } else {
      pending.push({ path: abs, category: t.category, risk: t.risk, reason: t.reason })
    }
  }

  const files = await homeFiles($, home)
  return [...pending, ...children].filter(p => isTrashable(p.path, home, files.has(p.path)))
}

/** The size of one folder in bytes, 0 when du can't tell. */
async function measure($: $, path: string): Promise<number> {
  try {
    // du exits non-zero when some file can't be read; its stdout still has the total
    const r = await $.process.run(['du', '-sk', path], { timeoutMs: 600_000 })
    return Object.values(parseDu(r.stdout))[0] ?? 0
  } catch {
    return 0
  }
}

async function scan($: $) {
  await task($, 'Scanning…', async () => {
    const home = await homeOf($)
    if (!home) throw new Error('Could not find your home folder.')
    // Only this scan's results are shown, so nothing stale can be marked meanwhile
    await update($, items, () => [])
    await readDisk($, home)
    const pending = await scanPaths($, home)
    const findings = await readFindings($, home)

    // Measure a few folders at a time and show each result as it comes in
    const results: CleanItem[] = []
    const running: string[] = []
    let next = 0
    const show = async () => {
      const list = mergeItems(results, findings)
      const total = list.reduce((n, i) => n + i.size, 0)
      const slowest = running[0] // the oldest still running, so a big folder stays named
      await update($, items, () => list)
      await update($, busy, () =>
        [
          `Scanning ${results.length} of ${pending.length}`,
          total ? `found ${humanSize(total)} so far` : '',
          slowest ? tildify(slowest, home) + '…' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      )
    }
    const worker = async () => {
      while (next < pending.length) {
        const p = pending[next++] as Pending
        running.push(p.path)
        await show()
        const size = await measure($, p.path)
        running.splice(running.indexOf(p.path), 1)
        results.push({ ...p, size, source: 'scan' })
        await show()
      }
    }
    await Promise.all(Array.from({ length: Math.min(SCAN_JOBS, pending.length) }, worker))

    // Claude may have added findings while the scan ran
    const found = mergeItems(results, await readFindings($, home))
    await update($, items, () => found)
    await update($, marked, list => list.filter(p => found.some(i => i.path === p)))
    const now = await $.clock.now()
    await update($, scannedAt, () => now)
    const total = found.reduce((n, i) => n + i.size, 0)
    await update($, message, () =>
      found.length
        ? `Found ${humanSize(total)} in ${found.length} places. Mark what to remove, then press t.`
        : 'Nothing large found in the usual places. Ask Claude to look deeper.',
    )
  })
}

/** Re-read Claude's findings without rescanning, after Claude has worked. */
async function refreshFindings($: $) {
  const home = await homeOf($)
  if (!home) return
  const current = await read($, items)
  const merged = mergeItems(
    current.filter(i => i.source === 'scan'),
    await readFindings($, home),
  )
  await update($, items, () => merged)
}

async function moveToTrash($: $) {
  // Rows can be marked while a scan runs, but nothing moves until it's done
  if (await read($, busy)) {
    await update($, message, () => 'Wait for the scan to finish, then press t.')
    return
  }
  const home = await homeOf($)
  const picks = await read($, marked)
  const list = await read($, items)
  const chosen = list.filter(i => picks.includes(i.path))
  // A summary row stands for many small items: each one is checked and moved on its own
  const files = await homeFiles($, home)
  const paths = chosen.flatMap(rowPaths).filter(p => isTrashable(p, home, files.has(p)))
  if (paths.length === 0) {
    await update($, message, () => 'Mark items first ([ ] beside each row).')
    return
  }
  const sizeOf = new Map(chosen.flatMap(i => i.members ?? [{ path: i.path, size: i.size }]).map(m => [m.path, m.size]))
  const sum = (ps: readonly string[]) => ps.reduce((n, p) => n + (sizeOf.get(p) ?? 0), 0)
  let choice: string
  try {
    choice = await $.ui.ask(`Move ${paths.length} item(s), ${humanSize(sum(paths))}, to the Trash?`, {
      header: 'Trash',
      options: ['Move to Trash', 'Cancel'],
    })
  } catch {
    return // dismissed
  }
  if (choice !== 'Move to Trash') return

  await task($, 'Moving to the Trash…', async () => {
    // macOS 15 has a trash command; older versions go through Finder. Both keep Put Back.
    const useTrashCmd = await $.fs.exists('/usr/bin/trash')
    const r = useTrashCmd
      ? await $.process.run(['/usr/bin/trash', ...paths], { timeoutMs: 300_000 })
      : await $.process.run(['osascript', '-e', finderTrashScript(paths)], { timeoutMs: 300_000 })

    const left: string[] = []
    for (const p of paths) if (await $.fs.exists(p)) left.push(p)
    const moved = paths.filter(p => !left.includes(p))
    const movedBytes = sum(moved)

    // Drop what moved; a summary row keeps only its members that are still there
    const keys = new Set(chosen.map(i => i.path))
    const remaining = (await read($, items)).flatMap(i => {
      if (!keys.has(i.path)) return [i]
      if (!i.members) return moved.includes(i.path) ? [] : [i]
      const members = i.members.filter(m => !moved.includes(m.path))
      return members.length ? [{ ...i, members, size: members.reduce((n, m) => n + m.size, 0) }] : []
    })
    await update($, items, () => remaining)
    await update($, marked, () => remaining.filter(i => keys.has(i.path)).map(i => i.path))

    const log = ((await $.store.get('log')) as unknown[] | undefined) ?? []
    await $.store.set('log', [...log, { at: await $.clock.now(), paths: moved, bytes: movedBytes }].slice(-200))
    await readDisk($, home)

    if (left.length) {
      const why = (r.stderr || r.stdout).trim()
      await update($, message, () =>
        `Moved ${moved.length}, ${left.length} could not be moved (still marked)` +
        (why ? `: ${why.slice(0, 200)}` : '. Quit the app using them and try again.'),
      )
    } else {
      await update($, message, () =>
        `Moved ${moved.length} item(s), ${humanSize(movedBytes)}, to the Trash. Empty the Trash to get the space back.`,
      )
    }
  })
}

async function toggleMark($: $, p: string) {
  await update($, marked, list => (list.includes(p) ? list.filter(x => x !== p) : [...list, p]))
}

function fit(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text
  return text.slice(0, Math.max(1, width - 1)) + '…'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'mac_cleaner_state',
      description:
        'Returns whether the /mac-cleaner pane is open, the items it lists (path, size, risk) and the paths the user marked. Use it when the user refers to "these", "the marked items" or what the cleaner shows.',
      inputSchema: { type: 'object', properties: {} },
    })
    try {
      await $.command.register({
        name: 'mac-cleaner',
        description: "See what's using space on this Mac and move junk to the Trash",
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/mac-cleaner could not be registered: ' + (err instanceof Error ? err.message : String(err)))
    }
    // Earlier versions saved the last scan to show on open; sizes go stale, so
    // the pane always scans fresh now. Remove what those versions left behind.
    if ((await $.store.get('lastScan')) !== undefined) await $.store.delete('lastScan')
    return next(e)
  })

  on('command.run', { command: 'mac-cleaner' }, async $ => {
    const placed = await $.ui.open({ id: PANE, title: 'Mac Cleaner', focus: true, closeOnEscape: true })
    paneOpen = true
    void scan($)
    return placed.isPlaced ? {} : { text: 'Mac Cleaner is ready; widen the terminal to see the pane.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // Claude may have written new findings (via the skill): show them.
  on('turn.complete', async ($, e, next) => {
    if (paneOpen) void refreshFindings($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__mac-cleaner__mac_cleaner_state' }, async $ => {
    const home = await homeOf($)
    if (!paneOpen) {
      return {
        result: JSON.stringify({
          paneOpen: false,
          note: 'The /mac-cleaner pane is not open. Do not tell the user it is open.',
          findingsFile: home + '/' + FINDINGS_REL,
        }),
      }
    }
    const list = await read($, items)
    return {
      result: JSON.stringify(
        {
          paneOpen: true,
          findingsFile: home + '/' + FINDINGS_REL,
          marked: await read($, marked),
          // A summary row's path is a "small:" key; its members are the real paths
          items: list.map(i => ({
            path: i.path,
            size: i.size,
            risk: i.risk,
            category: i.category,
            source: i.source,
            ...(i.members ? { members: i.members.map(m => m.path) } : {}),
          })),
        },
        null,
        2,
      ),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 60
    const home = await homeOf($)

    const list = await read($, items)
    const picks = await read($, marked)
    const working = await read($, busy)
    const note = await read($, message)
    const space = await read($, disk)

    const pickedBytes = list.filter(i => picks.includes(i.path)).reduce((n, i) => n + i.size, 0)
    const safe = list.filter(i => i.risk === 'safe')
    const review = list.filter(i => i.risk === 'review')
    const nameWidth = Math.max(10, width - 14)

    const row = (item: CleanItem, i: number) => {
      const isMarked = picks.includes(item.path)
      return (
        <Box key={'row-' + i} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Button
              key={'mark-' + i}
              label={isMarked ? '[x]' : '[ ]'}
              plain
              onPress={() => void toggleMark($, item.path)}
            />
            <Box flexGrow={1}>
              <Button
                key={'name-' + i}
                label={fit(rowLabel(item, home), nameWidth)}
                plain
                onPress={() => void toggleMark($, item.path)}
              />
            </Box>
            <Text bold={item.size >= 1024 ** 3}>{humanSize(item.size)}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'    ' + item.category + (item.source === 'claude' ? ' (Claude)' : '') + (item.reason ? ' · ' + item.reason : '')}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>Mac Cleaner</Text>
          {space.total > 0 ? (
            <Text dimColor>{`${humanSize(space.free)} free of ${humanSize(space.total)}`}</Text>
          ) : null}
        </Box>

        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="scan" label="Rescan" hotkey="r" plain onPress={() => void scan($)} />
          <Button
            key="trash"
            label={`Move to Trash (${picks.length}${picks.length ? ', ' + humanSize(pickedBytes) : ''})`}
            hotkey="t"
            plain
            onPress={() => void moveToTrash($)}
          />
          <Button
            key="mark-safe"
            label="Mark all safe"
            hotkey="a"
            plain
            onPress={() => void update($, marked, cur => [...new Set([...cur, ...safe.map(i => i.path)])])}
          />
          <Button key="clear" label="Unmark" hotkey="c" plain onPress={() => void update($, marked, () => [])} />
          <Button
            key="reveal"
            label="Show in Finder"
            hotkey="f"
            plain
            onPress={() => {
              const pick = list.find(i => i.path === picks[0])
              const first = pick ? rowPaths(pick)[0] : undefined
              if (first) void $.process.run(['open', '-R', first]).catch(() => undefined)
              else void update($, message, () => 'Mark an item to show it in Finder.')
            }}
          />
        </Box>

        {working ? <Text color="yellow" wrap="truncate-end">{working}</Text> : null}
        {note ? <Text color="cyan" wrap="wrap">{note}</Text> : null}
        <Text> </Text>

        {list.length === 0 ? (
          <Text dimColor wrap="wrap">
            {working
              ? 'Measuring app caches, logs, Xcode, Gradle, emulators, npm and CocoaPods…'
              : 'No results yet. Press r to scan.'}
          </Text>
        ) : null}

        {safe.length ? <Text bold color="green">{`Safe to remove · ${humanSize(safe.reduce((n, i) => n + i.size, 0))}`}</Text> : null}
        {safe.map((item, i) => row(item, i))}

        {review.length ? <Text> </Text> : null}
        {review.length ? (
          <Text bold color="yellow">{`Review first · ${humanSize(review.reduce((n, i) => n + i.size, 0))}`}</Text>
        ) : null}
        {review.map((item, i) => row(item, safe.length + i))}
      </Box>
    )
  })
}
