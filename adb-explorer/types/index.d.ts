export type AdbDevice = { serial: string; state: string; model: string }

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
    }
  }
}
