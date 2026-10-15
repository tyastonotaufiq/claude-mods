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

// `files` are the adb binaries that exist on the fake Mac; with none, adb is on PATH.
function fakeAdb(on: any, calls: string[][], files: string[] = []) {
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

    // The device and /sdcard listing show
    expect(await ui.find({ text: /Pixel 7/ })).toBeDefined()
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
