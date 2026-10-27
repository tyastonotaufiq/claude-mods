import { expect, mock, test } from 'claude-code/testing'

// 14:00 local time on a fixed day
const NOW = new Date(2026, 0, 15, 14, 0).getTime()

// `lsappinfo list`: one app with a Dock icon, one menu bar agent
const LSAPPINFO = [
  ' 1) "Studio" ASN:0x0-0x101: \n    bundle path="/Applications/Example Studio.app"\n    pid = 612 type="Foreground"\n',
  ' 2) "ExampleAgent" ASN:0x0-0x202: \n    bundle path="/Applications/ExampleAgent.app"\n    pid = 101 type="UIElement"\n',
].join('')

type Fake = {
  clock: ReturnType<typeof mock.clock>
  /** caffeinate's arguments, one list per child started */
  started: string[][]
  /** pids killed */
  killed: string[]
  /** panes opened */
  opened: unknown[]
  /** what the mod keeps across sessions */
  store: Map<string, unknown>
  /** the status line as last pinned */
  status: () => string | undefined
  /** ends a running child by itself, as when its time is up or its app quits */
  exit: (pid: string) => void
}

// A fake Mac: each caffeinate prints its pid (from 100 up) and runs until killed or exited.
function fakeMac(on: any, opts: { mac?: boolean } = {}): Fake {
  const clock = mock.clock(on, { now: NOW })
  const started: string[][] = []
  const killed: string[] = []
  const running = new Map<string, () => void>()
  const opened: unknown[] = []
  const store = new Map<string, unknown>()
  let status: string | undefined
  const ok = (stdout = '') => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.exists', async (_$: unknown, e: { path: string }) => ({
    value: opts.mac !== false && e.path === '/System/Library/CoreServices/SystemVersion.plist',
  }))
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }) {
    // sh -c '<script>' sh <caffeinate args…>
    started.push(e.argv.slice(4))
    const pid = String(100 + started.length - 1)
    yield { stream: 'stdout', text: pid + '\n' }
    // Held on the test's clock too, so settle() doesn't wait for a child that runs on
    await Promise.race([new Promise<void>(resolve => running.set(pid, resolve)), clock.sleep(365 * 86_400_000)])
    return { value: { code: 0, signal: null } }
  })
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    if (e.argv[0] === 'kill') {
      const pid = e.argv[1]!
      killed.push(pid)
      running.get(pid)?.()
    }
    return e.argv[0] === '/usr/bin/lsappinfo' ? ok(LSAPPINFO) : ok()
  })
  on('ui.status', async (_$: unknown, e: { text: string | undefined }) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.open', async (_$: unknown, e: unknown) => (opened.push(e), { value: { isPlaced: true } }))
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  return { clock, started, killed, opened, store, status: () => status, exit: pid => running.get(pid)?.() }
}

const PANE = {
  title: 'Keep Awake',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

async function start($: any, surface: 'terminal' | 'desktop') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  return $.ui.mount({ plugin: 'keep-awake', surface, component: 'Pane', requestId: 'keep-awake', props: PANE as never })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a timed session keeps the display awake too, until Stop kills it`, async ($, on) => {
    const fake = fakeMac(on)
    const clock = fake.clock
    const ui = await start($, surface)
    expect(await ui.find({ text: /Off: your Mac sleeps as usual/ })).toBeDefined()

    await ui.press({ key: 'for-60' })
    await clock.settle()
    expect(fake.started).toEqual([['-i', '-d', '-t', '3600']])
    expect(await ui.find({ text: /Awake until 15:00/ })).toBeDefined()
    expect(fake.status()).toBe('Awake until 15:00')
    // The running choice is drawn bold, the others as usual
    expect((await ui.find({ type: 'Text', text: /^1 hour$/ }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^2 hours$/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Text', text: /● on/ })).toHaveLength(1)

    await ui.press({ key: 'stop' })
    await clock.settle()
    expect(fake.killed).toEqual(['100'])
    expect(await ui.find({ type: 'Text', text: /^1 hour$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /● on/ })).toBeUndefined()
    expect(await ui.find({ text: /Stopped: your Mac can sleep again/ })).toBeDefined()
    expect(fake.status()).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: letting the display sleep goes on with the running session, and is kept`, async ($, on) => {
    const fake = fakeMac(on)
    const clock = fake.clock
    const ui = await start($, surface)

    await ui.press({ key: 'indefinitely' })
    await clock.settle()
    await ui.press({ key: 'display' })
    await clock.settle()
    expect(fake.started).toEqual([['-i', '-d'], ['-i']])
    expect(fake.killed).toEqual(['100'])
    expect(await ui.find({ text: /\[x\] Let the display sleep/ })).toBeDefined()
    expect(await ui.find({ text: /Awake until you stop it/ })).toBeDefined()
    expect(fake.store.get('displaySleep')).toBe(true)
    await ui.unmount()
  })

  test(`${surface}: until a typed time, and a word that isn't one`, async ($, on) => {
    const fake = fakeMac(on)
    const clock = fake.clock
    const ui = await start($, surface)

    await ui.input({ key: 'until', text: 'soon' })
    await clock.settle()
    expect(await ui.find({ text: /"soon" isn't a time/ })).toBeDefined()
    expect(fake.started).toEqual([])

    await ui.input({ key: 'until', text: '6:30 pm' })
    await clock.settle()
    expect(fake.started).toEqual([['-i', '-d', '-t', String(4.5 * 3600)]])
    expect(await ui.find({ text: /Awake until 18:30/ })).toBeDefined()
    // The field keeps the time it runs until; no preset is drawn running
    expect((await ui.find({ key: 'until' }))?.props.value).toBe('18:30')
    expect(await ui.find({ type: 'Text', text: /^Until I stop it$/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Text', text: /● on/ })).toHaveLength(1)
    await ui.unmount()
  })

  test(`${surface}: while an app runs, until it quits`, async ($, on) => {
    const fake = fakeMac(on)
    const clock = fake.clock
    const ui = await start($, surface)

    await ui.press({ key: 'while-app' })
    await clock.settle()
    expect((await ui.find({ key: 'app-0' }))?.text).toMatch(/Example Studio/)
    expect(await ui.find({ text: /ExampleAgent/ })).toBeUndefined()

    await ui.press({ key: 'app-0' })
    await clock.settle()
    expect(fake.started).toEqual([['-i', '-d', '-w', '612']])
    expect(await ui.find({ text: /Awake while Example Studio runs/ })).toBeDefined()
    expect((await ui.find({ key: 'while-app' }))?.text).toMatch(/Choose an app… \(Example Studio\)/)

    fake.exit('100')
    await clock.settle()
    expect(await ui.find({ text: /Example Studio quit: your Mac can sleep again/ })).toBeDefined()
    expect(fake.status()).toBeUndefined()
    expect(fake.killed).toEqual([])
    await ui.unmount()
  })
}

test('on Windows or Linux, says it needs macOS and opens no pane', async ($, on) => {
  const fake = fakeMac(on, { mac: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'keep-awake' } as never)
  expect(r).toMatchObject({ text: 'Keep Awake needs macOS.' })
  expect(fake.opened).toHaveLength(0)
  expect(fake.started).toEqual([])
})
