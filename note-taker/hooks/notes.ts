// note-taker: the parts that need no engine (reading ArtifactData's answer,
// note titles, ids and times), kept apart to be tested.

import type { Note } from '../types'

/**
 * The notes in a database answer, newest change first: ArtifactData's to a
 * list or query, or the claude.ai artifacts connector's to db_query. Both give
 * one JSON object per line, `{"id", "data": {text, createdAt, updatedAt}, "version"}`:
 * ArtifactData's between its BEGIN and END lines, the connector's inside its
 * `<untrusted-document-…>` tag.
 */
export function parseNotes(answer: string): Note[] {
  const notes: Note[] = []
  let inside = false
  for (const line of answer.split('\n')) {
    if (/^=== BEGIN ARTIFACT DB /.test(line) || /<untrusted-document-[\w-]+>$/.test(line)) inside = true
    else if (/^=== END ARTIFACT DB /.test(line) || line.startsWith('</untrusted-document-')) inside = false
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

/** The claude.ai artifacts connector's tools, by their names in the session. */
export const CONNECTOR = 'mcp__claude-artifacts__'

/**
 * The person's own Note Taker page in the connector's list_artifacts answer,
 * `{"artifacts": [{slug, title, rel, url, soft_deleted?}]}`, if they have one.
 */
export function findNotebookInJson(answer: string): { slug: string; url: string } | undefined {
  try {
    const list = (JSON.parse(answer) as { artifacts?: Record<string, unknown>[] }).artifacts ?? []
    const page = list.find(a => a.title === 'Note Taker' && a.rel === 'mine' && !a.soft_deleted)
    if (typeof page?.slug === 'string' && typeof page.url === 'string') return { slug: page.slug, url: page.url }
  } catch {
    // Not the JSON asked for: no page found
  }
  return undefined
}

/** The first artifact slug (a UUID) in a connector answer. */
export function slugIn(answer: string): string | undefined {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(answer)?.[0]
}

/** A string field of a connector answer that is plain JSON: `version` from read_declaration, `id` from db_whoami. */
export function fieldIn(answer: string, field: string): string | undefined {
  try {
    const v = (JSON.parse(answer) as Record<string, unknown>)[field]
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}

/** An ArtifactData call on the notes (query, set or delete), as the same call to the connector. */
export function connectorCall(slug: string, collection: string, input: Record<string, unknown>): Record<string, unknown> {
  if (input.action === 'query') {
    return { tool: CONNECTOR + 'db_query', slug, collection, orderBy: { field: 'updatedAt', direction: 'desc' }, limit: 1000 }
  }
  const op: Record<string, unknown> = { op: input.action, path: collection + '/' + String(input.doc_id) }
  if (input.data !== undefined) op.data = input.data
  if (input.if_version !== undefined) op.ifVersion = input.if_version
  return { tool: CONNECTOR + 'db_write', slug, ops: [op] }
}
