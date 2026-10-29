// note-taker: notes in a /note-taker pane, the same notes as on the person's
// own Note Taker page on claude.ai, where they can read and write them from
// any device.
//
// Each person has their own page: the first time it's needed, the mod finds the
// "Note Taker" page they already have (made on another computer), or publishes
// page/note-taker.html as a new one, and remembers its link. The notes live in
// the page's database, in the person's private `data/users/<id>` collection.
// The pane reads and writes them through Claude Code's own ArtifactData tool,
// so each call goes through the usual permission check. The pane doesn't
// update live: it reads the notes when it opens, after each change it makes,
// after Claude changes them, and on Refresh.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note } from '../types'
import { findNotebook, newId, parseNotes, publishedUrl, title, when } from './notes'

const PANE = 'note-taker'
const TOOL = 'mcp__note-taker__notebook'
/** The signed-in person's own notes; ArtifactData reads `me` as their id. */
const COLLECTION = 'data/users/me'

const notes = atom({ plugin: 'note-taker', key: 'notes' } as const, [] as Note[])
const loaded = atom({ plugin: 'note-taker', key: 'loaded' } as const, false)
const openId = atom({ plugin: 'note-taker', key: 'openId' } as const, '')
const confirmDelete = atom({ plugin: 'note-taker', key: 'confirmDelete' } as const, false)
const busy = atom({ plugin: 'note-taker', key: 'busy' } as const, '')
const message = atom({ plugin: 'note-taker', key: 'message' } as const, '')
const notebookLink = atom({ plugin: 'note-taker', key: 'notebookUrl' } as const, '')

type $ = EngineInterface

/** The pane's own ArtifactData calls running, so the tool.call hook doesn't reload for them. */
let ownCalls = 0
/** The page being found or made, so two callers at once don't make two pages. */
let finding: Promise<string> | undefined

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs a tool for the pane; `pressed` names what the person did, for the permission check. */
async function run($: $, input: Record<string, unknown>, pressed: string): Promise<string> {
  const r = await $.tool.call({ ...input, consent: `The user pressed "${pressed}" in the Note Taker pane` } as never)
  if (r.deny !== undefined) throw new Error(r.deny)
  if (r.isError) throw new Error(r.text ?? String(input.tool) + ' failed')
  return r.text ?? ''
}

/** The person's own Note Taker page: the one remembered, else one they already have, else a new one. */
function notebookUrl($: $, pressed: string): Promise<string> {
  finding ??= (async () => {
    const saved = await $.store.get('notebookUrl')
    if (typeof saved === 'string' && saved) return saved
    let url = findNotebook(await run($, { tool: 'Artifact', action: 'list', limit: 200 }, pressed))
    if (!url) {
      const page = `${$.plugin.root}/page/note-taker.html`
      // The Artifact tool publishes only a file it has seen read
      await run($, { tool: 'Read', file_path: page }, pressed)
      const answer = await run(
        $,
        {
          tool: 'Artifact',
          action: 'publish',
          file_path: page,
          icon: 'notes',
          description: 'Your private notes, the same ones the Note Taker mod shows in Claude Code.',
          capabilities: { db: {}, user: {} },
        },
        pressed,
      )
      url = publishedUrl(answer)
      if (!url) throw new Error('the page was published, but its link was not in the answer')
    }
    await $.store.set('notebookUrl', url)
    return url
  })().finally(() => {
    finding = undefined
  })
  return finding
}

/** Runs ArtifactData on the person's notes. */
async function notebook($: $, input: Record<string, unknown>, pressed: string): Promise<string> {
  const url = await notebookUrl($, pressed)
  ownCalls++
  try {
    return await run($, { tool: 'ArtifactData', url, collection: COLLECTION, ...input }, pressed)
  } finally {
    ownCalls--
  }
}

async function load($: $, pressed = 'Open') {
  const isFirst = !(await $.store.get('notebookUrl'))
  await update($, busy, () => (isFirst ? 'Setting up your Note Taker page on claude.ai…' : 'Reading your notes…'))
  try {
    const text = await notebook($, { action: 'query', query: { order_by: { field: 'updatedAt', direction: 'desc' }, limit: 1000 } }, pressed)
    await update($, notes, () => parseNotes(text))
    await update($, loaded, () => true)
    await update($, message, m => (m.startsWith('Could not read') ? '' : m))
    const url = await $.store.get('notebookUrl')
    if (typeof url === 'string') await update($, notebookLink, () => url)
  } catch (err) {
    await update($, message, () => 'Could not read your notes: ' + errorText(err) + ' Press r to try again.')
    // The page may have been deleted: next time, look for it again (or make a new one)
    await $.store.delete('notebookUrl')
  } finally {
    await update($, busy, () => '')
  }
}

async function add($: $, value: string) {
  const text = value.trim()
  if (!text) return
  const now = await $.clock.now()
  try {
    await notebook($, { action: 'set', doc_id: newId(now, Math.random()), data: { text, createdAt: now, updatedAt: now } }, 'Add')
    await update($, message, () => '')
  } catch (err) {
    await update($, message, () => 'Could not add the note: ' + errorText(err))
    return
  }
  await load($, 'Add')
}

async function save($: $, note: Note, value: string) {
  const text = value.trim()
  if (!text) {
    await update($, confirmDelete, () => true)
    return
  }
  if (text !== note.text) {
    const data = { text, createdAt: note.createdAt, updatedAt: await $.clock.now() }
    try {
      await notebook($, { action: 'set', doc_id: note.id, data, if_version: note.version }, 'Save')
      await update($, message, () => 'Saved.')
    } catch (err) {
      // Changed elsewhere since it was read (on the page, or by Claude): show what's there now
      await update($, message, () => 'Not saved: ' + errorText(err))
    }
  }
  await load($, 'Save')
}

async function remove($: $, note: Note) {
  try {
    await notebook($, { action: 'delete', doc_id: note.id, if_version: note.version }, 'Delete')
    await update($, openId, () => '')
    await update($, message, () => 'Deleted.')
  } catch (err) {
    await update($, message, () => 'Not deleted: ' + errorText(err))
  }
  await update($, confirmDelete, () => false)
  await load($, 'Delete')
}

async function open($: $, id: string) {
  await update($, openId, () => id)
  await update($, confirmDelete, () => false)
  await update($, message, () => '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'notebook',
      description:
        "Returns the link of the user's own Note Taker page on claude.ai and the collection their notes are in, setting up the page the first time, plus the current time (`now`, ms) and an id for a new note (`newId`). Call it before reading or writing their notes with ArtifactData.",
      inputSchema: { type: 'object', properties: {} },
    })
    try {
      await $.command.register({ name: 'note-taker', description: 'Your notes, the same as on your Note Taker page on claude.ai', immediate: true })
    } catch (err) {
      $.ui.log('/note-taker could not be registered: ' + errorText(err))
    }
    return next(e)
  })

  on('command.run', { command: 'note-taker' }, async $ => {
    const placed = await $.ui.open({ id: PANE, title: 'Note Taker', focus: true, closeOnEscape: true })
    void load($)
    return placed.isPlaced ? {} : { text: 'Note Taker is ready; widen the terminal to see the pane.' }
  })

  on('tool.call', { tool: TOOL }, async $ => {
    try {
      const url = await notebookUrl($, 'notebook')
      // The time and an id for a new note, so Claude needs no shell to make them
      const now = await $.clock.now()
      return { result: JSON.stringify({ url, collection: COLLECTION, now, newId: newId(now, Math.random()) }) }
    } catch (err) {
      return { result: JSON.stringify({ error: 'Could not find or set up the Note Taker page: ' + errorText(err) }) }
    }
  })

  // Claude changed the notes (through the skill): show them
  on('tool.call', { tool: 'ArtifactData' }, async ($, e, next) => {
    const r = await next(e)
    const input = e as unknown as { url?: string; action?: string }
    const isWrite = !['get', 'list', 'query', 'profiles'].includes(input.action ?? '')
    try {
      if (!ownCalls && isWrite && input.url === (await $.store.get('notebookUrl')) && (await read($, loaded))) void load($, 'Refresh')
    } catch {
      // Only the pane's refresh is lost; the call itself went through
    }
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const now = await $.clock.now()
    const list = await read($, notes)
    const loading = await read($, busy)
    const note = await read($, message)
    const id = await read($, openId)
    const current = id ? list.find(n => n.id === id) : undefined

    if (current) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text bold wrap="truncate">{title(current.text)}</Text>
            <Text dimColor>{when(current.updatedAt, now)}</Text>
          </Box>
          <Button key="back" label="Back" hotkey="b" plain onPress={() => void open($, '')} />
          {loading ? <Text color="yellow">{loading}</Text> : null}
          {note ? <Text color="cyan" wrap="wrap">{note}</Text> : null}
          <Text> </Text>
          {Input ? (
            <Input key="edit" rows={8} value={current.text} submitLabel="save" onSubmit={value => void save($, current, value)} />
          ) : (
            <Text wrap="wrap">{current.text}</Text>
          )}
          <Text> </Text>
          {(await read($, confirmDelete)) ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Text color="red">Delete this note?</Text>
              <Button key="delete-yes" label="Delete" hotkey="y" plain onPress={() => void remove($, current)} />
              <Button key="delete-no" label="Keep" hotkey="n" plain onPress={() => void update($, confirmDelete, () => false)} />
            </Box>
          ) : (
            <Button key="delete" label="Delete" hotkey="d" plain onPress={() => void update($, confirmDelete, () => true)} />
          )}
        </Box>
      )
    }

    const link = await read($, notebookLink)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>Note Taker</Text>
          <Text dimColor>{list.length === 1 ? '1 note' : list.length + ' notes'}</Text>
        </Box>
        <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => void load($, 'Refresh')} />
        {loading ? <Text color="yellow">{loading}</Text> : null}
        {note ? <Text color="cyan" wrap="wrap">{note}</Text> : null}
        <Text> </Text>
        {Input ? <Input key="new" label="New" placeholder="Write a note…" rows={2} submitLabel="add" onSubmit={value => void add($, value)} /> : null}
        <Text> </Text>
        {!loading && (await read($, loaded)) && !list.length ? <Text dimColor>No notes yet.</Text> : null}
        {list.map(n => (
          <Button key={'note-' + n.id} label={title(n.text) + '  ' + when(n.updatedAt, now)} plain onPress={() => void open($, n.id)} />
        ))}
        <Text> </Text>
        {link ? <Text dimColor wrap="wrap">{'Also on claude.ai: ' + link}</Text> : null}
      </Box>
    )
  })
}
