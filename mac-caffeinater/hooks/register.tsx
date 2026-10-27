// mac-caffeinater: keeps this Mac from sleeping with macOS's own caffeinate, opened
// with /mac-caffeinater: until you stop it, for a while, until a time, or while an
// app runs. (While Claude works, Claude Code keeps the Mac awake by itself.)
//
// Each caffeinate runs as `sh -c 'echo $$; exec caffeinate …'`, so its first
// output is its pid and stopping it is a kill. It also ends with the session,
// as the engine stops a mod's children when the mod unloads.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunningApp, Session } from '../types'
import { caffeinateArgs, clockLabel, describe, parseApps, parseClockTime, PRESETS } from './awake'

const PANE = 'mac-caffeinater'

const session = atom({ plugin: 'mac-caffeinater', key: 'session' } as const, null as Session | null)
const displaySleep = atom({ plugin: 'mac-caffeinater', key: 'displaySleep' } as const, false)
const view = atom({ plugin: 'mac-caffeinater', key: 'view' } as const, 'main' as 'main' | 'apps')
const apps = atom({ plugin: 'mac-caffeinater', key: 'apps' } as const, [] as RunningApp[])
const busy = atom({ plugin: 'mac-caffeinater', key: 'busy' } as const, '')
const message = atom({ plugin: 'mac-caffeinater', key: 'message' } as const, '')

type $ = EngineInterface
type Child = { stop: () => Promise<void> }

let sessionChild: Child | undefined
/** Counts sessions started, so an old one's end can't clear a newer one. */
let sessionGen = 0

/** Whether this is a Mac: every macOS has this file, Windows and Linux don't. */
async function isMac($: $): Promise<boolean> {
  return $.fs.exists('/System/Library/CoreServices/SystemVersion.plist')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function kill($: $, pid: string) {
  await $.process.run(['kill', pid]).catch(() => undefined)
}

/** Runs caffeinate with `args`; `onExit` runs when it ends by itself, not when stopped. */
function caffeinate($: $, args: string[], onExit: (error: string) => Promise<void>): Child {
  const stream = $.process.spawn({ argv: ['/bin/sh', '-c', 'echo $$; exec /usr/bin/caffeinate "$@"', 'sh', ...args] })
  let pid: string | undefined
  let stopped = false
  void (async () => {
    let error = ''
    try {
      for await (const piece of stream) {
        if (piece.stream === 'stderr') error += piece.text
        else if (!pid) {
          pid = piece.text.trim().split('\n')[0]
          // Stopped before its pid came
          if (stopped && pid) await kill($, pid)
        }
      }
    } catch (err) {
      error = errorText(err)
    }
    // Also reached as the mod unloads, when $ refuses every call: nothing left to update then
    if (!stopped) await onExit(error.trim()).catch(() => undefined)
  })()
  return {
    stop: async () => {
      stopped = true
      if (pid) await kill($, pid)
    },
  }
}

function statusLine(s: Session, now: number): string {
  return 'Awake ' + describe(s, now)
}

async function startSession($: $, s: Session) {
  await sessionChild?.stop()
  const gen = ++sessionGen
  const now = await $.clock.now()
  sessionChild = caffeinate($, caffeinateArgs(s, await read($, displaySleep), now), error => ended($, gen, s, error))
  await update($, session, () => s)
  await update($, message, () => '')
  $.ui.status(statusLine(s, now))
}

/** A session's caffeinate exited by itself: its time was up, its app quit, or it failed. */
async function ended($: $, gen: number, s: Session, error: string) {
  if (gen !== sessionGen) return
  sessionChild = undefined
  await update($, session, () => null)
  $.ui.status(undefined)
  const why = s.app ? `${s.app.name} quit` : "Time's up"
  await update($, message, () => (error ? 'caffeinate stopped: ' + error : why + ': your Mac can sleep again.'))
}

async function stopSession($: $) {
  sessionGen++
  await sessionChild?.stop()
  sessionChild = undefined
  await update($, session, () => null)
  await update($, message, () => 'Stopped: your Mac can sleep again.')
  $.ui.status(undefined)
}

async function startFor($: $, minutes: number) {
  const now = await $.clock.now()
  await startSession($, { startedAt: now, endsAt: now + minutes * 60_000, minutes })
}

async function startUntil($: $, text: string) {
  const now = await $.clock.now()
  const at = parseClockTime(text, now)
  if (at === undefined) {
    await update($, message, () => `"${text.trim()}" isn't a time. Type one like 18:30 or 6:30 pm.`)
    return
  }
  await startSession($, { startedAt: now, endsAt: at })
}

/** The display setting changed: a running session goes on with it. */
async function setDisplaySleep($: $, on: boolean) {
  await $.store.set('displaySleep', on)
  await update($, displaySleep, () => on)
  const s = await read($, session)
  if (s) await startSession($, s)
}

async function showApps($: $) {
  await update($, view, () => 'apps')
  await update($, busy, () => 'Looking for running apps…')
  try {
    const r = await $.process.run(['/usr/bin/lsappinfo', 'list'], { timeoutMs: 10_000 })
    await update($, apps, () => parseApps(r.stdout))
  } catch (err) {
    await update($, message, () => 'Could not list running apps: ' + errorText(err))
  } finally {
    await update($, busy, () => '')
  }
}

async function startWhile($: $, app: RunningApp) {
  await update($, view, () => 'main')
  await startSession($, { startedAt: await $.clock.now(), app })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'mac-caffeinater',
        description: 'Keep this Mac awake for a while, until a time, or while an app runs',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/mac-caffeinater could not be registered: ' + errorText(err))
    }
    const savedDisplay = await $.store.get('displaySleep')
    await update($, displaySleep, () => savedDisplay === true)

    // After a reload the old caffeinate is gone: start the session again, or drop it when it's over
    const s = await read($, session)
    if (s && (await isMac($)) && (s.endsAt === undefined || s.endsAt > (await $.clock.now()))) await startSession($, s)
    else if (s) await update($, session, () => null)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    sessionGen++
    await sessionChild?.stop()
    sessionChild = undefined
    return next(e)
  })

  on('command.run', { command: 'mac-caffeinater' }, async $ => {
    if (!(await isMac($))) return { text: 'Mac Caffeinater needs macOS.' }
    const placed = await $.ui.open({ id: PANE, title: 'Mac Caffeinater', focus: true, closeOnEscape: true })
    return placed.isPlaced ? {} : { text: 'Mac Caffeinater is ready; widen the terminal to see the pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const now = await $.clock.now()
    const s = await read($, session)
    const note = await read($, message)
    const loading = await read($, busy)

    if ((await read($, view)) === 'apps') {
      const list = await read($, apps)
      return (
        <Box flexDirection="column">
          <Text bold>Keep awake while an app runs</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="back" label="Back" hotkey="b" plain onPress={() => void update($, view, () => 'main')} />
            <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => void showApps($)} />
          </Box>
          {loading ? <Text color="yellow">{loading}</Text> : null}
          {note ? <Text color="cyan" wrap="wrap">{note}</Text> : null}
          <Text> </Text>
          {!loading && !list.length ? <Text dimColor>No running apps found.</Text> : null}
          {list.map((a, i) => (
            <Button key={'app-' + i} label={a.name} plain onPress={() => void startWhile($, a)} />
          ))}
        </Box>
      )
    }

    const screen = await read($, displaySleep)
    // The running choice is drawn bold and green inside its button
    const choice = (key: string, label: string, hotkey: string, isRunning: boolean, onPress: () => void) => (
      <Button key={key} label={label} hotkey={hotkey} plain onPress={onPress}>
        {isRunning ? <Text bold color="green">{label}</Text> : label}
      </Button>
    )
    const untilTime = s && s.endsAt !== undefined && s.minutes === undefined ? clockLabel(s.endsAt, s.endsAt) : undefined
    // The running section says so by its heading, so the focus ring can't be taken for it
    const running = !s ? undefined : s.app ? 'app' : untilTime ? 'until' : 'while'
    const heading = (title: string, section: string) => (
      <Box flexDirection="row" columnGap={2}>
        <Text bold>{title}</Text>
        {running === section ? <Text color="green">● on</Text> : null}
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>Mac Caffeinater</Text>
          {s ? (
            <Text color="green">{statusLine(s, now)}</Text>
          ) : (
            <Text dimColor>Off: your Mac sleeps as usual</Text>
          )}
        </Box>
        {s ? <Button key="stop" label="Stop" hotkey="s" plain onPress={() => void stopSession($)} /> : null}
        {note ? <Text color="cyan" wrap="wrap">{note}</Text> : null}
        <Text> </Text>

        {heading('For a while', 'while')}
        {choice('indefinitely', 'Until I stop it', '1', !!s && s.endsAt === undefined && !s.app, () => {
          void (async () => startSession($, { startedAt: await $.clock.now() }))()
        })}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {PRESETS.map((p, i) =>
            choice('for-' + p.minutes, p.label, String(i + 2), s?.minutes === p.minutes, () => void startFor($, p.minutes)),
          )}
        </Box>
        <Text> </Text>

        {Input ? heading('Until a time', 'until') : null}
        {Input ? (
          <Input
            key="until"
            label="Until"
            placeholder="18:30"
            value={untilTime}
            submitLabel="start"
            onSubmit={value => void startUntil($, value)}
          />
        ) : null}
        {Input ? <Text dimColor>Type a time like 18:30 or 6:30 pm, then press Enter.</Text> : null}
        {Input ? <Text> </Text> : null}

        {heading('While an app is open', 'app')}
        {choice('while-app', s?.app ? 'Choose an app… (' + s.app.name + ')' : 'Choose an app…', 'a', !!s?.app, () => void showApps($))}
        <Text> </Text>

        <Button
          key="display"
          label={(screen ? '[x]' : '[ ]') + ' Let the display sleep'}
          hotkey="d"
          plain
          onPress={() => void setDisplaySleep($, !screen)}
        />
      </Box>
    )
  })
}
