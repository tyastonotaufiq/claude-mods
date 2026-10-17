// adb-explorer: a pane for browsing and managing files on an Android device
// over adb, opened with /adb-explorer.
//
// Safety rules, enforced here and not left to the UI:
//  - Deletes only touch paths strictly inside user storage (/sdcard/...).
//  - Every delete asks first, and the default choice moves files to a
//    device-side trash folder instead of removing them.
//  - Every adb call is an argument list with -s <serial>, so it never acts
//    on the wrong device and never goes through a local shell.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AdbDevice, AdbEntry, AdbInfo } from '../types'
import {
  adbCandidates,
  baseName,
  deleteCommand,
  humanSize,
  INFO_COMMAND,
  infoLine,
  isDeletable,
  listCommand,
  parentPath,
  parseDevices,
  parseDroppedPaths,
  parseInfo,
  parseList,
  parseSizes,
  sizesCommand,
  stampOf,
  TRASH_DIR,
  trashCommand,
} from './adb'

const PANE = 'adb-explorer'
const HOME_DIR = '/sdcard'
const MAX_ROWS = 1000

const devices = atom({ plugin: 'adb-explorer', key: 'devices' } as const, [] as AdbDevice[])
const device = atom({ plugin: 'adb-explorer', key: 'device' } as const, '')
const cwd = atom({ plugin: 'adb-explorer', key: 'cwd' } as const, HOME_DIR)
const entries = atom({ plugin: 'adb-explorer', key: 'entries' } as const, [] as AdbEntry[])
const marked = atom({ plugin: 'adb-explorer', key: 'marked' } as const, [] as string[])
const sizes = atom({ plugin: 'adb-explorer', key: 'sizes' } as const, {} as Record<string, number>)
const busy = atom({ plugin: 'adb-explorer', key: 'busy' } as const, '')
const message = atom({ plugin: 'adb-explorer', key: 'message' } as const, '')
const showHidden = atom({ plugin: 'adb-explorer', key: 'showHidden' } as const, false)
const pushMode = atom({ plugin: 'adb-explorer', key: 'pushMode' } as const, false)
const lastPull = atom({ plugin: 'adb-explorer', key: 'lastPull' } as const, '')
const info = atom({ plugin: 'adb-explorer', key: 'info' } as const, null as (AdbInfo & { serial: string }) | null)

type $ = EngineInterface

// The adb binary, found once per load: Android Studio's SDK first, then PATH,
// then Homebrew. A Desktop-app session may not have the usual PATH, so known
// install locations are checked directly.
let adbBin: string | null = null
let paneOpen = false

async function findAdb($: $): Promise<string | null> {
  if (adbBin) return adbBin
  const candidates = adbCandidates({
    home: (await $.env.get('HOME')) ?? '',
    androidHome: await $.env.get('ANDROID_HOME'),
    sdkRoot: await $.env.get('ANDROID_SDK_ROOT'),
  })
  for (const c of candidates) {
    if (c !== 'adb') {
      if (await $.fs.exists(c)) return (adbBin = c)
      continue
    }
    try {
      const r = await $.process.run(['adb', 'version'], { timeoutMs: 5000 })
      if (r.exitCode === 0) return (adbBin = 'adb')
    } catch {
      // not on PATH; try the next location
    }
  }
  return null
}

const ADB_MISSING =
  'adb not found. It comes with Android Studio (set ANDROID_HOME if your SDK is elsewhere), ' +
  'or install it alone with `brew install android-platform-tools`. Then press r.'

async function adb($: $, args: string[], timeoutMs = 30_000) {
  const bin = await findAdb($)
  if (!bin) throw new Error(ADB_MISSING)
  return $.process.run([bin, ...args], { timeoutMs })
}

async function onDevice($: $, shellCmd: string, timeoutMs = 30_000) {
  const serial = await read($, device)
  if (!serial) throw new Error('No device selected.')
  return adb($, ['-s', serial, 'shell', shellCmd], timeoutMs)
}

/** Run one action with the busy line shown, and errors caught into the message line. */
async function task($: $, label: string, work: () => Promise<void>) {
  if (await read($, busy)) return
  await update($, busy, () => label)
  await update($, message, () => '')
  try {
    await work()
  } catch (err) {
    await update($, message, () => err instanceof Error ? err.message : String(err))
  } finally {
    await update($, busy, () => '')
  }
}

async function refreshDevices($: $) {
  const r = await adb($, ['devices', '-l'], 10_000)
  const list = parseDevices(r.stdout)
  await update($, devices, () => list)
  const ready = list.filter(d => d.state === 'device')
  const current = await read($, device)
  if (!ready.some(d => d.serial === current)) {
    await update($, device, () => ready[0]?.serial ?? '')
    await update($, marked, () => [])
    const saved = ready[0] ? await $.store.get('cwd:' + ready[0].serial) : undefined
    await update($, cwd, () => typeof saved === 'string' ? saved : HOME_DIR)
  }
}

/** Fetch the header info for the selected device. It's extra, so a failure just leaves it blank. */
async function refreshInfo($: $) {
  const serial = await read($, device)
  if (!serial) return
  try {
    const r = await onDevice($, INFO_COMMAND, 10_000)
    await update($, info, () => ({ ...parseInfo(r.stdout), serial }))
  } catch {
    // keep what was there
  }
}

async function listDir($: $, dir: string) {
  if (!(await read($, device))) {
    await update($, entries, () => [])
    return
  }
  const r = await onDevice($, listCommand(dir))
  const list = parseList(r.stdout, dir)
  if (list.length === 0 && r.exitCode !== 0) {
    // stat exits non-zero for an empty folder too, so only fail when cd failed
    const probe = await onDevice($, `cd '${dir.replace(/'/g, `'\\''`)}' && echo ok`)
    if (!probe.stdout.includes('ok')) throw new Error(`Can't open ${dir} (no permission or not found).`)
  }
  await update($, cwd, () => dir)
  await update($, entries, () => list)
  await update($, sizes, () => ({}))
  const serial = await read($, device)
  if (serial) await $.store.set('cwd:' + serial, dir)
}

async function reload($: $) {
  await task($, 'Loading…', async () => {
    await refreshDevices($)
    await listDir($, await read($, cwd))
    await refreshInfo($)
  })
}

async function go($: $, dir: string) {
  await task($, 'Opening ' + dir + '…', () => listDir($, dir))
}

async function computeSizes($: $) {
  await task($, 'Measuring folders…', async () => {
    const dir = await read($, cwd)
    const r = await onDevice($, sizesCommand(dir), 180_000)
    await update($, sizes, () => parseSizes(r.stdout, dir))
  })
}

async function pull($: $) {
  const paths = await read($, marked)
  if (paths.length === 0) return update($, message, () => 'Mark files first ([ ] beside each row).')
  await task($, `Pulling ${paths.length} item(s)…`, async () => {
    const serial = await read($, device)
    const model = (await read($, devices)).find(d => d.serial === serial)?.model ?? serial
    const home = (await $.env.get('HOME')) ?? '.'
    const dest = `${home}/Downloads/adb-explorer/${model.replace(/[^\w.-]+/g, '-')}`
    await $.process.run(['mkdir', '-p', dest])
    const failed: string[] = []
    for (const p of paths) {
      const r = await adbLong($, ['-s', serial, 'pull', '-a', p, dest + '/'])
      if (!r.ok) failed.push(p)
    }
    await update($, lastPull, () => dest)
    await update($, marked, () => failed)
    await update($, message, () =>
      failed.length
        ? `Pulled ${paths.length - failed.length}, failed ${failed.length} (still marked).`
        : `Pulled ${paths.length} item(s) to ${dest}. Press o to open it.`,
    )
  })
}

async function remove($: $) {
  const paths = await read($, marked)
  if (paths.length === 0) return update($, message, () => 'Mark files first ([ ] beside each row).')
  const allowed = paths.filter(isDeletable)
  const refused = paths.filter(p => !isDeletable(p))
  if (allowed.length === 0) {
    return update($, message, () => 'Only files inside /sdcard can be deleted from here.')
  }
  let choice: string
  try {
    choice = await $.ui.ask(
      `Delete ${allowed.length} item(s) from the device?` +
        (refused.length ? ` (${refused.length} outside /sdcard will be skipped)` : ''),
      { header: 'Delete', options: ['Move to device trash', 'Delete permanently', 'Cancel'] },
    )
  } catch {
    return // dismissed
  }
  if (choice !== 'Move to device trash' && choice !== 'Delete permanently') return
  const permanent = choice === 'Delete permanently'
  await task($, permanent ? 'Deleting…' : 'Moving to trash…', async () => {
    const cmd = permanent ? deleteCommand(allowed) : trashCommand(allowed, stampOf(await $.clock.now()))
    const r = await onDevice($, cmd, 120_000)
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim() || 'The device refused the delete.')
    await update($, marked, () => refused)
    await listDir($, await read($, cwd))
    await refreshInfo($)
    await update($, message, () =>
      permanent
        ? `Deleted ${allowed.length} item(s).`
        : `Moved ${allowed.length} item(s) to ${TRASH_DIR}. Empty it there when you're sure.`,
    )
  })
}

/**
 * Run adb without a time limit, for copies that can take as long as the data
 * is big; `$.process.run` stops at ten minutes. Ends when adb does, or when
 * the module unloads.
 */
async function adbLong($: $, args: string[]): Promise<{ ok: boolean; output: string }> {
  const bin = await findAdb($)
  if (!bin) throw new Error(ADB_MISSING)
  const child = $.process.spawn({ argv: [bin, ...args] })
  let output = ''
  for await (const { text } of child) output += text
  const { code } = await child.result
  return { ok: code === 0, output: output.trim() }
}

/** The Mac paths in the push field: the whole text if it names one, else the dropped paths in it. */
async function pushSources($: $, text: string): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const whole = text.trim()
  // A path typed by hand may hold unescaped spaces: `~/My Photos`
  const typed = whole.startsWith('~/') ? home + whole.slice(1) : whole
  if (typed && (await $.fs.exists(typed))) return [typed]
  return parseDroppedPaths(text, home)
}

async function push($: $, text: string) {
  const sources = await pushSources($, text)
  if (sources.length === 0) return
  await task($, 'Pushing…', async () => {
    const missing: string[] = []
    for (const src of sources) if (!(await $.fs.exists(src))) missing.push(src)
    if (missing.length) throw new Error(`Not found on this computer: ${missing.join(', ')}`)
    const serial = await read($, device)
    if (!serial) throw new Error('No device selected.')
    const dir = await read($, cwd)
    const failed: string[] = []
    let lastError = ''
    for (const [i, src] of sources.entries()) {
      const name = baseName(src)
      await update($, busy, () => sources.length > 1 ? `Pushing ${i + 1}/${sources.length}: ${name}…` : `Pushing ${name}…`)
      const r = await adbLong($, ['-s', serial, 'push', src, dir + '/'])
      if (!r.ok) {
        failed.push(name)
        lastError = r.output
      }
    }
    await listDir($, dir)
    await refreshInfo($)
    if (failed.length === sources.length) throw new Error(lastError || 'Push failed.')
    await update($, pushMode, () => false)
    await update($, message, () =>
      failed.length
        ? `Pushed ${sources.length - failed.length} to ${dir}; failed: ${failed.join(', ')} (${lastError || 'adb error'}).`
        : sources.length === 1
          ? `Pushed ${baseName(sources[0] as string)} to ${dir}.`
          : `Pushed ${sources.length} items to ${dir}.`,
    )
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
      name: 'adb_explorer_state',
      description:
        'Returns whether the /adb-explorer pane is open and, if it is, the selected Android device serial and model, the current folder, and the paths the user has marked. Use it when the user refers to "this folder", "these files" or "the marked files" on their phone.',
      inputSchema: { type: 'object', properties: {} },
    })
    try {
      await $.command.register({
        name: 'adb-explorer',
        description: 'Browse files on a connected Android device',
        argumentHint: '[path]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/adb-explorer could not be registered: ' + (err instanceof Error ? err.message : String(err)))
    }
    return next(e)
  })

  on('command.run', { command: 'adb-explorer' }, async ($, e) => {
    const placed = await $.ui.open({ id: PANE, title: 'ADB Explorer', focus: true, closeOnEscape: true })
    paneOpen = true
    const arg = (e.args ?? '').trim()
    void (async () => {
      await reload($)
      if (arg.startsWith('/')) await go($, arg)
    })()
    return placed.isPlaced ? {} : { text: 'ADB Explorer is ready; widen the terminal to see the pane.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // After Claude works on the phone (via the skill), show the result.
  on('turn.complete', async ($, e, next) => {
    if (paneOpen) {
      void go($, await read($, cwd))
      void refreshInfo($)
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__adb-explorer__adb_explorer_state' }, async $ => {
    const serial = await read($, device)
    const model = (await read($, devices)).find(d => d.serial === serial)?.model ?? ''
    return {
      result: JSON.stringify(
        paneOpen
          ? {
              paneOpen: true,
              device: serial || null,
              model,
              folder: await read($, cwd),
              marked: await read($, marked),
            }
          : {
              paneOpen: false,
              note: 'The /adb-explorer pane is not open, so there is no current folder or selection. Do not tell the user it is open.',
            },
        null,
        2,
      ),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>ADB Explorer needs the terminal or the Claude Desktop app.</Text>
    }
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 60

    const list = await read($, devices)
    const serial = await read($, device)
    const dir = await read($, cwd)
    const rows = await read($, entries)
    const picks = await read($, marked)
    const folderSizes = await read($, sizes)
    const working = await read($, busy)
    const note = await read($, message)
    const hidden = await read($, showHidden)
    const pushing = await read($, pushMode)
    const pulledTo = await read($, lastPull)
    const stored = await read($, info)

    const ready = list.filter(d => d.state === 'device')
    const current = list.find(d => d.serial === serial)
    const about = stored?.serial === serial ? stored : null
    const aboutLine = about ? infoLine(about) : ''

    const status = working ? (
      <Text color="yellow">{working}</Text>
    ) : note ? (
      <Text color="cyan" wrap="wrap">{note}</Text>
    ) : null

    if (!serial) {
      const unauthorized = list.some(d => d.state === 'unauthorized')
      const offline = list.some(d => d.state === 'offline')
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text bold>No Android device ready</Text>
          <Text wrap="wrap">
            {unauthorized
              ? 'Unlock the phone and tap Allow on the "Allow USB debugging?" prompt.'
              : offline
                ? 'The device is offline. Unplug it and plug it back in.'
                : 'Connect the phone by USB and turn on USB debugging (Settings › Developer options).'}
          </Text>
          {status}
          <Button key="retry" label="Retry" hotkey="r" plain onPress={() => void reload($)} />
        </Box>
      )
    }

    const visible = rows.filter(r => hidden || !r.name.startsWith('.'))
    const shown = visible.slice(0, MAX_ROWS)
    const nameWidth = Math.max(10, width - 16)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>{about?.name || current?.model || serial}</Text>
          <Text dimColor wrap="truncate-start">{dir}</Text>
        </Box>
        {aboutLine ? <Text dimColor wrap="wrap">{aboutLine}</Text> : null}

        {ready.length > 1 ? (
          <Select
            key="device"
            label="Device"
            value={serial}
            options={ready.map(d => ({ value: d.serial, label: `${d.model} (${d.serial})` }))}
            onSelect={value =>
              void (async () => {
                await update($, device, () => value)
                await update($, marked, () => [])
                const saved = await $.store.get('cwd:' + value)
                await go($, typeof saved === 'string' ? saved : HOME_DIR)
                await refreshInfo($)
              })()
            }
          />
        ) : null}

        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="up" label="Up" hotkey="u" plain onPress={() => void go($, parentPath(dir))} />
          <Button key="home" label="Home" hotkey="g" plain onPress={() => void go($, HOME_DIR)} />
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => void reload($)} />
          <Button key="sizes" label="Sizes" hotkey="s" plain onPress={() => void computeSizes($)} />
          <Button key="pull" label={`Pull (${picks.length})`} hotkey="p" plain onPress={() => void pull($)} />
          <Button key="delete" label={`Delete (${picks.length})`} hotkey="x" plain onPress={() => void remove($)} />
          <Button key="push" label="Push here" hotkey="i" plain onPress={() => void update($, pushMode, v => !v)} />
          <Button key="clear" label="Unmark" hotkey="c" plain onPress={() => void update($, marked, () => [])} />
          <Button
            key="hidden"
            label={hidden ? 'Hide dotfiles' : 'Show dotfiles'}
            hotkey="h"
            plain
            onPress={() => void update($, showHidden, v => !v)}
          />
          {pulledTo ? (
            <Button
              key="open-pulled"
              label="Open pulled"
              hotkey="o"
              plain
              onPress={() => void $.process.run(['open', pulledTo]).catch(() => undefined)}
            />
          ) : null}
        </Box>

        {pushing ? (
          <Input
            key="push-path"
            label="Push from Mac"
            placeholder="Drop files or folders here, or type a path  (Enter to push, Esc to cancel)"
            value=""
            submitLabel="push"
            autoFocus
            onSubmit={value => void push($, value)}
          />
        ) : null}

        {status}
        <Text> </Text>

        {dir !== '/' ? (
          <Button key="parent" label="  ../" plain dimColor onPress={() => void go($, parentPath(dir))} />
        ) : null}
        {shown.length === 0 && !working ? <Text dimColor>  (empty folder)</Text> : null}
        {shown.map((row, i) => {
          const isMarked = picks.includes(row.path)
          const size = row.isDir
            ? folderSizes[row.path] !== undefined
              ? humanSize(folderSizes[row.path] as number)
              : ''
            : humanSize(row.size)
          return (
            <Box key={'row-' + i} flexDirection="row" columnGap={1}>
              <Button
                key={'mark-' + i}
                label={isMarked ? '[x]' : '[ ]'}
                plain
                onPress={() => void toggleMark($, row.path)}
              />
              <Box flexGrow={1}>
                <Button
                  key={'open-' + i}
                  label={fit(row.isDir ? row.name + '/' : row.name, nameWidth)}
                  plain
                  dimColor={!row.isDir}
                  onPress={() => void (row.isDir ? go($, row.path) : toggleMark($, row.path))}
                />
              </Box>
              <Text dimColor>{size}</Text>
            </Box>
          )
        })}
        {visible.length > MAX_ROWS ? (
          <Text dimColor>{`… ${visible.length - MAX_ROWS} more not shown`}</Text>
        ) : null}
      </Box>
    )
  })
}
