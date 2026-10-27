import { expect, mock, test } from 'claude-code/testing'

const H = '/Users/t'

// What each command prints on the fake Mac: a busy one with 16 GB under pressure, on battery
const OUT: Record<string, string> = {
  'sysctl -n hw.memsize': String(16 * 1024 ** 3),
  'top -l 2 -n 0 -s 1': [
    'Load Avg: 1.00, 1.00, 1.00 ',
    'CPU usage: 5.00% user, 5.00% sys, 90.00% idle ',
    'Load Avg: 5.60, 4.18, 4.02 ',
    'CPU usage: 28.87% user, 19.77% sys, 51.34% idle ',
  ].join('\n'),
  vm_stat: [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages wired down:                             131072.',
    'Pages purgeable:                                   0.',
    'Anonymous pages:                              524288.',
    'Pages occupied by compressor:                 262144.',
  ].join('\n'),
  'sysctl -n kern.memorystatus_vm_pressure_level': '2\n',
  'sysctl -n vm.swapusage': 'total = 8192.00M  used = 7168.00M  free = 1024.00M  (encrypted)',
  ['df -k ' + H]: [
    'Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on',
    '/dev/disk3s5   500000000 400000000  55000000    89% 8535006 564421520    1%   /System/Volumes/Data',
  ].join('\n'),
  'pmset -g batt': "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t23%; discharging; 1:19 remaining present: true",
  'pmset -g therm': 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded',
  'ps -Aceo pid=,pcpu=,rss=,comm=': ['  612  69.4  14640 ExampleRunner', ' 1697  10.0 901440 example-emulator'].join('\n'),
  'system_profiler SPPowerDataType': '          Cycle Count: 1008\n          Condition: Normal\n          Maximum Capacity: 81%',
  'ioreg -r -d 1 -c IOAccelerator': '"PerformanceStatistics" = {"In use system memory"=536870912,"Device Utilization %"=46}',
  'route -n get default': '   route to: default\n  interface: en0\n',
  'networksetup -listallhardwareports': 'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 02:00:00:00:00:01\n',
}

// en0 receives 5 MB and sends 512 KB between two samples
function netstat(n: number): string {
  const received = 1_000_000_000 + n * 5 * 1024 ** 2
  const sent = 500_000_000 + n * 512 * 1024
  return [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    `en0        1500  <Link#11>   02:00:00:00:00:01  2852318     0 ${received}  1154606     0  ${sent}     0`,
  ].join('\n')
}

function fakeMac(on: any, opts: { mac?: boolean } = {}) {
  const calls: string[] = []
  const opened: unknown[] = []
  let netstats = 0
  const store = new Map<string, unknown>()
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({
    value: opts.mac !== false && e.path === '/System/Library/CoreServices/SystemVersion.plist',
  }))
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    const cmd = e.argv.join(' ')
    calls.push(cmd)
    const stdout = cmd === 'netstat -ibn -I en0' ? netstat(netstats++) : (OUT[cmd] ?? '')
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', async (_$: unknown, e: unknown) => (opened.push(e), { value: { isPlaced: true } }))
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => (store.set(e.key, e.value), { value: undefined }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  mock.env(on, { HOME: H })
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  // What another mod draws in the band, beneath this one
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>another mod's line</Text>
  })
  return { calls, opened, store, clock, count: (cmd: string) => calls.filter(c => c === cmd).length }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE = { title: 'Mac Monitor', isFocused: true, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

async function start($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.session.start({ cwd: H, surface, isInteractive: true })
}

const band = ($: any, surface: 'terminal' | 'desktop', props: object = {}) =>
  $.ui.mount({ plugin: 'mac-monitor', surface, component: 'AbovePrompt', props: { ...BAND, ...props } as never })
const pane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'mac-monitor', surface, component: 'Pane', requestId: 'mac-monitor', props: PANE as never })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the line above the prompt, under another mod's, with what needs a look in color`, async ($, on) => {
    const fake = fakeMac(on)
    await start($, surface)
    await fake.clock.settle()
    const ui = await band($, surface)

    expect(await ui.find({ text: /another mod's line/ })).toBeDefined()
    expect(await ui.find({ text: /^CPU 49%$/ })).toBeDefined()
    // (524288 + 131072 + 262144) pages of 16 KB of 16 GB: 88%
    expect(await ui.find({ text: /^MEM 88%$/ })).toBeDefined()
    expect(await ui.find({ text: /^pressure warn$/ })).toBeDefined()
    expect(await ui.find({ text: /^DISK 89%$/ })).toBeDefined()
    expect(await ui.find({ text: /^BAT 23% 1:19 left$/ })).toBeDefined()
    expect(await ui.find({ text: /hot:/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^89%$/ }))?.props.color).toBe('yellow')
    // The pane's extras aren't measured for the line alone
    expect(fake.count('ps -Aceo pid=,pcpu=,rss=,comm=')).toBe(0)
    expect(fake.count('system_profiler SPPowerDataType')).toBe(0)
    expect(fake.count('ioreg -r -d 1 -c IOAccelerator')).toBe(0)
    expect(fake.count('netstat -ibn -I en0')).toBe(0)
    await ui.unmount()
  })

  test(`${surface}: the pane, with the busiest processes and battery health`, async ($, on) => {
    const fake = fakeMac(on)
    await start($, surface)
    await $.command.run({ command: 'mac-monitor' } as never)
    await fake.clock.settle()
    const ui = await pane($, surface)

    expect(await ui.find({ text: /▓▓▓▓▓░░░░░  49%/ })).toBeDefined()
    expect(await ui.find({ text: /user 29% · system 20% · load 5\.60/ })).toBeDefined()
    expect(await ui.find({ text: /14\.0 GB of 16\.0 GB · pressure warn/ })).toBeDefined()
    expect(await ui.find({ text: /7\.0 GB of 8\.0 GB used/ })).toBeDefined()
    expect(await ui.find({ text: /52\.5 GB free of 477 GB/ })).toBeDefined()
    expect(await ui.find({ text: /^on battery, 1:19 left$/ })).toBeDefined()
    expect(await ui.find({ text: /^81% \(Normal\) · 1008 cycles$/ })).toBeDefined()
    // Labels keep their width, so a long row can't wrap them
    expect((await ui.find({ type: 'Text', text: /^Battery$/ }))?.text).toBe('Battery')
    expect(await ui.find({ text: /^normal$/ })).toBeDefined()
    expect((await ui.find({ key: 'cpu-0' }))?.text).toMatch(/69%\s*ExampleRunner/)
    expect((await ui.find({ key: 'mem-0' }))?.text).toMatch(/880 MB\s*example-emulator/)
    expect(await ui.find({ text: /^512 MB in use$/ })).toBeDefined()
    // A speed needs two samples
    expect(await ui.find({ text: /^measuring… \(Wi-Fi, en0\)$/ })).toBeDefined()
    await fake.clock.advance(5_000)
    expect(await ui.find({ text: /^↓ 1\.0 MB\/s  ↑ 102 KB\/s \(Wi-Fi, en0\)$/ })).toBeDefined()

    // Every 5 s again; battery health only every few minutes
    await fake.clock.advance(5_000)
    expect(fake.count('ps -Aceo pid=,pcpu=,rss=,comm=')).toBeGreaterThanOrEqual(3)
    expect(fake.count('system_profiler SPPowerDataType')).toBe(1)
    await ui.unmount()
  })
}

test('turned off in the pane, the line goes and stays off', async ($, on) => {
  const fake = fakeMac(on)
  await start($)
  await $.command.run({ command: 'mac-monitor' } as never)
  await fake.clock.settle()
  const ui = await pane($, 'terminal')

  await ui.press({ key: 'band' })
  expect(fake.store.get('band')).toBe(false)
  expect(await ui.find({ text: /\[ \] Show the line above the prompt/ })).toBeDefined()
  const line = await band($, 'terminal')
  expect(await line.find({ text: /another mod's line/ })).toBeDefined()
  expect(await line.find({ text: /^CPU / })).toBeUndefined()
  await line.unmount()
  await ui.unmount()
})

test('with the line off and the pane not open, nothing is measured', async ($, on) => {
  const fake = fakeMac(on)
  fake.store.set('band', false)
  await start($)
  await fake.clock.advance(15_000)
  expect(fake.count('top -l 2 -n 0 -s 1')).toBe(0)
})

test('a survey in the band keeps it to itself', async ($, on) => {
  const fake = fakeMac(on)
  await start($)
  await fake.clock.settle()
  const ui = await band($, 'terminal', { hasSurvey: true })
  expect(await ui.find({ text: /^CPU / })).toBeUndefined()
  await ui.unmount()
})

test('on Windows or Linux, says it needs macOS and measures nothing', async ($, on) => {
  const fake = fakeMac(on, { mac: false })
  await start($)
  await fake.clock.advance(15_000)
  const r = await $.command.run({ command: 'mac-monitor' } as never)
  expect(r).toMatchObject({ text: 'Mac Monitor needs macOS.' })
  expect(fake.opened).toHaveLength(0)
  expect(fake.calls).toEqual([])
})
