export type Pressure = 'normal' | 'warn' | 'critical'

export type Battery = {
  percent: number
  charging: boolean
  /** On the charger (charging or not) */
  onPower: boolean
  /** "1:19", as pmset gives it; absent while it's still estimating */
  remaining?: string
}

/** One sample of the Mac; a value whose command failed is left out. */
export type Stats = {
  at: number
  cpu?: { used: number; user: number; sys: number; load: number }
  memory?: { used: number; total: number }
  pressure?: Pressure
  swap?: { used: number; total: number }
  disk?: { free: number; total: number }
  /** Absent on a Mac without a battery */
  battery?: Battery
  /** Set while macOS slows the CPU for heat; `limit` is its speed cap in percent when it says one */
  throttled?: { limit?: number }
  /** Pane only: GPU use in percent, and the memory it holds */
  gpu?: { used: number; memory?: number }
  /** Pane only: the connection in use and its speed in bytes per second, absent until two samples */
  network?: { device: string; name: string; down?: number; up?: number }
}

export type Proc = { pid: number; name: string; cpu: number; mem: number }

export type BatteryHealth = { maxCapacity: string; condition: string; cycles: number; watts?: number }

/** What only the pane shows: the busiest processes and the battery's health. */
export type Details = { topCpu: Proc[]; topMem: Proc[]; health?: BatteryHealth }

declare module 'claude-code' {
  interface PluginState {
    'mac-monitor': {
      stats: Stats | null
      details: Details | null
      band: boolean
    }
  }
}
