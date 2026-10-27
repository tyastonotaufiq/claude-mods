export type RunningApp = { name: string; pid: number }

/**
 * A mac-caffeinater session: until `endsAt`, while `app` runs, or with neither, until
 * stopped. `minutes` is the preset it was started with, absent for a typed time.
 */
export type Session = { startedAt: number; endsAt?: number; minutes?: number; app?: RunningApp }

declare module 'claude-code' {
  interface PluginState {
    'mac-caffeinater': {
      session: Session | null
      displaySleep: boolean
      view: 'main' | 'apps'
      apps: RunningApp[]
      busy: string
      message: string
    }
  }
}
