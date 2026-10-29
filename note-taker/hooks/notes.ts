// note-taker: the parts that need no engine (reading ArtifactData's answer,
// note titles, ids and times), kept apart to be tested.

import type { Note } from '../types'

/**
 * The notes in ArtifactData's answer to a list or query, newest change first.
 * The documents come one JSON object per line between its BEGIN and END
 * lines: `{"id", "data": {text, createdAt, updatedAt}, "version"}`.
 */
export function parseNotes(answer: string): Note[] {
  const notes: Note[] = []
  let inside = false
  for (const line of answer.split('\n')) {
    if (/^=== BEGIN ARTIFACT DB /.test(line)) inside = true
    else if (/^=== END ARTIFACT DB /.test(line)) inside = false
    else if (inside && line.startsWith('{')) {
      let row: { id?: unknown; data?: Record<string, unknown>; version?: unknown }
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const d = row.data ?? {}
      if (typeof row.id !== 'string' || typeof d.text !== 'string') continue
      notes.push({
        id: row.id,
        text: d.text,
        createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
        updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
        version: typeof row.version === 'number' ? row.version : 0,
      })
    }
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The person's own Note Taker page in the Artifact tool's list, if they have
 * one. Its rows read `- (mine) <title> — <url> — updated <date>`.
 */
export function findNotebook(list: string): string | undefined {
  return /^- \(mine\) Note Taker — (https:\/\/claude\.ai\/\S*artifact\/\S+) — /m.exec(list)?.[1]
}

/** The new page's link in the Artifact tool's answer to a publish: `Published <file> at <url> (Version 1, …)`. */
export function publishedUrl(answer: string): string | undefined {
  return / at (https:\/\/claude\.ai\/\S*artifact\/[A-Za-z0-9-]+)/.exec(answer)?.[1]
}

/** A note's first line, which the page and the pane show as its title. */
export function title(text: string): string {
  return text.split('\n')[0]!.trim() || '(untitled)'
}

/** A new note's id, made the same way as on the page: `n`, the time, a random tail. */
export function newId(now: number, random: number): string {
  return 'n' + now.toString(36) + random.toString(36).slice(2, 8)
}

/** When a note last changed: `14:05` today, else `3 Oct`, or `3 Oct 2025` in another year. */
export function when(ms: number, now: number): string {
  const d = new Date(ms)
  const today = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d.toDateString() === today.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = d.getDate() + ' ' + months[d.getMonth()]
  return d.getFullYear() === today.getFullYear() ? day : day + ' ' + d.getFullYear()
}
