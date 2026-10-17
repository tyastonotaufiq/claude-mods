export type AdbDevice = { serial: string; state: string; model: string }

/** What the pane header shows about a device; empty or null when the device doesn't say. */
export type AdbInfo = {
  name: string
  release: string
  sdk: string
  freeBytes: number | null
  totalBytes: number | null
  battery: number | null
  charging: boolean
}

export type AdbEntry = {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

declare module 'claude-code' {
  interface PluginState {
    'adb-explorer': {
      devices: AdbDevice[]
      device: string
      cwd: string
      entries: AdbEntry[]
      marked: string[]
      sizes: Record<string, number>
      busy: string
      message: string
      showHidden: boolean
      pushMode: boolean
      lastPull: string
      info: (AdbInfo & { serial: string }) | null
    }
  }
}
