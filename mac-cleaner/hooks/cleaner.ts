// Pure helpers for the mac-cleaner mod: scan targets, parsing, and the rules
// for what may be moved to the Trash. Nothing here does I/O.

import type { CleanItem, CleanRisk, DiskSpace } from '../types'

/** A location the built-in scan measures. Paths are relative to the home folder. */
export type Target = {
  rel: string
  category: string
  risk: CleanRisk
  reason: string
  /** Measure each child separately instead of the folder as a whole. */
  expand?: boolean
  /** With `expand`, only children whose name passes this test. */
  only?: (name: string) => boolean
}

export const TARGETS: readonly Target[] = [
  {
    rel: 'Library/Caches',
    expand: true,
    category: 'App caches',
    risk: 'safe',
    reason: 'Cache files; the app rebuilds them when needed. Quit the app first.',
  },
  { rel: 'Library/Logs', category: 'Logs', risk: 'safe', reason: 'Old app and system logs.' },
  {
    rel: 'Library/Developer/Xcode/DerivedData',
    category: 'Xcode',
    risk: 'safe',
    reason: 'Build products; Xcode rebuilds them on the next build.',
  },
  {
    rel: 'Library/Developer/Xcode/iOS DeviceSupport',
    category: 'Xcode',
    risk: 'safe',
    reason: 'Debug symbols for iOS versions; downloaded again when you connect a device.',
  },
  {
    rel: 'Library/Developer/CoreSimulator/Caches',
    category: 'Xcode',
    risk: 'safe',
    reason: 'iOS Simulator caches.',
  },
  {
    rel: 'Library/Developer/Xcode/Archives',
    category: 'Xcode',
    risk: 'review',
    reason: 'App archives. Keep ones you may need to re-submit or to symbolicate crashes.',
  },
  {
    rel: '.gradle/caches',
    category: 'Android / Gradle',
    risk: 'safe',
    reason: 'Gradle dependency and build caches; downloaded again on the next build (first build is slower).',
  },
  {
    rel: '.gradle/wrapper/dists',
    category: 'Android / Gradle',
    risk: 'safe',
    reason: 'Gradle distributions; each project re-downloads the version it needs.',
  },
  {
    rel: '.android/avd',
    expand: true,
    only: name => name.endsWith('.avd'),
    category: 'Android emulators',
    risk: 'review',
    reason: 'An emulator and its data. Remove ones you no longer use (or delete them in Device Manager).',
  },
  {
    rel: 'Library/Android/sdk/system-images',
    expand: true,
    category: 'Android SDK',
    risk: 'review',
    reason: 'Emulator system images for one API level; reinstall from the SDK Manager if needed.',
  },
  { rel: '.npm/_cacache', category: 'npm', risk: 'safe', reason: 'npm download cache.' },
  { rel: '.cocoapods/repos', category: 'CocoaPods', risk: 'safe', reason: 'Pod spec repos; fetched again when needed.' },
]

/**
 * Scanned items smaller than this don't get a row of their own. They're summed
 * per category into one summary row, shown when the sum reaches this size too.
 */
export const MIN_SIZE = 10 * 1024 * 1024

const SMALL_PREFIX = 'small:'

/**
 * Home-relative paths that are never trashed from here, whatever finds them:
 * cloud sync, mail, photos, keys, and folders whose children are the user's own work.
 */
const PROTECTED_PREFIXES = [
  'Library/Mobile Documents',
  'Library/CloudStorage',
  'Library/Keychains',
  'Library/Mail',
  'Library/Messages',
  'Library/Photos',
  'Library/Preferences',
  'Library/Application Support/MobileSync',
  'Library/Group Containers',
  'Library/Containers',
  'Pictures/Photos Library.photoslibrary',
  '.ssh',
  '.gnupg',
  '.Trash',
]

/** Folders that may hold trashable children but are never trashed themselves. */
const PROTECTED_EXACT = [
  'Library/Caches',
  'Library/Application Support',
  'Library/Developer',
  'Library/Android',
  'Library/Android/sdk',
  '.gradle',
  '.android',
  '.npm',
]

/** Normalize a path: collapse slashes, strip a trailing slash. */
export function cleanPath(p: string): string {
  return p.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
}

/**
 * Whether `path` may be moved to the Trash: inside the home folder, at least
 * two levels deep (never ~/Downloads itself, only things in it), with no `..`,
 * and not in or above a protected place.
 */
export function isTrashable(path: string, home: string): boolean {
  const p = cleanPath(path)
  const h = cleanPath(home)
  if (!h || h === '/' || !p.startsWith(h + '/')) return false
  const rel = p.slice(h.length + 1)
  const parts = rel.split('/')
  if (parts.some(x => x === '..' || x === '.' || x === '')) return false
  if (parts.length < 2) return false
  if (PROTECTED_EXACT.includes(rel)) return false
  if (PROTECTED_PREFIXES.some(pre => rel === pre || rel.startsWith(pre + '/') || pre.startsWith(rel + '/'))) {
    return false
  }
  return true
}

/** Parse `du -sk` output into bytes by path. */
export function parseDu(out: string): Record<string, number> {
  const sizes: Record<string, number> = {}
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line)
    if (m) sizes[cleanPath(m[2] as string)] = Number(m[1]) * 1024
  }
  return sizes
}

/** Parse `df -k <path>` output into total and free bytes. */
export function parseDf(out: string): DiskSpace {
  const lines = out.trim().split('\n')
  const cols = (lines[lines.length - 1] ?? '').trim().split(/\s+/)
  // Filesystem 1024-blocks Used Available Capacity ...
  const total = Number(cols[1]) * 1024
  const free = Number(cols[3]) * 1024
  return { total: Number.isFinite(total) ? total : 0, free: Number.isFinite(free) ? free : 0 }
}

/**
 * Read the findings file Claude writes. Accepts
 * `{ items: [{ path, sizeBytes, category, risk, reason }] }` and drops anything
 * malformed or not trashable, so a bad file can't put a protected path in the list.
 */
export function parseFindings(text: string, home: string): CleanItem[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = (data as { items?: unknown })?.items
  if (!Array.isArray(list)) return []
  const items: CleanItem[] = []
  for (const raw of list) {
    const r = raw as Record<string, unknown>
    if (typeof r?.path !== 'string') continue
    const path = cleanPath(r.path.startsWith('~/') ? home + r.path.slice(1) : r.path)
    if (!isTrashable(path, home)) continue
    const size = Number(r.sizeBytes ?? r.size ?? 0)
    items.push({
      path,
      size: Number.isFinite(size) && size > 0 ? size : 0,
      category: typeof r.category === 'string' && r.category ? r.category : 'Found by Claude',
      risk: r.risk === 'safe' ? 'safe' : 'review',
      reason: typeof r.reason === 'string' ? r.reason : '',
      source: 'claude',
    })
  }
  return items
}

/** Split summary rows back into the items they stand for. */
export function ungroup(items: readonly CleanItem[]): CleanItem[] {
  return items.flatMap(item =>
    item.members ? item.members.map(m => ({ ...item, path: m.path, size: m.size, members: undefined })) : [item],
  )
}

/** The paths a row moves to the Trash: its members for a summary row, else itself. */
export function rowPaths(item: CleanItem): string[] {
  return item.members ? item.members.map(m => m.path) : [item.path]
}

/** The deepest folder holding every path. */
export function commonFolder(paths: readonly string[]): string {
  const split = paths.map(p => p.split('/').slice(0, -1))
  const first = split[0] ?? []
  let n = first.length
  for (const parts of split) {
    let i = 0
    while (i < n && parts[i] === first[i]) i++
    n = i
  }
  return first.slice(0, n).join('/') || '/'
}

/** What a row shows as its name. */
export function rowLabel(item: CleanItem, home: string): string {
  if (!item.members) return tildify(item.path, home)
  const where = tildify(commonFolder(item.members.map(m => m.path)), home)
  return `${item.members.length} items under ${humanSize(MIN_SIZE)} in ${where}`
}

/**
 * Combine scan results and Claude's findings: one row per path (the scan's
 * row wins), biggest first within each risk. Scanned items under MIN_SIZE are
 * summed into one row per category, shown when the sum reaches MIN_SIZE.
 * Claude's findings always get their own row.
 */
export function mergeItems(scan: readonly CleanItem[], claude: readonly CleanItem[]): CleanItem[] {
  const byPath = new Map<string, CleanItem>()
  for (const item of [...claude, ...ungroup(scan)]) byPath.set(item.path, item)
  // Drop rows nested inside another row, so nothing is counted twice
  const all = [...byPath.values()]
  const kept = all.filter(item => !all.some(other => other !== item && item.path.startsWith(other.path + '/')))

  const rows: CleanItem[] = []
  const small = new Map<string, CleanItem[]>()
  for (const item of kept) {
    if (item.source === 'claude' || item.size >= MIN_SIZE) rows.push(item)
    else if (item.size > 0) small.set(item.category, [...(small.get(item.category) ?? []), item])
  }
  for (const [category, group] of small) {
    const size = group.reduce((n, i) => n + i.size, 0)
    if (size < MIN_SIZE) continue
    const first = group[0] as CleanItem
    rows.push({
      path: SMALL_PREFIX + category,
      size,
      category,
      risk: group.every(i => i.risk === 'safe') ? 'safe' : 'review',
      reason: group.every(i => i.reason === first.reason) ? first.reason : '',
      source: 'scan',
      members: group.map(i => ({ path: i.path, size: i.size })).sort((a, b) => b.size - a.size),
    })
  }
  return rows.sort((a, b) => (a.risk !== b.risk ? (a.risk === 'safe' ? -1 : 1) : b.size - a.size))
}

/** Quote a string for an AppleScript string literal. */
export function appleScriptQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** The AppleScript that moves `paths` to the Trash through Finder (so Put Back works). */
export function finderTrashScript(paths: readonly string[]): string {
  const files = paths.map(p => `POSIX file ${appleScriptQuote(p)}`).join(', ')
  return `tell application "Finder" to delete {${files}}`
}

/** A path shown relative to home, as `~/...`. */
export function tildify(path: string, home: string): string {
  return home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
}

/** Human-readable size: 1.2 GB, 340 MB. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return (u < 3 || n >= 100 ? Math.round(n).toString() : n.toFixed(1)) + ' ' + units[u]
}
