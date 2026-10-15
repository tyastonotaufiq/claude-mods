import { expect, mock, test } from 'claude-code/testing'

const H = '/Users/t'
const MB = 1024 * 1024

// A fake Mac: which paths exist, what folders hold, and how big things are.
// With `smallCaches`, three more 4 MB caches: too small alone, 12 MB together.
const SMALL = ['s1', 's2', 's3'].map(n => H + '/Library/Caches/' + n)

function fakeMac(
  on: any,
  calls: string[][],
  opts: {
    findings?: string
    trashFails?: boolean
    smallCaches?: boolean
    // Held before du answers for this path, to look at the pane mid-scan
    slow?: { path: string; until: () => Promise<void> }
  } = {},
) {
  const exists = new Set([
    H + '/Library/Caches',
    H + '/Library/Caches/com.spotify.client',
    H + '/Library/Caches/tiny.app',
    H + '/Library/Logs',
    H + '/.gradle/caches',
    H + '/Downloads/old.iso',
    ...(opts.smallCaches ? SMALL : []),
  ])
  if (opts.findings) exists.add(H + '/.claude/mac-cleaner/findings.json')
  const kb: Record<string, number> = {
    [H + '/Library/Caches/com.spotify.client']: 1500 * 1024,
    [H + '/Library/Caches/tiny.app']: 100,
    [H + '/Library/Logs']: 40 * 1024,
    [H + '/.gradle/caches']: 3000 * 1024,
    ...Object.fromEntries(SMALL.map(p => [p, 4 * 1024])),
  }
  const caches = ['com.spotify.client', 'tiny.app', ...(opts.smallCaches ? ['s1', 's2', 's3'] : [])]
  const ok = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: exists.has(e.path) }))
  on('fs.list', async (_$: unknown, e: { path: string }) => ({
    value:
      e.path === H + '/Library/Caches'
        ? caches.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
        : [],
  }))
  on('fs.read', async () => ({ value: opts.findings ?? '' }))
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[0] === 'du' && opts.slow && argv.includes(opts.slow.path)) await opts.slow.until()
    if (argv[0] === 'du') return ok(argv.slice(2).map(p => `${kb[p] ?? 0}\t${p}`).join('\n'))
    if (argv[0] === 'df') return ok(`Filesystem 1024-blocks Used Available\n/dev/disk3s5 500000000 400000000 100000000 80% /`)
    if (argv[0] === '/usr/bin/trash' || argv[0] === 'osascript') {
      const targets =
        argv[0] === 'osascript'
          ? [...(argv[2] ?? '').matchAll(/POSIX file "((?:[^"\\]|\\.)*)"/g)].map(m => (m[1] ?? '').replace(/\\(.)/g, '$1'))
          : argv.slice(1)
      if (!opts.trashFails) for (const p of targets) exists.delete(p)
      return ok('', opts.trashFails ? 1 : 0)
    }
    return ok('')
  })
}

const PANE = {
  title: 'Mac Cleaner',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

async function mount($: any, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'mac-cleaner', surface, component: 'Pane', requestId: 'mac-cleaner', props: PANE as never })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: scans, lists by size, and trashes what's marked after asking`, async ($, on) => {
    const calls: string[][] = []
    fakeMac(on, calls)
    mock.store(on)
    mock.env(on, { HOME: H })
    mock.clock(on, { now: 1_760_000_000_000 })
    let question = ''
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => {
      question = e.questions[0].question
      return { result: { questions: e.questions, answers: { [question]: 'Move to Trash' } } } as never
    })

    const ui = await mount($, surface)
    await ui.press({ key: 'scan' })

    // Biggest first; the 100 KB cache is below the threshold and hidden
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/~\/\.gradle\/caches/)
    expect((await ui.find({ key: 'name-1' }))?.text).toMatch(/com\.spotify\.client/)
    expect((await ui.find({ key: 'name-2' }))?.text).toMatch(/~\/Library\/Logs/)
    expect(await ui.find({ key: 'name-3' })).toBeUndefined()
    expect(await ui.find({ text: /95\.4 GB free of 477 GB/ })).toBeDefined()

    // Mark the gradle cache and trash it
    await ui.press({ key: 'mark-0' })
    expect((await ui.find({ key: 'trash' }))?.text).toMatch(/\(1, 2\.9 GB\)/)
    await ui.press({ key: 'trash' })
    expect(question).toMatch(/Move 1 item\(s\), 2\.9 GB, to the Trash\?/)

    const trashCall = calls.find(c => c[0] === 'osascript' || c[0] === '/usr/bin/trash')
    expect(trashCall?.join(' ')).toContain(H + '/.gradle/caches')
    expect(calls.some(c => c[0] === 'rm')).toBe(false)
    expect(await ui.find({ text: /Moved 1 item\(s\), 2\.9 GB, to the Trash/ })).toBeDefined()
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/com\.spotify\.client/)
    await ui.unmount()
  })

  test(`${surface}: cancelling the question trashes nothing`, async ($, on) => {
    const calls: string[][] = []
    fakeMac(on, calls)
    mock.store(on)
    mock.env(on, { HOME: H })
    mock.clock(on, { now: 1 })
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => ({
      result: { questions: e.questions, answers: { [e.questions[0].question]: 'Cancel' } },
    }) as never)

    const ui = await mount($, surface)
    await ui.press({ key: 'scan' })
    await ui.press({ key: 'mark-safe' })
    await ui.press({ key: 'trash' })
    expect(calls.some(c => c[0] === 'osascript' || c[0] === '/usr/bin/trash')).toBe(false)
    await ui.unmount()
  })

  test(`${surface}: shows Claude's findings, and drops protected ones`, async ($, on) => {
    const calls: string[][] = []
    fakeMac(on, calls, {
      findings: JSON.stringify({
        items: [
          { path: '~/Downloads/old.iso', sizeBytes: 4000 * MB, category: 'Downloads', risk: 'review', reason: 'Installer from 2023' },
          { path: '~/Library/Mobile Documents/com~apple~CloudDocs/thesis', sizeBytes: 9000 * MB, risk: 'safe' },
        ],
      }),
    })
    mock.store(on)
    mock.env(on, { HOME: H })
    mock.clock(on, { now: 1 })

    const ui = await mount($, surface)
    await ui.press({ key: 'scan' })
    expect(await ui.find({ text: /Review first/ })).toBeDefined()
    expect(await ui.find({ text: /old\.iso/ })).toBeDefined()
    expect(await ui.find({ text: /Installer from 2023/ })).toBeDefined()
    expect(await ui.find({ text: /thesis/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a failed move keeps the item and says so`, async ($, on) => {
    const calls: string[][] = []
    fakeMac(on, calls, { trashFails: true })
    mock.store(on)
    mock.env(on, { HOME: H })
    mock.clock(on, { now: 1 })
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => ({
      result: { questions: e.questions, answers: { [e.questions[0].question]: 'Move to Trash' } },
    }) as never)

    const ui = await mount($, surface)
    await ui.press({ key: 'scan' })
    await ui.press({ key: 'mark-0' })
    await ui.press({ key: 'trash' })
    expect(await ui.find({ text: /could not be moved \(still marked\)/ })).toBeDefined()
    expect((await ui.find({ key: 'mark-0' }))?.text).toBe('[x]')
    await ui.unmount()
  })

  test(`${surface}: opens empty and scans fresh, ignoring a scan saved by an older version`, async ($, on) => {
    const calls: string[][] = []
    fakeMac(on, calls)
    // What an older version left in the plugin's store
    const store = new Map<string, unknown>([
      [
        'lastScan',
        {
          at: 0,
          items: [{ path: H + '/Library/Caches/gone', size: 900 * MB, category: 'App caches', risk: 'safe', reason: '', source: 'scan' }],
        },
      ],
    ])
    on('store.get', async (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
    on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
    on('store.delete', async (_$: unknown, e: { key: string }) => (store.delete(e.key), { value: undefined }))
    mock.env(on, { HOME: H })
    mock.clock(on, { now: 1 })
    on('tool.register', async () => ({ value: undefined }) as never)
    on('command.register', async () => ({ value: undefined }) as never)
    on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)

    await $.session.start({ cwd: H, surface, isInteractive: true })
    expect(store.has('lastScan')).toBe(false)
    const ui = await mount($, surface)
    expect(await ui.find({ text: /gone/ })).toBeUndefined()
    expect(await ui.find({ text: /No results yet/ })).toBeDefined()

    await ui.press({ key: 'scan' })
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/~\/\.gradle\/caches/)
    expect(await ui.find({ text: /gone/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: shows rows and progress while a big folder is still being measured`, async ($, on) => {
    const calls: string[][] = []
    const clock = mock.clock(on, { now: 1 })
    fakeMac(on, calls, { slow: { path: H + '/.gradle/caches', until: () => clock.sleep(30_000) } })
    mock.store(on)
    mock.env(on, { HOME: H })
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => ({
      result: { questions: e.questions, answers: { [e.questions[0].question]: 'Move to Trash' } },
    }) as never)

    const ui = await mount($, surface)
    void ui.press({ key: 'scan' })
    await clock.settle()

    // Everything but the gradle cache is measured and listed; the line names what's left
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/com\.spotify\.client/)
    expect((await ui.find({ key: 'name-1' }))?.text).toMatch(/~\/Library\/Logs/)
    expect(await ui.find({ text: /\.gradle\/caches\s+\d/ })).toBeUndefined()
    expect(await ui.find({ text: /Scanning 3 of 4 · found 1\.5 GB so far · ~\/\.gradle\/caches…/ })).toBeDefined()

    // Rows can be marked meanwhile, but t waits for the scan
    await ui.press({ key: 'mark-0' })
    await ui.press({ key: 'trash' })
    expect(await ui.find({ text: /Wait for the scan to finish/ })).toBeDefined()
    expect(calls.some(c => c[0] === 'osascript' || c[0] === '/usr/bin/trash')).toBe(false)

    // Once it's measured, the full list is there and the mark is kept
    await clock.advance(30_000)
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/~\/\.gradle\/caches/)
    expect(await ui.find({ text: /Found 4\.4 GB in 3 places/ })).toBeDefined()
    expect((await ui.find({ key: 'mark-1' }))?.text).toBe('[x]')
    await ui.unmount()
  })

  test(`${surface}: small caches that add up get one row, and trashing it moves each one`, async ($, on) => {
    const calls: string[][] = []
    fakeMac(on, calls, { smallCaches: true })
    mock.store(on)
    mock.env(on, { HOME: H })
    mock.clock(on, { now: 1 })
    let question = ''
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => {
      question = e.questions[0].question
      return { result: { questions: e.questions, answers: { [question]: 'Move to Trash' } } } as never
    })

    const ui = await mount($, surface)
    await ui.press({ key: 'scan' })
    // gradle, spotify, logs, then 3 × 4 MB plus the 100 KB cache in one row
    expect((await ui.find({ key: 'name-3' }))?.text).toMatch(/4 items under 10 MB in ~\/Library\/Caches/)
    expect(await ui.find({ key: 'name-4' })).toBeUndefined()

    await ui.press({ key: 'mark-3' })
    await ui.press({ key: 'trash' })
    expect(question).toMatch(/Move 4 item\(s\), 12 MB, to the Trash\?/)
    const trashCall = calls.find(c => c[0] === 'osascript' || c[0] === '/usr/bin/trash')?.join(' ') ?? ''
    for (const p of [...SMALL, H + '/Library/Caches/tiny.app']) expect(trashCall).toContain(p)
    expect(trashCall).not.toContain(H + '/Library/Caches"')
    expect(trashCall.split(' ').includes(H + '/Library/Caches')).toBe(false)
    expect(await ui.find({ text: /Moved 4 item\(s\), 12 MB, to the Trash/ })).toBeDefined()
    expect(await ui.find({ key: 'name-3' })).toBeUndefined()
    await ui.unmount()
  })
}
