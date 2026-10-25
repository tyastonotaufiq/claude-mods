export type AppInfo = {
  path: string
  id: string
  name: string
  version: string
  /** CFBundleName and the like: names the app may use for its folders. */
  names: string[]
}

/** How a row belongs to the app: it is the app, its bundle ID, its name, or Claude found it. */
export type LeftoverMatch = 'app' | 'id' | 'name' | 'claude'

export type Leftover = {
  path: string
  size: number
  /** Where it is, in words: App data, Cache, Container… */
  place: string
  match: LeftoverMatch
  reason: string
  /** In a folder other apps from the same developer may use too. */
  shared?: boolean
}

/** What an app that's already gone left behind, under one bundle ID. */
export type Orphan = {
  id: string
  paths: string[]
  places: string[]
  size: number
  /** The name of a system extension of this app that's still running: its containers can't be moved. */
  extension?: string
}

/** A row of `systemextensionsctl list`. */
export type SystemExtension = {
  id: string
  teamId: string
  name: string
  /** activated enabled, terminated waiting to uninstall on reboot… */
  state: string
  active: boolean
}

export type View = 'apps' | 'app' | 'orphans'

declare module 'claude-code' {
  interface PluginState {
    'mac-uninstaller': {
      view: View
      apps: AppInfo[]
      query: string
      app: AppInfo | null
      leftovers: Leftover[]
      orphans: Orphan[]
      extensions: SystemExtension[]
      marked: string[]
      busy: string
      message: string
    }
  }
}
