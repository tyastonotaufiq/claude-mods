export type CleanRisk = 'safe' | 'review'

export type CleanItem = {
  path: string
  size: number
  category: string
  risk: CleanRisk
  reason: string
  source: 'scan' | 'claude'
  /** On a summary row: the small items it stands for. Its `path` is a `small:` key, not a file. */
  members?: { path: string; size: number }[]
}

export type DiskSpace = { total: number; free: number }

declare module 'claude-code' {
  interface PluginState {
    'mac-cleaner': {
      items: CleanItem[]
      marked: string[]
      busy: string
      message: string
      disk: DiskSpace
      scannedAt: number
    }
  }
}
