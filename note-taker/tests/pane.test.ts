import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://claude.ai/artifact/EXAMPLE123'
const NEW_URL = 'https://claude.ai/artifact/EXAMPLE456'
const NOW = new Date(2026, 0, 15, 14, 0).getTime()

type Doc = { text: string; createdAt: number; updatedAt: number }

type Fake = {
  clock: ReturnType<typeof mock.clock>
  docs: Map<string, { data: Doc; version: number }>
  store: Map<string, unknown>
  /** every call that reached a tool: the tool and its action and doc_id */
  calls: string[]
  /** the inputs of Artifact publishes */
  published: any[]
}

type Options = {
  /** the link remembered from an earlier session */
  saved?: string
  /** the rows of the person's artifact list */
  artifacts?: string[]
  docs?: Record<string, Doc>
  /** pages that were deleted */
  gone?: string[]
}

// A fake claude.ai behind the Artifact and ArtifactData tools, answering in the tools' own text formats
function fakeClaude(on: any, opts: Options = {}): Fake {
  const clock = mock.clock(on, { now: NOW })
  const docs = new Map(Object.entries(opts.docs ?? {}).map(([id, data]) => [id, { data, version: 1 }]))
  const store = new Map<string, unknown>(opts.saved ? [['notebookUrl', opts.saved]] : [])
  const calls: string[] = []
  const published: any[] = []
  on('tool.list', () => ({ value: ['Artifact', 'ArtifactData', 'Read'].map(name => ({ name, description: '', mcp: false })) }))
  on('tool.call', async (_$: unknown, e: any) => {
    calls.push([e.tool, e.action, e.doc_id].filter(Boolean).join(' '))
    if (e.tool === 'Read') return { result: {}, text: 'read' }
    if (e.tool === 'Artifact' && e.action === 'list') {
      const rows = opts.artifacts ?? []
      return { result: {}, text: [`${rows.length} published artifacts (most recently opened or updated first):`, ...rows].join('\n') }
    }
    if (e.tool === 'Artifact' && e.action === 'publish') {
      published.push(e)
      return { result: {}, text: `Published ${e.file_path} at ${NEW_URL} (Version 1, version id 1-a) Icon: "notes".` }
    }
    if (e.tool !== 'ArtifactData') return { result: {}, text: '' }
    if (opts.gone?.includes(e.url)) return { result: {}, isError: true, text: 'artifact not found' }
    const doc = e.doc_id ? docs.get(e.doc_id) : undefined
    if ((e.action === 'set' || e.action === 'delete') && doc && e.if_version !== doc.version)
      return { result: {}, isError: true, text: 'the document changed: it is now at version ' + doc.version }
    if (e.action === 'set') {
      docs.set(e.doc_id, { data: e.data, version: (doc?.version ?? 0) + 1 })
      return { result: {}, text: 'Database set committed.' }
    }
    if (e.action === 'delete') {
      docs.delete(e.doc_id)
      return { result: {}, text: 'Database delete committed.' }
    }
    const rows = [...docs].map(([id, d]) => JSON.stringify({ id, data: d.data, version: d.version }))
    const text = [`${rows.length} documents:`, '=== BEGIN ARTIFACT DB 0a1b ===', ...rows, '=== END ARTIFACT DB 0a1b ==='].join('\n')
    return { result: {}, text }
  })
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', async (_$: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async (_$: unknown, e: { name: string }) => ({ value: { tool: 'mcp__note-taker__' + e.name } }) as never)
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  return { clock, docs, store, calls, published }
}

const PANE = {
  title: 'Note Taker',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

async function openPane($: any, fake: Fake, surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'note-taker' } as never)
  await fake.clock.settle()
  return $.ui.mount({ plugin: 'note-taker', surface, component: 'Pane', requestId: 'note-taker', props: PANE as never })
}

async function start($: any, fake: Fake, surface: 'terminal' | 'desktop') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  return openPane($, fake, surface)
}

const SHOPPING = { text: 'Shopping\nmilk', createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: lists the notes and adds a new one`, async ($, on) => {
    const fake = fakeClaude(on, { saved: URL, docs: { nshop: SHOPPING } })
    const ui = await start($, fake, surface)
    expect((await ui.find({ key: 'note-nshop' }))?.text).toMatch(/Shopping\s+13:00/)
    expect(await ui.find({ text: /1 note/ })).toBeDefined()
    expect(await ui.find({ text: 'Also on claude.ai: ' + URL })).toBeDefined()

    await ui.input({ key: 'new', text: '  Call the dentist\n' })
    const added = [...fake.docs].find(([id]) => id !== 'nshop')!
    expect(added[0]).toMatch(/^n/)
    expect(added[1].data).toEqual({ text: 'Call the dentist', createdAt: NOW, updatedAt: NOW })
    expect(await ui.find({ text: /Call the dentist/ })).toBeDefined()
    expect(await ui.find({ text: /2 notes/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: edits a note, and deletes it after asking`, async ($, on) => {
    const fake = fakeClaude(on, { saved: URL, docs: { nshop: SHOPPING } })
    const ui = await start($, fake, surface)

    await ui.press({ key: 'note-nshop' })
    await ui.input({ key: 'edit', text: 'Shopping\nmilk\neggs' })
    expect(fake.docs.get('nshop')).toEqual({ data: { text: 'Shopping\nmilk\neggs', createdAt: SHOPPING.createdAt, updatedAt: NOW }, version: 2 })
    expect(await ui.find({ text: /Saved\./ })).toBeDefined()

    await ui.press({ key: 'delete' })
    expect(await ui.find({ text: /Delete this note\?/ })).toBeDefined()
    expect(fake.docs.has('nshop')).toBe(true)
    await ui.press({ key: 'delete-yes' })
    expect(fake.docs.has('nshop')).toBe(false)
    expect(await ui.find({ text: /No notes yet/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a note changed elsewhere isn't overwritten`, async ($, on) => {
    const fake = fakeClaude(on, { saved: URL, docs: { nshop: SHOPPING } })
    const ui = await start($, fake, surface)
    await ui.press({ key: 'note-nshop' })

    // Changed on the page after the pane read it
    fake.docs.set('nshop', { data: { ...SHOPPING, text: 'Shopping\nbread' }, version: 2 })
    await ui.input({ key: 'edit', text: 'Shopping\nmilk\neggs' })
    expect(fake.docs.get('nshop')?.data.text).toBe('Shopping\nbread')
    expect(await ui.find({ text: /Not saved: the document changed/ })).toBeDefined()
    expect((await ui.find({ key: 'edit' }))?.props.value).toBe('Shopping\nbread')
    await ui.unmount()
  })
}

test('the first time, publishes a new private page and remembers its link', async ($, on) => {
  const fake = fakeClaude(on, { artifacts: ['- (mine) Other page — https://claude.ai/artifact/EXAMPLE789 — updated 2026-01-10'] })
  const ui = await start($, fake, 'terminal')

  expect(fake.calls).toEqual(['Artifact list', 'Read', 'Artifact publish', 'ArtifactData query'])
  expect(fake.published[0]).toMatchObject({ icon: 'notes', capabilities: { db: {}, user: {} } })
  expect(fake.published[0].file_path).toMatch(/\/page\/note-taker\.html$/)
  expect(fake.store.get('notebookUrl')).toBe(NEW_URL)
  expect(await ui.find({ text: 'Also on claude.ai: ' + NEW_URL })).toBeDefined()

  // Known from now on
  await ui.press({ key: 'refresh' })
  expect(fake.calls.slice(4)).toEqual(['ArtifactData query'])
  await ui.unmount()
})

test('on another computer, finds the Note Taker page the person already has', async ($, on) => {
  const fake = fakeClaude(on, {
    artifacts: [
      '- (shared) Note Taker — https://claude.ai/artifact/EXAMPLE789 — updated 2026-01-12',
      `- (mine) Note Taker — ${URL} — updated 2026-01-10`,
    ],
    docs: { nshop: SHOPPING },
  })
  const ui = await start($, fake, 'terminal')

  expect(fake.calls).toEqual(['Artifact list', 'ArtifactData query'])
  expect(fake.store.get('notebookUrl')).toBe(URL)
  expect(await ui.find({ key: 'note-nshop' })).toBeDefined()
  await ui.unmount()
})

test('a deleted page is set up again on the next try', async ($, on) => {
  const fake = fakeClaude(on, { saved: URL, gone: [URL] })
  const ui = await start($, fake, 'terminal')
  expect(await ui.find({ text: /Could not read your notes: artifact not found/ })).toBeDefined()
  expect(fake.store.has('notebookUrl')).toBe(false)

  await ui.press({ key: 'refresh' })
  expect(fake.store.get('notebookUrl')).toBe(NEW_URL)
  expect(await ui.find({ text: /No notes yet/ })).toBeDefined()
  expect(await ui.find({ text: /Could not read/ })).toBeUndefined()
  await ui.unmount()
})

test("the notebook tool gives Claude the page's link, the time and a new note's id", async ($, on) => {
  fakeClaude(on, { saved: URL })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.tool.call({ tool: 'mcp__note-taker__notebook' } as never)
  const answer = JSON.parse(String(r.result))
  expect(answer).toMatchObject({ url: URL, collection: 'data/users/me', now: NOW })
  expect(answer.newId).toMatch(new RegExp('^n' + NOW.toString(36)))
})

test("the pane reloads after Claude adds a note, and not before it's opened", async ($, on) => {
  const fake = fakeClaude(on, { saved: URL })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const set = (id: string) => ({ tool: 'ArtifactData', action: 'set', url: URL, collection: 'data/users/me', doc_id: id, data: { text: 'From Claude', createdAt: NOW, updatedAt: NOW } })

  await $.tool.call(set('nfirst') as never)
  expect(fake.calls).toEqual(['ArtifactData set nfirst'])

  const ui = await openPane($, fake, 'terminal')
  await $.tool.call(set('nsecond') as never)
  await fake.clock.settle()
  expect(fake.calls).toEqual(['ArtifactData set nfirst', 'ArtifactData query', 'ArtifactData set nsecond', 'ArtifactData query'])
  expect(await ui.find({ key: 'note-nfirst' })).toBeDefined()
  expect(await ui.find({ key: 'note-nsecond' })).toBeDefined()
  await ui.unmount()
})

const C = 'mcp__claude-artifacts__'
const SLUG = '00000000-0000-4000-8000-000000000001'
const USER = 'u_EXAMPLE123'

// A fake claude.ai behind the claude-artifacts connector, for sessions without the Artifact tools,
// answering in the connector's own formats
function fakeConnector(on: any, opts: { saved?: boolean; mine?: boolean; docs?: Record<string, Doc> } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const docs = new Map(Object.entries(opts.docs ?? {}).map(([id, data]) => [id, { data, version: 1 }]))
  const store = new Map<string, unknown>(opts.saved ? [['notebookUrl', URL], ['notebookSlug', SLUG], ['notebookUser', USER]] : [])
  const calls: string[] = []
  const inputs: any[] = []
  const pages = opts.mine ? [{ slug: SLUG, title: 'Note Taker', rel: 'mine', url: URL }] : []
  const tools = ['list_artifacts', 'publish_version', 'read_declaration', 'declare_capabilities', 'db_whoami', 'db_query', 'db_write']
  on('tool.list', () => ({ value: tools.map(n => ({ name: C + n, description: '', mcp: true })) }))
  on('fs.read', () => ({ value: '<title>Note Taker</title>' }))
  on('tool.call', async (_$: unknown, e: any) => {
    const name = e.tool.slice(C.length)
    calls.push(name)
    inputs.push(e)
    const json = (v: unknown) => ({ result: {}, text: JSON.stringify(v) })
    // With a notice before the JSON, as when the list has others' content
    if (name === 'list_artifacts') return { result: {}, text: '<artifact-content-authored-by-others/>\nThis result includes Artifact content written by others.' + JSON.stringify({ artifacts: pages }) }
    if (name === 'publish_version') {
      pages.push({ slug: SLUG, title: e.title, rel: 'mine', url: NEW_URL })
      return json({ slug: SLUG, version: '1-a' })
    }
    if (name === 'read_declaration') return json({ capabilities: {}, slug: e.slug, version: '1-a' })
    if (name === 'declare_capabilities') return json({ slug: e.slug, version: '2-b' })
    if (name === 'db_whoami') return json({ id: USER, role: 'owner' })
    if (name === 'db_query') {
      if (e.collection !== 'data/users/' + USER) return json({ docs: [], nextCursor: '' })
      const rows = [...docs].map(([id, d]) => JSON.stringify({ data: d.data, id, updatedAt: '2026-01-15T00:00:00Z', version: d.version }))
      return { result: {}, text: JSON.stringify({ notice: '…', count: rows.length, nextCursor: '' }) + '<untrusted-document-0a1b>\n' + rows.join('\n') + '\n</untrusted-document-0a1b>IMPORTANT: …' }
    }
    // db_write, one op
    const op = e.ops[0]
    const id = op.path.split('/').pop()
    const doc = docs.get(id)
    if (doc && op.ifVersion !== doc.version) return { result: {}, isError: true, text: 'the document changed: it is now at version ' + doc.version }
    if (op.op === 'delete') docs.delete(id)
    else docs.set(id, { data: op.data, version: (doc?.version ?? 0) + 1 })
    return json({ ok: true })
  })
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', async (_$: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async (_$: unknown, e: { name: string }) => ({ value: { tool: 'mcp__note-taker__' + e.name } }) as never)
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  return { clock, docs, store, calls, inputs, published: [] as any[] }
}

test('without the Artifact tools, sets up the page through the claude.ai connector', async ($, on) => {
  const fake = fakeConnector(on)
  const ui = await start($, fake as any, 'terminal')

  expect(fake.calls).toEqual(['list_artifacts', 'publish_version', 'read_declaration', 'declare_capabilities', 'list_artifacts', 'db_whoami', 'db_query'])
  expect(fake.inputs[1].content).toMatch(/^<!DOCTYPE html>\n<title>Note Taker<\/title>/)
  expect(fake.inputs[3]).toMatchObject({ slug: SLUG, base_version: '1-a', capabilities: { db: {}, user: {} } })
  expect(fake.inputs[6]).toMatchObject({ slug: SLUG, collection: 'data/users/' + USER })
  expect(fake.store.get('notebookSlug')).toBe(SLUG)
  expect(await ui.find({ text: 'Also on claude.ai: ' + NEW_URL })).toBeDefined()
  await ui.unmount()
})

test('without the Artifact tools, finds the page you have, then reads, adds, edits and deletes notes', async ($, on) => {
  const fake = fakeConnector(on, { mine: true, docs: { nshop: SHOPPING } })
  const ui = await start($, fake as any, 'terminal')
  expect(fake.calls).toEqual(['list_artifacts', 'db_whoami', 'db_query'])
  expect((await ui.find({ key: 'note-nshop' }))?.text).toMatch(/Shopping/)

  await ui.input({ key: 'new', text: 'Call the dentist' })
  const added = [...fake.docs].find(([id]) => id !== 'nshop')!
  expect(added[1].data).toEqual({ text: 'Call the dentist', createdAt: NOW, updatedAt: NOW })
  expect(fake.inputs.at(-2).ops[0]).toMatchObject({ op: 'set', path: 'data/users/' + USER + '/' + added[0] })

  await ui.press({ key: 'note-nshop' })
  await ui.input({ key: 'edit', text: 'Shopping\nmilk\neggs' })
  expect(fake.docs.get('nshop')?.data.text).toBe('Shopping\nmilk\neggs')
  await ui.press({ key: 'delete' })
  await ui.press({ key: 'delete-yes' })
  expect(fake.docs.has('nshop')).toBe(false)
  await ui.unmount()
})

test("without the Artifact tools, the notebook tool gives Claude the page's slug and collection", async ($, on) => {
  fakeConnector(on, { saved: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const answer = JSON.parse(String((await $.tool.call({ tool: 'mcp__note-taker__notebook' } as never)).result))
  expect(answer).toMatchObject({ url: URL, slug: SLUG, collection: 'data/users/' + USER, now: NOW })
  expect(answer.tools).toMatch(/connector/)
})

test("the pane reloads after Claude writes through the connector", async ($, on) => {
  const fake = fakeConnector(on, { saved: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await openPane($, fake as any, 'terminal')

  const data = { text: 'From Claude', createdAt: NOW, updatedAt: NOW }
  await $.tool.call({ tool: C + 'db_write', slug: SLUG, ops: [{ op: 'set', path: 'data/users/' + USER + '/nclaude', data }] } as never)
  await fake.clock.settle()
  expect(fake.calls).toEqual(['db_query', 'db_write', 'db_query'])
  expect(await ui.find({ key: 'note-nclaude' })).toBeDefined()
  await ui.unmount()
})
