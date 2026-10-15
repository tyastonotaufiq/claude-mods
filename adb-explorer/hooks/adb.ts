// Pure helpers for the adb-explorer mod: quoting, parsing and path rules.
// Nothing here runs a process, so every function is unit-testable.

import type { AdbDevice, AdbEntry } from '../types'

/**
 * Where to look for adb, in order; `'adb'` means the one on PATH. The Android
 * SDK comes first so the pane uses the same adb as Android Studio: two adb
 * versions keep killing each other's server and drop Studio's connection.
 */
export function adbCandidates(env: { home: string; androidHome?: string | null; sdkRoot?: string | null }): string[] {
  const sdks = [env.androidHome, env.sdkRoot, env.home + '/Library/Android/sdk', env.home + '/Android/Sdk']
  const list = [
    ...sdks.filter((d): d is string => !!d).map(d => d.replace(/\/+$/, '') + '/platform-tools/adb'),
    'adb',
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ]
  return [...new Set(list)]
}

/** Quote a string for the Android device's /system/bin/sh. */
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'"
}

/** Parse `adb devices -l` output. */
export function parseDevices(out: string): AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const [serial, state] = parts as [string, string]
    const modelPart = parts.find(p => p.startsWith('model:'))
    const model = modelPart ? modelPart.slice('model:'.length).replace(/_/g, ' ') : serial
    devices.push({ serial, state, model })
  }
  return devices
}

/** Join a directory and a name on the device. */
export function joinPath(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir.replace(/\/+$/, '') + '/' + name
}

/** The parent folder of a device path. */
export function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}

/**
 * The shell command that lists one folder. Each line is
 * `<type>/<size>/<mtime>/<name>`: `/` can't appear in a file name, so the
 * name is everything after the third slash. `-L` follows symlinks so that
 * links to folders (like /sdcard) list as folders.
 */
export function listCommand(dir: string): string {
  return `cd ${shQuote(dir)} && stat -L -c '%F/%s/%Y/%n' -- * .* 2>/dev/null`
}

/** Parse the output of `listCommand`. */
export function parseList(out: string, dir: string): AdbEntry[] {
  const entries: AdbEntry[] = []
  for (const line of out.split('\n')) {
    const m = /^([^/]+)\/(\d+)\/(\d+)\/(.+)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const [, type, size, mtime, name] = m as unknown as [string, string, string, string, string]
    if (name === '.' || name === '..' || name === '*' || name === '.*') continue
    entries.push({
      name,
      path: joinPath(dir, name),
      isDir: type === 'directory',
      size: Number(size),
      mtime: Number(mtime),
    })
  }
  return entries.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** The shell command that sizes every subfolder of `dir`, in KiB. */
export function sizesCommand(dir: string): string {
  return `cd ${shQuote(dir)} && for d in * .*; do [ -d "$d" ] && [ "$d" != . ] && [ "$d" != .. ] && du -sk -- "$d" 2>/dev/null; done`
}

/** Parse `du -sk` lines into bytes by full path. */
export function parseSizes(out: string, dir: string): Record<string, number> {
  const sizes: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(.+?)\/?\r?$/.exec(line)
    if (!m) continue
    sizes[joinPath(dir, m[2] as string)] = Number(m[1]) * 1024
  }
  return sizes
}

/** Human-readable size: 1.2 GB, 340 MB, 12 KB. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return (u === 0 || n >= 100 ? Math.round(n).toString() : n.toFixed(1)) + ' ' + units[u]
}

/** Folders a user's files live under. Deletes are only allowed inside them. */
export const STORAGE_ROOTS = ['/sdcard', '/storage/emulated/0', '/storage/self/primary']

/** Where "Move to device trash" puts things. Lives in user storage, so it's a cheap rename. */
export const TRASH_DIR = '/sdcard/_adb_trash'

/**
 * Whether a path may be deleted or moved: it must be strictly inside a
 * storage root (never the root itself), and never the trash folder itself.
 */
export function isDeletable(p: string): boolean {
  const clean = p.replace(/\/+$/, '')
  if (clean.includes('/../') || clean.endsWith('/..')) return false
  if (clean === TRASH_DIR) return false
  return STORAGE_ROOTS.some(root => clean.startsWith(root + '/') && clean.length > root.length + 1)
}

/** Shell command that moves `paths` into a timestamped trash folder. */
export function trashCommand(paths: readonly string[], stamp: string): string {
  const dest = `${TRASH_DIR}/${stamp}`
  return `mkdir -p ${shQuote(dest)} && mv -- ${paths.map(shQuote).join(' ')} ${shQuote(dest)}/`
}

/** Shell command that permanently deletes `paths`. */
export function deleteCommand(paths: readonly string[]): string {
  return `rm -rf -- ${paths.map(shQuote).join(' ')}`
}

/** A timestamp safe for a folder name: 2026-10-15_14-55-02. */
export function stampOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
