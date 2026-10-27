// mac-monitor: this Mac's CPU, memory, disk and battery in a line above the
// prompt, refreshed every 5 seconds, and in a /mac-monitor pane with memory
// pressure, swap, heat throttling, battery health, GPU, network speed and the
// busiest processes.
//
// Everything comes from macOS's own commands, read-only: top, vm_stat, sysctl,
// df, pmset, system_profiler, ps, ioreg, route, netstat and networksetup.
// Nothing is sampled while the line is off and the pane is closed.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Details, Stats } from '../types'
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
  percent,
  speed,
  topProcesses,
} from './monitor'

const PANE = 'mac-monitor'
const EVERY_MS = 5_000
/** system_profiler is slow and battery health changes slowly */
const HEALTH_EVERY_MS = 5 * 60_000
const TOP_N = 5

const stats = atom({ plugin: 'mac-monitor', key: 'stats' } as const, null as Stats | null)
const details = atom({ plugin: 'mac-monitor', key: 'details' } as const, null as Details | null)
const band = atom({ plugin: 'mac-monitor', key: 'band' } as const, true)

type $ = EngineInterface

let paneOpen = false
let sampling = false
let memTotal = 0
let healthAt = 0
let timer: { cancel: () => void } | undefined
/** The last sample's byte counters, to turn bytes since boot into a speed */
let lastNet: { device: string; at: number; received: number; sent: number } | undefined
/** Device to name ("en0" to "Wi-Fi"), read once */
let ports: Record<string, string> | undefined

/** Whether this is a Mac: every macOS has this file, Windows and Linux don't. */
async function isMac($: $): Promise<boolean> {
  return $.fs.exists('/System/Library/CoreServices/SystemVersion.plist')
}

async function homeOf($: $): Promise<string> {
  return ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
}

/** A command's output, or '' when it fails: one missing value doesn't stop the rest. */
async function output($: $, argv: string[], timeoutMs = 10_000): Promise<string> {
  try {
    return (await $.process.run(argv, { timeoutMs })).stdout
  } catch {
    return ''
  }
}

/** For the pane: GPU use, and the speed of the connection in use since the last sample. */
async function addGpuAndNetwork($: $, next: Stats) {
  const [ioreg, route] = await Promise.all([
    output($, ['ioreg', '-r', '-d', '1', '-c', 'IOAccelerator']),
    output($, ['route', '-n', 'get', 'default']),
  ])
  const gpu = parseGpu(ioreg)
  if (gpu) next.gpu = gpu
  const device = parseDefaultDevice(route)
  if (!device) {
    lastNet = undefined
    return
  }
  ports ??= parsePorts(await output($, ['networksetup', '-listallhardwareports']))
  const counters = parseNetstat(await output($, ['netstat', '-ibn', '-I', device]), device)
  const network: NonNullable<Stats['network']> = { device, name: ports[device] ?? device }
  if (counters && lastNet?.device === device && next.at > lastNet.at) {
    const seconds = (next.at - lastNet.at) / 1000
    network.down = Math.max(0, (counters.received - lastNet.received) / seconds)
    network.up = Math.max(0, (counters.sent - lastNet.sent) / seconds)
  }
  lastNet = counters ? { device, at: next.at, ...counters } : undefined
  next.network = network
}

/** Takes one sample; with the pane open, also GPU, network, the busiest processes and battery health. */
async function sample($: $) {
  if (sampling) return
  sampling = true
  try {
    if (!memTotal) memTotal = Number((await output($, ['sysctl', '-n', 'hw.memsize'])).trim()) || 0
    const [top, vm, pressure, swap, df, batt, therm] = await Promise.all([
      output($, ['top', '-l', '2', '-n', '0', '-s', '1']),
      output($, ['vm_stat']),
      output($, ['sysctl', '-n', 'kern.memorystatus_vm_pressure_level']),
      output($, ['sysctl', '-n', 'vm.swapusage']),
      output($, ['df', '-k', await homeOf($)]),
      output($, ['pmset', '-g', 'batt']),
      output($, ['pmset', '-g', 'therm']),
    ])
    const next: Stats = { at: await $.clock.now() }
    const cpu = parseTop(top)
    const memory = parseVmStat(vm, memTotal)
    const memPressure = parsePressure(pressure)
    const swapUse = parseSwap(swap)
    const disk = parseDf(df)
    const battery = parseBattery(batt)
    const throttled = parseThermal(therm)
    if (cpu) next.cpu = cpu
    if (memory) next.memory = memory
    if (memPressure) next.pressure = memPressure
    if (swapUse) next.swap = swapUse
    if (disk) next.disk = disk
    if (battery) next.battery = battery
    if (throttled) next.throttled = throttled
    if (paneOpen) await addGpuAndNetwork($, next)
    await update($, stats, () => next)

    if (paneOpen) {
      const procs = topProcesses(parsePs(await output($, ['ps', '-Aceo', 'pid=,pcpu=,rss=,comm='])), TOP_N)
      let health = (await read($, details))?.health
      if (battery && next.at - healthAt >= HEALTH_EVERY_MS) {
        healthAt = next.at
        health = parseBatteryHealth(await output($, ['system_profiler', 'SPPowerDataType'], 30_000))
      }
      await update($, details, () => ({ ...procs, ...(health ? { health } : {}) }))
    }
  } finally {
    sampling = false
  }
}

async function tick($: $) {
  if (paneOpen || (await read($, band))) await sample($)
}

async function setBand($: $, on: boolean) {
  await $.store.set('band', on)
  await update($, band, () => on)
}

function color(pct: number): 'yellow' | 'red' | undefined {
  const l = level(pct)
  return l === 'full' ? 'red' : l === 'high' ? 'yellow' : undefined
}

function batteryText(b: NonNullable<Stats['battery']>): string {
  if (b.charging) return 'charging' + (b.remaining ? ', full in ' + b.remaining : '')
  if (b.onPower) return 'on the charger'
  return 'on battery' + (b.remaining ? ', ' + b.remaining + ' left' : '')
}

function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'mac-monitor',
        description: "See this Mac's CPU, memory, disk, battery and busiest processes",
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/mac-monitor could not be registered: ' + (err instanceof Error ? err.message : String(err)))
    }
    const saved = await $.store.get('band')
    await update($, band, () => saved !== false)
    paneOpen = false
    timer?.cancel()
    timer = undefined
    if (await isMac($)) {
      timer = $.clock.every(EVERY_MS, () => void tick($))
      void tick($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  on('command.run', { command: 'mac-monitor' }, async $ => {
    if (!(await isMac($))) return { text: 'Mac Monitor needs macOS.' }
    const placed = await $.ui.open({ id: PANE, title: 'Mac Monitor', focus: true, closeOnEscape: true })
    paneOpen = true
    healthAt = 0
    // A speed is measured from this sample on, not across the time the pane was closed
    lastNet = undefined
    void sample($)
    return placed.isPlaced ? {} : { text: 'Mac Monitor is ready; widen the terminal to see the pane.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // The line goes under whatever another mod shows in the band, never in its place
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const s = await read($, stats)
    if (e.props.hasSurvey || !s || !(await read($, band))) return below
    const { Box, Text } = $.ui.resolve(e)

    const item = (key: string, label: string, value: string, tint?: 'yellow' | 'red', extra?: string) => (
      <Text key={key}>
        <Text dimColor>{label + ' '}</Text>
        <Text color={tint}>{value}</Text>
        {extra ? <Text dimColor>{' ' + extra}</Text> : null}
      </Text>
    )
    const mem = s.memory ? percent(s.memory.used, s.memory.total) : undefined
    const disk = s.disk ? percent(s.disk.total - s.disk.free, s.disk.total) : undefined
    const b = s.battery
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {s.cpu ? item('cpu', 'CPU', s.cpu.used + '%', color(s.cpu.used)) : null}
          {mem !== undefined ? item('mem', 'MEM', mem + '%', color(mem)) : null}
          {s.pressure && s.pressure !== 'normal' ? (
            <Text key="pressure" color={s.pressure === 'critical' ? 'red' : 'yellow'}>{'pressure ' + s.pressure}</Text>
          ) : null}
          {disk !== undefined ? item('disk', 'DISK', disk + '%', color(disk)) : null}
          {b
            ? item(
                'bat',
                'BAT',
                b.percent + '%',
                !b.onPower && b.percent <= 10 ? 'red' : !b.onPower && b.percent <= 20 ? 'yellow' : undefined,
                b.charging ? 'charging' : !b.onPower && b.remaining ? b.remaining + ' left' : undefined,
              )
            : null}
          {s.throttled ? (
            <Text key="hot" color="red">
              {s.throttled.limit ? `hot: CPU limited to ${s.throttled.limit}%` : 'hot: CPU slowed'}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, stats)
    const d = await read($, details)
    const showBand = await read($, band)

    // The label and the bar keep their width; only the text after them is cut when the pane is narrow
    const row = (key: string, label: string, pct: number | undefined, text: string) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box flexShrink={0} width={8}>
          <Text bold>{label}</Text>
        </Box>
        {pct !== undefined ? (
          <Box flexShrink={0}>
            <Text color={color(pct)}>{bar(pct, 10) + ' ' + String(pct).padStart(3) + '%'}</Text>
          </Box>
        ) : null}
        <Text dimColor wrap="truncate-end">{text}</Text>
      </Box>
    )
    const proc = (key: string, value: string, name: string) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Text>{value.padStart(8)}</Text>
        <Text wrap="truncate-end">{name}</Text>
      </Box>
    )

    if (!s) {
      return (
        <Box flexDirection="column">
          <Text bold>Mac Monitor</Text>
          <Text dimColor>Measuring…</Text>
        </Box>
      )
    }
    const mem = s.memory
    const memPct = mem ? percent(mem.used, mem.total) : undefined
    const diskPct = s.disk ? percent(s.disk.total - s.disk.free, s.disk.total) : undefined
    const b = s.battery
    const health = d?.health
    const net = s.network
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>Mac Monitor</Text>
          <Text dimColor>{'updated ' + clock(s.at) + ', every 5 s'}</Text>
        </Box>
        <Text> </Text>

        {s.cpu
          ? row('cpu', 'CPU', s.cpu.used, `user ${s.cpu.user}% · system ${s.cpu.sys}% · load ${s.cpu.load.toFixed(2)}`)
          : null}
        {s.gpu ? row('gpu', 'GPU', s.gpu.used, s.gpu.memory ? `${humanSize(s.gpu.memory)} in use` : '') : null}
        {mem
          ? row(
              'mem',
              'Memory',
              memPct,
              `${humanSize(mem.used)} of ${humanSize(mem.total)}` + (s.pressure ? ` · pressure ${s.pressure}` : ''),
            )
          : null}
        {s.swap ? row('swap', 'Swap', undefined, `${humanSize(s.swap.used)} of ${humanSize(s.swap.total)} used`) : null}
        {s.disk ? row('disk', 'Disk', diskPct, `${humanSize(s.disk.free)} free of ${humanSize(s.disk.total)}`) : null}
        {b
          ? row(
              'bat',
              'Battery',
              b.percent,
              batteryText(b) + (b.onPower && health?.watts ? ` · ${health.watts} W charger` : ''),
            )
          : null}
        {b && health
          ? row(
              'health',
              'Health',
              undefined,
              health.maxCapacity + (health.condition ? ` (${health.condition})` : '') + ` · ${health.cycles} cycles`,
            )
          : null}
        {net
          ? row(
              'net',
              'Network',
              undefined,
              (net.down === undefined || net.up === undefined ? 'measuring…' : `↓ ${speed(net.down)}  ↑ ${speed(net.up)}`) +
                ` (${net.name === net.device ? net.device : net.name + ', ' + net.device})`,
            )
          : null}
        {row(
          'heat',
          'Heat',
          undefined,
          s.throttled ? (s.throttled.limit ? `CPU limited to ${s.throttled.limit}%: the Mac is hot` : 'CPU slowed: the Mac is hot') : 'normal',
        )}
        <Text> </Text>

        <Text bold>Most CPU</Text>
        {d ? d.topCpu.map((p, i) => proc('cpu-' + i, p.cpu.toFixed(0) + '%', p.name)) : <Text dimColor>Measuring…</Text>}
        <Text> </Text>
        <Text bold>Most memory</Text>
        {d ? d.topMem.map((p, i) => proc('mem-' + i, humanSize(p.mem), p.name)) : <Text dimColor>Measuring…</Text>}
        <Text> </Text>

        <Button
          key="band"
          label={(showBand ? '[x]' : '[ ]') + ' Show the line above the prompt'}
          hotkey="b"
          plain
          onPress={() => void setBand($, !showBand)}
        />
      </Box>
    )
  })
}
