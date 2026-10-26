// Pure helpers for the mac-uninstaller mod: where apps leave files, how a file
// is matched to an app, and the rules for what may be moved to the Trash.
// Nothing here does I/O.

import type { AppInfo, Leftover, Orphan, SystemExtension } from '../types'

/** A folder in ~/Library where apps leave files, one per app or per bundle ID. */
export type Place = {
  rel: string
  label: string
  /** Apps here often name their folder after themselves, not their bundle ID. */
  byName?: boolean
  /** Folders here are shared by a developer's apps (Office's UBF8T346G9.Office). */
  shared?: boolean
}

export const PLACES: readonly Place[] = [
  { rel: 'Library/Application Support', label: 'App data', byName: true },
  { rel: 'Library/Caches', label: 'Cache', byName: true },
  { rel: 'Library/Logs', label: 'Logs', byName: true },
  { rel: 'Library/Preferences', label: 'Settings' },
  { rel: 'Library/Preferences/ByHost', label: 'Settings' },
  { rel: 'Library/Saved Application State', label: 'Window state' },
  { rel: 'Library/HTTPStorages', label: 'Web data' },
  { rel: 'Library/WebKit', label: 'Web data' },
  { rel: 'Library/Cookies', label: 'Cookies' },
  { rel: 'Library/Containers', label: 'Container' },
  { rel: 'Library/Group Containers', label: 'Shared container', shared: true },
  { rel: 'Library/Application Scripts', label: 'App scripts' },
  { rel: 'Library/LaunchAgents', label: 'Starts at login' },
]

/** Where apps are installed. Paths are absolute, or relative to the home folder. */
export const APP_FOLDERS = ['/Applications', 'Applications'] as const

/** Apps that are part of macOS even though they sit in /Applications. */
const SYSTEM_APP_IDS = ['com.apple.Safari']

/** Children of a place that are never an app's leftovers. */
const PLACE_CHILDREN_KEPT = ['ByHost', '.GlobalPreferences.plist', 'com.apple.loginwindow.plist']

/** Home dotfiles and dotfolders that are never trashed, whatever finds them. */
const PROTECTED_DOT = [
  '.Trash',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.netrc',
  '.npmrc',
  '.gitconfig',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.claude',
  '.config',
  '.local',
  '.cache',
]

/** Folders in home whose children may be one app's leftovers (~/.config/<app>). */
const DOT_PARENTS = ['.config', '.local/share', '.cache']

const SUFFIXES = ['.plist', '.savedState', '.binarycookies', '.lockfile']
/** A developer team ID before a group container's name: U5SR49N3PT.only.if.Amphetamine. */
const TEAM_PREFIX = /^(?=[a-z]*\d)[a-z0-9]{10}\./i
/**
 * A reverse-DNS bundle ID, starting with a domain ending (com, de, io, info…),
 * so log and cache names like warp.log.old.1 or main.kts.compiled.cache don't count.
 */
const LOOKS_LIKE_ID = /^([a-z]{2,3}|info|tech|cloud|studio|design|games|software)\.[a-z0-9_-]+\.[a-z0-9_.-]+$/i
/** IDs that belong to macOS itself, even outside com.apple (Shortcuts is is.workflow). */
const APPLE_PREFIXES = ['com.apple.', 'is.workflow.']

/** Normalize a path: collapse slashes, strip a trailing slash. */
export function cleanPath(p: string): string {
  return p.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
}

function parentOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

function hasDotSegments(p: string): boolean {
  return p.split('/').slice(1).some(x => x === '..' || x === '.' || x === '')
}

/** Whether an app is part of macOS and can't be uninstalled. */
export function isSystemApp(app: Pick<AppInfo, 'path' | 'id'>): boolean {
  return app.path.startsWith('/System/') || SYSTEM_APP_IDS.includes(app.id)
}

/**
 * Whether `path` is an app bundle this mod may move to the Trash: a `.app` in
 * /Applications or ~/Applications, or one folder below (apps installed in a folder of their own).
 */
export function isRemovableApp(path: string, home: string): boolean {
  const p = cleanPath(path)
  if (!p.endsWith('.app') || hasDotSegments(p) || p.startsWith('/System/')) return false
  const roots = APP_FOLDERS.map(f => (f.startsWith('/') ? f : cleanPath(home) + '/' + f))
  const parent = parentOf(p)
  return roots.some(r => parent === r || (parentOf(parent) === r && !parent.endsWith('.app')))
}

/**
 * Whether `path` may be moved to the Trash as an app's leftover: directly
 * inside one of the PLACES (never the place itself), or one of Claude's
 * findings in an app's dotfolder (~/.vscode, ~/.config/<app>).
 */
export function isRemovableLeftover(path: string, home: string): boolean {
  const p = cleanPath(path)
  const h = cleanPath(home)
  if (!h || h === '/' || !p.startsWith(h + '/') || hasDotSegments(p)) return false
  const rel = p.slice(h.length + 1)
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (PLACE_CHILDREN_KEPT.includes(name)) return false
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (PLACES.some(pl => pl.rel === dir)) return true
  if (DOT_PARENTS.includes(dir)) return true
  return dir === '' && name.startsWith('.') && name.length > 1 && !PROTECTED_DOT.includes(name)
}

/** The bundle IDs a file or folder name may stand for. */
export function idsIn(name: string): string[] {
  let base = name
  for (const s of SUFFIXES) if (base.endsWith(s)) base = base.slice(0, -s.length)
  const out = [base]
  if (base.startsWith('group.')) out.push((base = base.slice('group.'.length)))
  if (TEAM_PREFIX.test(base)) out.push(base.replace(TEAM_PREFIX, ''))
  return out.map(x => x.toLowerCase())
}

/** Whether `candidate` is the bundle ID `id` or one of its helpers (`id.helper`). */
function isIdOrChild(candidate: string, id: string): boolean {
  return candidate === id || candidate.startsWith(id + '.')
}

/**
 * The installed app a leftover belongs to by bundle ID: the longest installed
 * ID that `name` is or extends, so com.google.Chrome.canary goes to Canary
 * when both are installed, not to Chrome.
 */
export function ownerById(name: string, installedIds: readonly string[]): string | undefined {
  let best: string | undefined
  for (const c of idsIn(name)) {
    for (const id of installedIds) {
      const lid = id.toLowerCase()
      if (isIdOrChild(c, lid) && (!best || lid.length > best.length)) best = lid
    }
  }
  return best
}

/** The names an app may use for its folders: file name, bundle name, display name. */
export function namesOf(app: Pick<AppInfo, 'path' | 'names'>): string[] {
  const file = app.path.slice(app.path.lastIndexOf('/') + 1).replace(/\.app$/, '')
  return [...new Set([file, ...app.names].map(n => n.trim().toLowerCase()))].filter(n => n.length >= 3)
}

/**
 * How a child of `place` belongs to `app`: by bundle ID (sure), by name (worth
 * a look), or not at all. A name another installed app also uses doesn't count.
 */
export function matchLeftover(
  name: string,
  place: Place,
  app: AppInfo,
  installed: readonly AppInfo[],
): 'id' | 'name' | undefined {
  if (PLACE_CHILDREN_KEPT.includes(name)) return undefined
  const owner = ownerById(name, installed.map(a => a.id))
  if (owner) return owner === app.id.toLowerCase() ? 'id' : undefined
  if (!place.byName) return undefined
  const lower = name.toLowerCase()
  const mine = namesOf(app)
  if (!mine.includes(lower)) return undefined
  const others = installed.filter(a => a.path !== app.path).flatMap(namesOf)
  return others.includes(lower) ? undefined : 'name'
}

/** One line on why a leftover is listed, shown under its row. */
export function leftoverReason(place: Place, match: 'id' | 'name'): string {
  if (place.shared) return 'Shared by apps from the same developer; check before removing'
  if (match === 'name') return "Matched by the app's name, not its ID; check it's this app's"
  return 'Matches the app\'s bundle ID'
}

/**
 * Group the bundle-ID-named children of each place whose app is gone into one
 * orphan per ID. Apple's own, anything an installed app owns, and anything
 * from a developer that still has an app installed (com.google.Keystone while
 * Chrome is there) are left out.
 */
export function findOrphans(
  children: readonly { path: string; place: Place }[],
  installedIds: readonly string[],
): Orphan[] {
  const ids = installedIds.map(i => i.toLowerCase())
  const vendors = new Set(ids.map(vendorOf))
  const byId = new Map<string, Orphan>()
  for (const { path, place } of children) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (PLACE_CHILDREN_KEPT.includes(name)) continue
    const candidates = idsIn(name)
    const id = candidates[candidates.length - 1] as string
    if (!LOOKS_LIKE_ID.test(id) || APPLE_PREFIXES.some(a => id.startsWith(a))) continue
    if (candidates.some(c => ids.some(i => isIdOrChild(c, i) || i.startsWith(c + '.')))) continue
    if (vendors.has(vendorOf(id))) continue
    const o = byId.get(id) ?? { id, paths: [], places: [], size: 0 }
    o.paths.push(path)
    if (!o.places.includes(place.label)) o.places.push(place.label)
    byId.set(id, o)
  }
  // An app's helpers (com.x.app.helper) go in the app's row (com.x.app)
  const rows = [...byId.values()].sort((a, b) => a.id.length - b.id.length)
  const merged: Orphan[] = []
  for (const o of rows) {
    const parent = merged.find(m => o.id.startsWith(m.id + '.'))
    if (!parent) merged.push(o)
    else {
      parent.paths.push(...o.paths)
      for (const pl of o.places) if (!parent.places.includes(pl)) parent.places.push(pl)
    }
  }
  return merged
}

/** `com.google` for com.google.Chrome. */
export function vendorOf(id: string): string {
  return id.toLowerCase().split('.').slice(0, 2).join('.')
}

/**
 * Parse `systemextensionsctl list`. Each extension is a tab-separated row:
 * enabled (*), active (*), team ID, `bundle.id (version)`, name, `[state]`.
 */
export function parseSystemExtensions(out: string): SystemExtension[] {
  const list: SystemExtension[] = []
  for (const line of out.split('\n')) {
    const [, active, teamId = '', idVersion = '', name = '', state = ''] = line.split('\t')
    const id = /^(\S+) \(/.exec(idVersion)?.[1]
    const st = /^\[(.*)\]$/.exec(state.trim())?.[1]
    if (!id || st === undefined || !/^[A-Z0-9]{10}$/.test(teamId)) continue
    list.push({ id, teamId, name, state: st, active: active?.trim() === '*' })
  }
  return list
}

/**
 * System extensions whose app is gone: no installed app's ID is theirs or a
 * prefix of theirs, and no installed app comes from the same developer
 * (an extension's ID may not start with its app's).
 */
export function strayExtensions(exts: readonly SystemExtension[], installedIds: readonly string[]): SystemExtension[] {
  const ids = installedIds.map(i => i.toLowerCase())
  const vendors = new Set(ids.map(vendorOf))
  return exts.filter(x => {
    const id = x.id.toLowerCase()
    if (APPLE_PREFIXES.some(a => id.startsWith(a))) return false
    return !ids.some(i => isIdOrChild(id, i)) && !vendors.has(vendorOf(id))
  })
}

/** The running extension of the app with bundle ID `id` (com.example.app.extension for com.example.app). */
export function runningExtensionOf(id: string, exts: readonly SystemExtension[]): SystemExtension | undefined {
  const lid = id.toLowerCase()
  return exts.find(x => x.active && isIdOrChild(x.id.toLowerCase(), lid))
}

/** An extension's state in words. */
export function extensionStatus(x: SystemExtension): string {
  if (x.state.includes('uninstall')) return 'removed when you restart'
  return x.active ? 'still running' : x.state
}

/** Whether `path` is an app's container, which macOS protects while the app's extension runs. */
export function isContainer(path: string): boolean {
  return /\/Library\/(Group )?Containers\/[^/]+$/.test(cleanPath(path))
}

/** Read `plutil -convert json` output of an Info.plist into an app, or nothing. */
export function parseInfoPlist(json: string, path: string): AppInfo | undefined {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json)
  } catch {
    return undefined
  }
  const id = data?.CFBundleIdentifier
  if (typeof id !== 'string' || !id) return undefined
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '')
  const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.app$/, '')
  return {
    path,
    id,
    name: str('CFBundleDisplayName') || file,
    version: str('CFBundleShortVersionString') || str('CFBundleVersion'),
    names: [str('CFBundleName'), str('CFBundleDisplayName'), str('CFBundleExecutable')].filter(Boolean),
  }
}

/**
 * Read the findings file Claude writes for the app with bundle ID `id`:
 * `{ app, items: [{ path, sizeBytes, reason }] }`. Findings for another app,
 * malformed rows and anything not removable are dropped.
 */
export function parseFindings(text: string, id: string, home: string): Leftover[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const d = data as { app?: unknown; items?: unknown }
  if (typeof d?.app !== 'string' || d.app.toLowerCase() !== id.toLowerCase() || !Array.isArray(d.items)) return []
  const items: Leftover[] = []
  for (const raw of d.items) {
    const r = raw as Record<string, unknown>
    if (typeof r?.path !== 'string') continue
    const path = cleanPath(r.path.startsWith('~/') ? home + r.path.slice(1) : r.path)
    if (!isRemovableLeftover(path, home)) continue
    // Another app's container is never this app's leftover, whoever says so
    const inContainers = /\/Library\/(Group )?Containers\/[^/]+$/.test(path)
    if (inContainers && !ownerById(path.slice(path.lastIndexOf('/') + 1), [id])) continue
    const size = Number(r.sizeBytes ?? 0)
    items.push({
      path,
      size: Number.isFinite(size) && size > 0 ? size : 0,
      place: 'Found by Claude',
      match: 'claude',
      reason: typeof r.reason === 'string' ? r.reason : '',
    })
  }
  return items
}

/** Combine leftovers from the scan and Claude: one row per path (the scan's wins), nothing nested twice. */
export function mergeLeftovers(scan: readonly Leftover[], claude: readonly Leftover[]): Leftover[] {
  const byPath = new Map<string, Leftover>()
  for (const l of [...claude, ...scan]) byPath.set(l.path, l)
  const all = [...byPath.values()]
  return all.filter(l => !all.some(o => o !== l && l.path.startsWith(o.path + '/')))
}

/** Rows marked when an app is opened: the app and what matches its bundle ID. */
export function markedByDefault(rows: readonly Leftover[]): string[] {
  return rows.filter(r => r.match === 'app' || (r.match === 'id' && !r.shared)).map(r => r.path)
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

/** Whether an app name or bundle ID matches what the person typed. */
export function matchesQuery(app: AppInfo, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || app.name.toLowerCase().includes(q) || app.id.toLowerCase().includes(q)
}

/**
 * The `osascript -l JavaScript` script that shows the paths it's given selected
 * in Finder: macOS's own "show in Finder" (NSWorkspace), one window per folder.
 * Apps are shown in a second call, a moment later, so their window ends up in
 * front, to be moved to the Trash first: windows from one call open in no set order.
 * The paths come as arguments, so nothing in them is ever read as code.
 */
export const REVEAL_SCRIPT =
  'function run(argv) { ObjC.import("AppKit"); ' +
  'const show = ps => ps.length && $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($(ps.map(p => $.NSURL.fileURLWithPath(p)))); ' +
  'const apps = argv.filter(p => p.endsWith(".app")); ' +
  'show(argv.filter(p => !p.endsWith(".app"))); ' +
  'if (apps.length && apps.length < argv.length) delay(0.5); ' +
  'show(apps) }'

/** The command that shows `paths` selected in Finder. */
export function revealCommand(paths: readonly string[]): string[] {
  return ['osascript', '-l', 'JavaScript', '-e', REVEAL_SCRIPT, '--', ...paths.map(cleanPath)]
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
