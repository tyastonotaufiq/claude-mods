import { expect, mock, test } from 'claude-code/testing'

// A fake phone: what each adb call answers, and a record of the calls made.
const LISTINGS: Record<string, string> = {
  '/sdcard': [
    'directory/3488/1700000000/DCIM',
    'directory/3488/1700000000/Download',
    'regular file/5000000/1700000000/video.mp4',
  ].join('\n'),
  '/sdcard/DCIM': 'regular file/2048/1700000000/a.jpg',
  '/': 'directory/4096/1700000000/system',
}

// `files` are the paths that exist on the fake Mac (adb binaries, files to
// push); with no adb among them, adb is on PATH. Long copies go through
// process.spawn and are recorded in `calls` too.
function fakeAdb(on: any, calls: string[][], files: string[] = []) {
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }) {
    calls.push([...e.argv])
    yield { stream: 'stdout' as const, text: '1 file pushed.\n' }
    return { value: { code: 0, signal: null } }
  })
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: files.includes(e.path) }))
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    const argv = [...e.argv]
    calls.push(argv)
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[1] === 'version') return ok('Android Debug Bridge version 1.0.41')
    if (argv[1] === 'devices') {
      return ok('List of devices attached\nABC123 device usb:1 product:x model:Pixel_7 device:y\n')
    }
    if (argv[3] === 'shell') {
      const cmd = argv[4] ?? ''
      const dir = /^cd '([^']*)'/.exec(cmd)?.[1] ?? ''
      if (cmd.includes('stat -L')) return ok(LISTINGS[dir] ?? '')
      if (cmd.includes('getprop')) {
        return ok('name=\nrelease=15\nsdk=35\ndf=/dev/fuse 10474476 6710460 3145728 68% /storage/emulated\n  status: 2\n  level: 80\n')
      }
      return ok('')
    }
    return ok('')
  })
}

const PANE = {
  title: 'ADB Explorer',
  isFocused: true,
  bodyColumns: 70,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: lists the phone, opens a folder, and trashes a marked file`, async ($, on) => {
    const calls: string[][] = []
    fakeAdb(on, calls)
    mock.store(on)
    mock.env(on, { HOME: '/Users/test' })
    mock.clock(on, { now: Date.UTC(2026, 9, 15, 7, 55, 2) })
    // Answer the delete question with the safe choice
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => ({
      result: { questions: e.questions, answers: { [e.questions[0].question]: 'Move to device trash' } },
    }) as never)

    const ui = await $.ui.mount({
      plugin: 'adb-explorer',
      surface,
      component: 'Pane',
      requestId: 'adb-explorer',
      props: PANE as never,
    })

    // No device loaded yet: the help view with a Retry button
    expect(await ui.find({ text: /No Android device ready/ })).toBeDefined()
    await ui.press({ key: 'retry' })

    // The device, its info line and the /sdcard listing show
    expect(await ui.find({ text: /Pixel 7/ })).toBeDefined()
    expect(await ui.find({ text: /Android 15 \(API 35\) · 3\.0 GB free of 10\.0 GB · Battery 80%, charging/ })).toBeDefined()
    expect(await ui.find({ key: 'open-0' })).toBeDefined()
    expect((await ui.find({ key: 'open-2' }))?.text).toMatch(/video\.mp4/)

    // Open DCIM
    await ui.press({ key: 'open-0' })
    expect((await ui.find({ key: 'open-0' }))?.text).toMatch(/a\.jpg/)

    // Mark a.jpg and delete it: it is moved to the device trash, not removed
    await ui.press({ key: 'mark-0' })
    expect((await ui.find({ key: 'delete' }))?.text).toMatch(/Delete \(1\)/)
    await ui.press({ key: 'delete' })
    const shellCmds = calls.filter(c => c[3] === 'shell').map(c => c[4] ?? '')
    expect(shellCmds.some(c => c.includes('_adb_trash') && c.includes("'/sdcard/DCIM/a.jpg'"))).toBe(true)
    expect(shellCmds.some(c => c.startsWith('rm '))).toBe(false)
    // Every adb call that touches the device names it
    expect(calls.filter(c => c[3] === 'shell').every(c => c[1] === '-s' && c[2] === 'ABC123')).toBe(true)

    await ui.unmount()
  })

  test(`${surface}: refuses to delete outside /sdcard without asking`, async ($, on) => {
    const calls: string[][] = []
    fakeAdb(on, calls)
    mock.store(on)
    mock.env(on, { HOME: '/Users/test' })
    let asked = false
    on('tool.call', { tool: 'AskUserQuestion' }, async () => {
      asked = true
      return { deny: 'should not be asked' } as never
    })

    const ui = await $.ui.mount({
      plugin: 'adb-explorer',
      surface,
      component: 'Pane',
      requestId: 'adb-explorer',
      props: PANE as never,
    })
    await ui.press({ key: 'retry' })
    await ui.press({ key: 'up' }) // /sdcard -> /
    expect((await ui.find({ key: 'open-0' }))?.text).toMatch(/system/)
    await ui.press({ key: 'mark-0' })
    await ui.press({ key: 'delete' })

    expect(asked).toBe(false)
    expect(await ui.find({ text: /Only files inside \/sdcard/ })).toBeDefined()
    expect(calls.some(c => (c[4] ?? '').includes('rm ') || (c[4] ?? '').includes('mv '))).toBe(false)
    await ui.unmount()
  })
}

test('uses the Android SDK adb from ANDROID_HOME, not the one on PATH', async ($, on) => {
  const SDK_ADB = '/opt/android-sdk/platform-tools/adb'
  const calls: string[][] = []
  fakeAdb(on, calls, [SDK_ADB])
  mock.store(on)
  mock.env(on, { HOME: '/Users/test', ANDROID_HOME: '/opt/android-sdk' })

  const ui = await $.ui.mount({
    plugin: 'adb-explorer',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'adb-explorer',
    props: PANE as never,
  })
  await ui.press({ key: 'retry' })
  expect(await ui.find({ text: /Pixel 7/ })).toBeDefined()
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(c => c[0] === SDK_ADB)).toBe(true)
  await ui.unmount()
})

test('pushes files and folders dropped onto the push field', async ($, on) => {
  const calls: string[][] = []
  fakeAdb(on, calls, ['/Users/test/My Photos', '/Users/test/Desktop/a.jpg'])
  mock.store(on)
  mock.env(on, { HOME: '/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'adb-explorer',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'adb-explorer',
    props: PANE as never,
  })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'push' })
  // What a terminal pastes when a folder and a file are dragged in from Finder
  await ui.input({ key: 'push-path', text: '/Users/test/My\\ Photos ~/Desktop/a.jpg ' })

  const pushes = calls.filter(c => c[3] === 'push')
  expect(pushes).toEqual([
    ['adb', '-s', 'ABC123', 'push', '/Users/test/My Photos', '/sdcard/'],
    ['adb', '-s', 'ABC123', 'push', '/Users/test/Desktop/a.jpg', '/sdcard/'],
  ])
  expect(await ui.find({ text: /Pushed 2 items to \/sdcard/ })).toBeDefined()
  expect(await ui.find({ key: 'push-path' })).toBeUndefined()
  await ui.unmount()
})

test('a typed path with spaces pushes as one, and a missing path pushes nothing', async ($, on) => {
  const calls: string[][] = []
  fakeAdb(on, calls, ['/Users/test/My Photos'])
  mock.store(on)
  mock.env(on, { HOME: '/Users/test' })

  const ui = await $.ui.mount({
    plugin: 'adb-explorer',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'adb-explorer',
    props: PANE as never,
  })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'push' })
  await ui.input({ key: 'push-path', text: '~/My Photos' })
  expect(calls.filter(c => c[3] === 'push').map(c => c[4])).toEqual(['/Users/test/My Photos'])

  await ui.press({ key: 'push' })
  await ui.input({ key: 'push-path', text: '/Users/test/nope.jpg /Users/test/My\\ Photos' })
  expect(await ui.find({ text: /Not found on this computer: \/Users\/test\/nope\.jpg/ })).toBeDefined()
  expect(calls.filter(c => c[3] === 'push')).toHaveLength(1)
  await ui.unmount()
})
