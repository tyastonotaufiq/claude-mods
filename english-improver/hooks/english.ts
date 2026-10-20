// Pure helpers for the english-improver mod: which prompts are worth a look,
// what the model is asked, and how its reply is read. Nothing here does I/O.

import type { Mode, Note, Suggestion } from '../types'

/** The modes as the Mode button offers them: the question's option, and the button's word. */
export const MODES: readonly { mode: Mode; label: string; short: string }[] = [
  { mode: 'show', label: "Show, don't change", short: 'Show' },
  { mode: 'rewrite', label: 'Rewrite, then send', short: 'Rewrite' },
  { mode: 'ask', label: 'Ask each time', short: 'Ask' },
]

/** A stored mode, or show when there's none or it isn't one. */
export function modeOf(value: unknown): Mode {
  return MODES.some(m => m.mode === value) ? (value as Mode) : 'show'
}

/** Prompts shorter than this many words aren't checked ("yes", "go ahead"). */
export const MIN_WORDS = 3

/** Prose longer than this is left alone: it's mostly a paste, not the person's own writing. */
export const MAX_CHARS = 2000

/** At most this many notes are shown under a suggestion. */
export const MAX_NOTES = 3

/** The person's own words in a prompt: code blocks taken out, whitespace tidied. */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Whether a prompt is worth checking: a few words of prose, not a shell
 * command (`!ls`), a memory note (`#…`) or a long paste.
 */
export function shouldCheck(text: string): boolean {
  const t = text.trim()
  if (!t || t.startsWith('!') || t.startsWith('#')) return false
  const prose = proseOf(t)
  if (prose.length > MAX_CHARS) return false
  const words = prose.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []
  return words.length >= MIN_WORDS
}

export const SYSTEM = `You are an English coach for a non-native speaker. They write messages to an AI coding assistant, and want each one to read the way a fluent native speaker would write it.

Rewrite the message the way a native speaker would write the same thing:
- Fix grammar, word choice, articles, prepositions, capitalization (including "i" → "I") and unnatural phrasing.
- Keep the meaning, and the register: casual stays casual, short stays short, direct stays direct. Don't add politeness, content or explanations.
- Keep code, file paths, commands, identifiers, URLs, product names, quoted text and technical terms exactly as written.
- Leave anything that is already natural unchanged. Casual style that native speakers also use is fine.

Reply with JSON only, no other text:
- If the message already reads naturally: {"natural": true}
- Otherwise: {"improved": "<the whole message, rewritten>", "notes": [{"from": "<their words>", "to": "<yours>", "why": "<under 12 words>"}]}

Give at most ${MAX_NOTES} notes, the ones most worth learning from (word choice, grammar, phrasing), each "from" copied exactly from the message. Fix capitalization in the rewrite, but don't spend a note on it unless it's the only change.`

/** The user message sent to the model for one prompt. */
export function requestFor(prose: string): string {
  return `<message>\n${prose}\n</message>`
}

/** Text compared loosely: case, spacing and trailing punctuation don't count. */
function loose(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?\s]+$/, '')
    .trim()
}

/**
 * Read the model's reply for `original`. Undefined when the prompt was
 * already natural, the reply isn't the JSON asked for, or the rewrite only
 * changed case or a full stop at the end.
 */
export function parseReply(reply: string, original: string): Suggestion | undefined {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) return undefined
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json)
  } catch {
    return undefined
  }
  if (data.natural === true) return undefined
  const improved = typeof data.improved === 'string' ? data.improved.trim() : ''
  if (!improved || loose(improved) === loose(original)) return undefined
  const notes: Note[] = []
  if (Array.isArray(data.notes)) {
    for (const raw of data.notes) {
      const n = raw as Record<string, unknown>
      if (typeof n?.from !== 'string' || typeof n.to !== 'string' || !n.from.trim()) continue
      if (n.from.trim() === n.to.trim()) continue
      notes.push({ from: n.from.trim(), to: n.to.trim(), why: typeof n.why === 'string' ? n.why.trim() : '' })
      if (notes.length === MAX_NOTES) break
    }
  }
  return { original, improved, notes }
}

/** One note as the band shows it: `mark all → mark everything · why`. */
export function noteLine(n: Note): string {
  return `${n.from} → ${n.to}` + (n.why ? ` · ${n.why}` : '')
}
