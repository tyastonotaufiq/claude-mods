import { describe, expect, test } from 'claude-code/testing'

import {
  bar,
  humanSize,
  level,
  parseBattery,
  parseBatteryHealth,
  parseDefaultDevice,
  parseDf,
  parseGpu,
  parseNetstat,
  parsePorts,
  parsePressure,
  parsePs,
  parseSwap,
  parseThermal,
  parseTop,
  parseVmStat,
  speed,
  topProcesses,
} from '../hooks/monitor'

const GB = 1024 ** 3

describe('CPU', () => {
  test('the second sample of top, the first being since boot', () => {
    const top = [
      'Load Avg: 1.00, 1.00, 1.00 ',
      'CPU usage: 5.00% user, 5.00% sys, 90.00% idle ',
      'Load Avg: 5.60, 4.18, 4.02 ',
      'CPU usage: 28.87% user, 19.77% sys, 51.34% idle ',
    ].join('\n')
    expect(parseTop(top)).toEqual({ used: 49, user: 29, sys: 20, load: 5.6 })
    expect(parseTop('')).toBeUndefined()
  })
})

describe('memory', () => {
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                     4835.',
    'Pages active:                                 189376.',
    'Pages wired down:                             131072.',
    'Pages purgeable:                                1000.',
    'Anonymous pages:                              263144.',
    'Pages occupied by compressor:                 131072.',
  ].join('\n')

  test('app memory, wired and compressed, as Activity Monitor counts it', () => {
    // (263144 - 1000) + 131072 + 131072 pages of 16 KB: 8 GB
    expect(parseVmStat(VM_STAT, 16 * GB)).toEqual({ used: 8 * GB, total: 16 * GB })
    expect(parseVmStat('', 16 * GB)).toBeUndefined()
    expect(parseVmStat(VM_STAT, 0)).toBeUndefined()
  })

  test('pressure levels and swap', () => {
    expect(parsePressure('1\n')).toBe('normal')
    expect(parsePressure('2')).toBe('warn')
    expect(parsePressure('4')).toBe('critical')
    expect(parsePressure('')).toBeUndefined()
    expect(parseSwap('total = 8192.00M  used = 2048.00M  free = 6144.00M  (encrypted)')).toEqual({ used: 2 * GB, total: 8 * GB })
    expect(parseSwap('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)')).toEqual({ used: 0, total: 0 })
  })
})

describe('disk', () => {
  test('size and free space of the data volume', () => {
    const df = [
      'Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on',
      '/dev/disk3s5   500000000 400000000  50000000    89% 8535006 564421520    1%   /System/Volumes/Data',
    ].join('\n')
    expect(parseDf(df)).toEqual({ free: 50000000 * 1024, total: 500000000 * 1024 })
    expect(parseDf('')).toBeUndefined()
  })
})

describe('battery', () => {
  test('on battery, charging, on the charger but full, and a Mac without one', () => {
    expect(
      parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t23%; discharging; 1:19 remaining present: true"),
    ).toEqual({ percent: 23, charging: false, onPower: false, remaining: '1:19' })
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t82%; charging; 0:45 remaining present: true")).toEqual({
      percent: 82,
      charging: true,
      onPower: true,
      remaining: '0:45',
    })
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true")).toEqual({
      percent: 100,
      charging: false,
      onPower: true,
    })
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t60%; discharging; (no estimate) present: true")).toEqual({
      percent: 60,
      charging: false,
      onPower: false,
    })
    expect(parseBattery("Now drawing from 'AC Power'\n")).toBeUndefined()
  })

  test('health as System Settings shows it, with the charger when one is in', () => {
    const profiler = [
      'Power:',
      '    Battery Information:',
      '      Health Information:',
      '          Cycle Count: 1008',
      '          Condition: Normal',
      '          Maximum Capacity: 81%',
      '    AC Charger Information:',
      '      Connected: Yes',
      '      Wattage (W): 96',
    ].join('\n')
    expect(parseBatteryHealth(profiler)).toEqual({ maxCapacity: '81%', condition: 'Normal', cycles: 1008, watts: 96 })
    expect(parseBatteryHealth('Power:\n    AC Charger Information:\n      Connected: Yes')).toBeUndefined()
  })
})

describe('heat', () => {
  test('throttled with a speed limit, throttled without one, and not throttled', () => {
    expect(parseThermal('CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70')).toEqual({ limit: 70 })
    expect(parseThermal('CPU_Speed_Limit \t= 100')).toBeUndefined()
    expect(parseThermal('Thermal warning level set to 2.\nNote: No performance warning level has been recorded')).toEqual({})
    expect(
      parseThermal(
        'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded',
      ),
    ).toBeUndefined()
  })
})

describe('GPU and network', () => {
  test('GPU use and the memory it holds', () => {
    const ioreg = '"PerformanceStatistics" = {"Tiler Utilization %"=40,"In use system memory"=536870912,"Device Utilization %"=46}'
    expect(parseGpu(ioreg)).toEqual({ used: 46, memory: 512 * 1024 ** 2 })
    expect(parseGpu('"Device Utilization %"=3')).toEqual({ used: 3 })
    expect(parseGpu('')).toBeUndefined()
  })

  test('the connection in use, its byte counters and its name', () => {
    expect(parseDefaultDevice('   route to: default\ndestination: default\n  interface: en0\n      flags: <UP>')).toBe('en0')
    expect(parseDefaultDevice('route: writing to routing socket: not in table')).toBeUndefined()
    const netstat = [
      'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
      'en0        1500  <Link#11>   02:00:00:00:00:01  2852318     0 1838945284  1154606     0  598220477     0',
      'en0        1500  fe80::1%en0 fe80:b::1          2852318     - 1838945284  1154606     -  598220477     -',
    ].join('\n')
    expect(parseNetstat(netstat, 'en0')).toEqual({ received: 1838945284, sent: 598220477 })
    expect(parseNetstat(netstat, 'en1')).toBeUndefined()
    const ports = 'Hardware Port: Thunderbolt Bridge\nDevice: bridge0\nEthernet Address: 02:00:00:00:00:02\n\nHardware Port: Wi-Fi\nDevice: en0\n'
    expect(parsePorts(ports)).toEqual({ bridge0: 'Thunderbolt Bridge', en0: 'Wi-Fi' })
  })

  test('speeds', () => {
    expect(speed(1.2 * 1024 ** 2)).toBe('1.2 MB/s')
    expect(speed(102.4 * 1024)).toBe('102 KB/s')
    expect(speed(900)).toBe('900 B/s')
    expect(speed(0)).toBe('0 B/s')
  })
})

describe('processes', () => {
  test('the busiest by CPU and by memory, names with spaces kept', () => {
    const procs = parsePs(
      [
        '  612  69.4  14640 ExampleRunner',
        ' 3713  62.2 618704 Example Browser Helper (Renderer)',
        ' 1697  10.0 901440 example-emulator',
        'garbage',
      ].join('\n'),
    )
    expect(procs).toHaveLength(3)
    const top = topProcesses(procs, 2)
    expect(top.topCpu.map(p => p.name)).toEqual(['ExampleRunner', 'Example Browser Helper (Renderer)'])
    expect(top.topMem.map(p => p.name)).toEqual(['example-emulator', 'Example Browser Helper (Renderer)'])
    expect(top.topMem[0]!.mem).toBe(901440 * 1024)
  })
})

describe('drawing', () => {
  test('sizes, bars and when a value gets a color', () => {
    expect(humanSize(14.2 * GB)).toBe('14.2 GB')
    expect(humanSize(0)).toBe('—')
    expect(bar(49, 10)).toBe('▓▓▓▓▓░░░░░')
    expect(bar(120, 4)).toBe('▓▓▓▓')
    expect([level(74), level(75), level(90)]).toEqual(['ok', 'high', 'full'])
  })
})
