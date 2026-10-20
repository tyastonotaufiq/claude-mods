/** One change worth learning: the person's words, a native speaker's, and why. */
export type Note = { from: string; to: string; why: string }

/** A more natural version of a prompt the person sent. */
export type Suggestion = {
  original: string
  improved: string
  notes: Note[]
  /** True when Claude got the improved version instead of what the person typed. */
  sent?: true
}

/**
 * What happens to a prompt once there's a more natural version:
 * `show` sends it as typed and shows the suggestion, `rewrite` sends the
 * suggestion instead, `ask` lets the person pick before it's sent.
 */
export type Mode = 'show' | 'rewrite' | 'ask'

declare module 'claude-code' {
  interface PluginState {
    'english-improver': {
      /** The suggestion for the last prompt, or null when it read naturally or was dismissed. */
      suggestion: Suggestion | null
      /** Whether prompts are checked; off with /english-improver off. */
      enabled: boolean
      mode: Mode
    }
  }
}
