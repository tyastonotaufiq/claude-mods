// mac-monitor: reading what macOS's own commands print (top, vm_stat, sysctl,
// df, pmset, system_profiler, ps, ioreg, route, netstat, networksetup) into
// numbers, kept apart to be tested.

import type { Battery, BatteryHealth, Pressure, Proc } from '../types'

/** CPU in use from `top -l 2 -n 0 -s 1`: its second sample, the first being since boot. */
export function parseTop(out: string): { used: number; user: number; sys: number; load: number } | undefined {
  const samples = [...out.matchAll(/CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/g)]
  const last = samples[samples.length - 1]
  if (!last) return undefined
  const load = [...out.matchAll(/Load Avg: ([\d.]+)/g)].pop()
  return {
    used: Math.round(100 - Number(last[3])),
    user: Math.round(Number(last[1])),
    sys: Math.round(Number(last[2])),
    load: load ? Number(load[1]) : 0,
  }
}

/**
 * Memory used as Activity Monitor counts it, from `vm_stat`: app memory
 * (anonymous pages less purgeable ones), wired, and what the compressor holds.
 */
export function parseVmStat(out: string, total: number): { used: number; total: number } | undefined {
  const pageSize = /page size of (\d+) bytes/.exec(out)
  const pages = (name: string) => Number(new RegExp(name + ':\\s+(\\d+)').exec(out)?.[1] ?? NaN)
  const used = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')
  if (!pageSize || !Number.isFinite(used) || !(total > 0)) return undefined
  return { used: Math.min(total, used * Number(pageSize[1])), total }
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1, 2 or 4. */
export function parsePressure(out: string): Pressure | undefined {
  return ({ '1': 'normal', '2': 'warn', '4': 'critical' } as const)[out.trim() as '1' | '2' | '4']
}

/** `sysctl -n vm.swapusage`: "total = 8192.00M  used = 7215.44M  free = …". */
export function parseSwap(out: string): { used: number; total: number } | undefined {
  const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(out)
  return m ? { used: Number(m[2]) * 1024 ** 2, total: Number(m[1]) * 1024 ** 2 } : undefined
}

/** `df -k <home>`: the data volume's size and what's free on it. */
export function parseDf(out: string): { free: number; total: number } | undefined {
  const row = out.trim().split('\n').pop()?.trim().split(/\s+/)
  const total = Number(row?.[1]) * 1024
  const free = Number(row?.[3]) * 1024
  return total > 0 && Number.isFinite(free) ? { free, total } : undefined
}

/** `pmset -g batt`; undefined on a Mac without a battery. */
export function parseBattery(out: string): Battery | undefined {
  const m = /(\d+)%; ([^;]+);([^\n]*)/.exec(out)
  if (!m) return undefined
  const state = m[2]!.trim()
  const remaining = /(\d+:\d\d) remaining/.exec(m[3]!)?.[1]
  return {
    percent: Number(m[1]),
    charging: state === 'charging',
    onPower: /'AC Power'/.test(out),
    ...(remaining && remaining !== '0:00' ? { remaining } : {}),
  }
}

/** `system_profiler SPPowerDataType`: the battery's health, as System Settings shows it. */
export function parseBatteryHealth(out: string): BatteryHealth | undefined {
  const field = (name: string) => new RegExp(name + ':\\s*(.+)').exec(out)?.[1]?.trim()
  const cycles = field('Cycle Count')
  const maxCapacity = field('Maximum Capacity')
  if (cycles === undefined || maxCapacity === undefined) return undefined
  const watts = field('Wattage \\(W\\)')
  return {
    maxCapacity,
    condition: field('Condition') ?? '',
    cycles: Number(cycles),
    ...(watts ? { watts: Number(watts) } : {}),
  }
}

/**
 * `pmset -g therm`: set while macOS slows the CPU for heat. Intel Macs give a
 * CPU_Speed_Limit under 100; Apple silicon says only that a warning level was
 * recorded, where an unthrottled Mac says none has been.
 */
export function parseThermal(out: string): { limit?: number } | undefined {
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(out)
  if (limit) return Number(limit[1]) < 100 ? { limit: Number(limit[1]) } : undefined
  const warned = out.split('\n').some(l => /(thermal|performance) warning level/i.test(l) && !/^\s*Note: No /i.test(l))
  return warned ? {} : undefined
}

/** `ioreg -r -d 1 -c IOAccelerator`: the GPU's use, and the memory it holds. */
export function parseGpu(out: string): { used: number; memory?: number } | undefined {
  const used = /"Device Utilization %"\s*=\s*(\d+)/.exec(out)
  if (!used) return undefined
  const memory = /"In use system memory"\s*=\s*(\d+)/.exec(out)
  return { used: Number(used[1]), ...(memory ? { memory: Number(memory[1]) } : {}) }
}

/** `route -n get default`: the device the Mac's traffic goes out on ("en0"). */
export function parseDefaultDevice(out: string): string | undefined {
  return /^\s*interface:\s*(\S+)/m.exec(out)?.[1]
}

/** `netstat -ibn -I <device>`: the bytes it has received and sent since boot. */
export function parseNetstat(out: string, device: string): { received: number; sent: number } | undefined {
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    // The link row: Name Mtu <Link#n> Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    if (cols[0] === device && cols[2]?.startsWith('<Link#') && cols.length >= 10) {
      return { received: Number(cols[6]), sent: Number(cols[9]) }
    }
  }
  return undefined
}

/** `networksetup -listallhardwareports`: "Wi-Fi" for en0, by device. */
export function parsePorts(out: string): Record<string, string> {
  const names: Record<string, string> = {}
  for (const m of out.matchAll(/Hardware Port: (.+)\nDevice: (\S+)/g)) names[m[2]!] = m[1]!.trim()
  return names
}

/** A speed in bytes per second, one decimal under 10: "1.2 MB/s", "102 KB/s", "0 B/s". */
export function speed(bytesPerSecond: number): string {
  if (!(bytesPerSecond > 0)) return '0 B/s'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let n = bytesPerSecond
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return (u > 0 && n < 10 ? n.toFixed(1) : Math.round(n).toString()) + ' ' + units[u]
}

/** `ps -Aceo pid=,pcpu=,rss=,comm=`: every process, memory in bytes. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]) * 1024, name: m[4]!.trim() })
  }
  return procs
}

/** The `n` processes using the most CPU, and the `n` using the most memory. */
export function topProcesses(procs: Proc[], n: number): { topCpu: Proc[]; topMem: Proc[] } {
  return {
    topCpu: [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, n),
    topMem: [...procs].sort((a, b) => b.mem - a.mem).slice(0, n),
  }
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return (u < 3 || n >= 100 ? Math.round(n).toString() : n.toFixed(1)) + ' ' + units[u]
}

/** A bar `width` cells wide for a percentage: "▓▓▓░░░". */
export function bar(pct: number, width: number): string {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▓'.repeat(full) + '░'.repeat(width - full)
}

/** How a percentage should look: fine, getting high, or high. */
export function level(pct: number): 'ok' | 'high' | 'full' {
  return pct >= 90 ? 'full' : pct >= 75 ? 'high' : 'ok'
}
