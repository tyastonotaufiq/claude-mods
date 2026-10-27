// mac-caffeinater: the parts that need no engine (caffeinate's arguments, the
// running apps from lsappinfo, times typed by the person), kept apart to be tested.

import type { RunningApp, Session } from '../types'

export const PRESETS: readonly { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '4 hours', minutes: 240 },
]

/**
 * caffeinate's arguments for a session: -i keeps the Mac from idle sleep, -d
 * the display too unless it may sleep, -t ends it at `endsAt`, -w with the app.
 */
export function caffeinateArgs(s: Pick<Session, 'endsAt' | 'app'>, displaySleep: boolean, now: number): string[] {
  const args = displaySleep ? ['-i'] : ['-i', '-d']
  if (s.endsAt !== undefined) args.push('-t', String(Math.max(1, Math.ceil((s.endsAt - now) / 1000))))
  if (s.app) args.push('-w', String(s.app.pid))
  return args
}

/**
 * The apps a person runs, from `lsappinfo list`: those of type Foreground (the
 * ones with a Dock icon), so menu bar and background agents are left out, and
 * Finder, which always runs. Named after the .app bundle ("Visual Studio Code",
 * not "Code"), one row per name, the oldest process, sorted by name.
 */
export function parseApps(lsappinfo: string): RunningApp[] {
  const byName = new Map<string, RunningApp>()
  for (const entry of lsappinfo.split(/\n(?=\s*\d+\) ")/)) {
    const title = /^\s*\d+\) "(.*)" ASN/.exec(entry)
    const pid = /\bpid = (\d+)/.exec(entry)
    if (!title || !pid || !/\btype="Foreground"/.test(entry) || /bundleID="com\.apple\.finder"/.test(entry)) continue
    const bundle = /bundle path="[^"]*\/([^/"]+)\.app"/.exec(entry)
    const name = bundle ? bundle[1]! : title[1]!
    const app = { name, pid: Number(pid[1]) }
    const seen = byName.get(name)
    if (!seen || app.pid < seen.pid) byName.set(name, app)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The next time of day matching `text` ("18:30", "6:30 pm", "6pm", "18"),
 * after `now`, in this Mac's time zone; undefined when it isn't a time.
 */
export function parseClockTime(text: string, now: number): number | undefined {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(text)
  if (!m) return undefined
  let hours = Number(m[1])
  const minutes = m[2] === undefined ? 0 : Number(m[2])
  const half = m[3]?.toLowerCase()
  if (minutes > 59) return undefined
  if (half) {
    if (hours < 1 || hours > 12) return undefined
    hours = (hours % 12) + (half === 'pm' ? 12 : 0)
  } else if (hours > 23) return undefined
  const at = new Date(now)
  at.setHours(hours, minutes, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** "18:30", or "tomorrow 08:00" when `at` isn't on the same day as `now`. */
export function clockLabel(at: number, now: number): string {
  const d = new Date(at)
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  return d.toDateString() === new Date(now).toDateString() ? time : 'tomorrow ' + time
}

/** What a session does, for the pane and the status line: "until 18:30". */
export function describe(s: Session, now: number): string {
  if (s.app) return `while ${s.app.name} runs`
  if (s.endsAt !== undefined) return 'until ' + clockLabel(s.endsAt, now)
  return 'until you stop it'
}
