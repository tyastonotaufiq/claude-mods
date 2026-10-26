import { expect, mock, test } from 'claude-code/testing'

const H = '/Users/t'
const MB = 1024 * 1024
const SLACK = 'com.tinyspeck.slackmacgap'

// A fake Mac: Slack, Safari and Example Studio installed; Slack's leftovers in
// ~/Library, plus what an uninstalled Spotify left behind. com.other.app's
// container belongs to an app Spotlight finds in Downloads.
function fakeMac(
  on: any,
  calls: string[][],
  opts: { findings?: string; extension?: boolean } = {},
): Set<string> {
  const dirs: Record<string, string[]> = {
    '/Applications': ['Slack.app', 'Safari.app', 'Example Studio 2025', 'Utilities', 'Tasbih.app'],
    '/Applications/Example Studio 2025': ['Example Studio 2025.app'],
    [H + '/Library/Application Support']: ['Slack', 'Spotify'],
    [H + '/Library/Caches']: [SLACK, 'com.spotify.client'],
    [H + '/Library/Preferences']: [SLACK + '.plist', 'com.spotify.client.plist', 'com.apple.finder.plist', 'ByHost'],
    [H + '/Library/Containers']: [SLACK, 'com.other.app'],
    [H + '/Library/Group Containers']: ['ABCDE12345.' + SLACK],
  }
  // An app, removed, but its system extension still runs
  if (opts.extension) {
    dirs[H + '/Library/Caches']!.push('com.example.app')
    dirs[H + '/Library/Containers']!.push('com.example.app')
  }
  const extensions = [
    'enabled\tactive\tteamID\tbundleID (version)\tname\t[state]',
    '*\t*\tEXAMPLE123\tcom.example.app.extension (6.5.2/1)\tExample Extension\t[activated enabled]',
  ].join('\n')
  const plists: Record<string, object> = {
    '/Applications/Slack.app': { CFBundleIdentifier: SLACK, CFBundleName: 'Slack', CFBundleShortVersionString: '4.41' },
    '/Applications/Safari.app': { CFBundleIdentifier: 'com.apple.Safari', CFBundleName: 'Safari' },
    '/Applications/Example Studio 2025/Example Studio 2025.app': { CFBundleIdentifier: 'org.example.studio' },
    // An iPhone app: its Info.plist is inside WrappedBundle
    '/Applications/Tasbih.app/WrappedBundle': { CFBundleIdentifier: 'dev.t.tasbih', CFBundleShortVersionString: '2.0' },
  }
  const kb: Record<string, number> = {
    '/Applications/Slack.app': 500 * 1024,
    [H + '/Library/Caches/' + SLACK]: 300 * 1024,
    [H + '/Library/Containers/' + SLACK]: 200 * 1024,
    [H + '/Library/Application Support/Slack']: 100 * 1024,
    [H + '/Library/Caches/com.spotify.client']: 900 * 1024,
    [H + '/.slack']: 1024,
  }
  const exists = new Set<string>([
    ...Object.keys(plists).map(p => (p.endsWith('/WrappedBundle') ? p + '/Info.plist' : p)),
    ...Object.entries(dirs).flatMap(([d, names]) => names.map(n => d + '/' + n)),
    H + '/.slack',
  ])
  if (opts.findings) exists.add(H + '/.claude/mac-uninstaller/findings.json')
  const ok = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: exists.has(e.path) }))
  on('fs.list', async (_$: unknown, e: { path: string }) => ({
    value: (dirs[e.path] ?? [])
      .filter(name => exists.has(e.path + '/' + name))
      .map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', async () => ({ value: opts.findings ?? '' }))
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[0] === 'plutil') {
      const app = (argv[argv.length - 1] ?? '').replace(/\/(Contents\/)?Info\.plist$/, '')
      return plists[app] ? ok(JSON.stringify(plists[app])) : ok('', 1)
    }
    if (argv[0] === 'du') return ok(`${kb[argv[2] ?? ''] ?? 4}\t${argv[2]}`)
    if (argv[0] === 'systemextensionsctl') return ok(opts.extension ? extensions : '')
    // Spotlight knows com.other.app is still installed, outside /Applications
    if (argv[0] === 'mdfind') return ok(argv[1]?.includes('com.other.app') ? H + '/Downloads/Other.app\n' : '')
    return ok('')
  })
  return exists
}

/** The paths an osascript call shows in Finder. */
function revealed(calls: string[][]): string[] {
  const argv = calls.find(c => c[0] === 'osascript') ?? []
  return argv.slice(argv.indexOf('--') + 1)
}

const PANE = {
  title: 'Mac Uninstaller',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

async function mount($: any, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'mac-uninstaller', surface, component: 'Pane', requestId: 'mac-uninstaller', props: PANE as never })
}

async function setup(on: any, calls: string[][], opts: Parameters<typeof fakeMac>[2] = {}): Promise<Set<string>> {
  const exists = fakeMac(on, calls, opts)
  mock.store(on)
  mock.env(on, { HOME: H })
  mock.clock(on, { now: 1_760_000_000_000 })
  return exists
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: lists apps without macOS's own, and filters them`, async ($, on) => {
    const calls: string[][] = []
    await setup(on, calls)
    const ui = await mount($, surface)
    await ui.press({ key: 'reload' })

    expect((await ui.find({ key: 'app-0' }))?.text).toMatch(/Example Studio 2025/)
    expect((await ui.find({ key: 'app-1' }))?.text).toMatch(/Slack/)
    expect((await ui.find({ key: 'app-2' }))?.text).toMatch(/Tasbih/)
    expect(await ui.find({ key: 'app-3' })).toBeUndefined()
    expect(await ui.find({ text: /Safari/ })).toBeUndefined()

    await ui.input({ key: 'filter', text: 'sla', kind: 'change' })
    expect((await ui.find({ key: 'app-0' }))?.text).toMatch(/Slack/)
    expect(await ui.find({ key: 'app-1' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: shows an app and what it left in Finder, and a rescan drops what was moved`, async ($, on) => {
    const calls: string[][] = []
    const exists = await setup(on, calls)
    const ui = await mount($, surface)
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'app-1' })

    // The app first, then its leftovers; another app's container isn't listed
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/\/Applications\/Slack\.app/)
    expect(await ui.find({ text: /com\.other\.app/ })).toBeUndefined()
    expect(await ui.find({ text: /Spotify/ })).toBeUndefined()
    const names = (await ui.findAll({ type: 'Button' })).map((b: { text?: string }) => b.text).join('\n')
    expect(names).toContain('~/Library/Caches/' + SLACK)
    expect(names).toContain('~/Library/Preferences/' + SLACK + '.plist')
    expect(names).toContain('~/Library/Containers/' + SLACK)
    expect(names).toContain('~/Library/Application Support/Slack')
    expect(names).toContain('~/Library/Group Containers/ABCDE12345.' + SLACK)

    // Rescanning stays on this app and marks the same rows again
    await ui.press({ key: 'rescan' })
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/\/Applications\/Slack\.app/)

    // The app, cache, settings and container are marked; the name match and shared container aren't
    expect((await ui.find({ key: 'reveal' }))?.text).toMatch(/\(4, 1000 MB\)/)
    await ui.press({ key: 'reveal' })
    const shown = [
      '/Applications/Slack.app',
      H + '/Library/Caches/' + SLACK,
      H + '/Library/Preferences/' + SLACK + '.plist',
      H + '/Library/Containers/' + SLACK,
    ]
    expect(revealed(calls).sort()).toEqual([...shown].sort())
    expect(calls.some(c => c[0] === 'rm' || c[0] === '/usr/bin/trash')).toBe(false)
    expect(await ui.find({ text: /Showed 4 item\(s\) in Finder\. Press ⌘⌫ there/ })).toBeDefined()

    // The person moves them to the Trash in Finder, then rescans: only the rest is left
    for (const p of shown) exists.delete(p)
    exists.delete('/Applications/Slack.app/Contents/Info.plist')
    await ui.press({ key: 'rescan' })
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/Application Support\/Slack/)
    expect(await ui.find({ text: /Slack left 2 item\(s\) behind/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: nothing marked shows nothing`, async ($, on) => {
    const calls: string[][] = []
    await setup(on, calls)
    const ui = await mount($, surface)
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'app-1' })
    await ui.press({ key: 'clear' })
    await ui.press({ key: 'reveal' })
    expect(calls.some(c => c[0] === 'osascript')).toBe(false)
    expect(await ui.find({ text: /Mark items first/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: shows Claude's findings for this app, unmarked`, async ($, on) => {
    const calls: string[][] = []
    await setup(on, calls, {
      findings: JSON.stringify({
        app: SLACK,
        items: [
          { path: '~/.slack', sizeBytes: 1024 * 1024, reason: 'Slack CLI settings' },
          { path: '~/.ssh', sizeBytes: 10 },
        ],
      }),
    })
    const ui = await mount($, surface)
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'app-1' })

    const names = (await ui.findAll({ type: 'Button' })).map((b: { text?: string }) => b.text).join('\n')
    expect(names).toContain('~/.slack')
    expect(names).not.toContain('~/.ssh')
    expect(await ui.find({ text: /Found by Claude · Slack CLI settings/ })).toBeDefined()
    expect((await ui.find({ key: 'reveal' }))?.text).toMatch(/\(4,/)
    await ui.unmount()
  })

  test(`${surface}: finds leftovers of removed apps and shows them in Finder`, async ($, on) => {
    const calls: string[][] = []
    const exists = await setup(on, calls)
    const ui = await mount($, surface)
    await ui.press({ key: 'orphans' })

    expect((await ui.find({ key: 'name-0' }))?.text).toBe('com.spotify.client')
    expect(await ui.find({ key: 'name-1' })).toBeUndefined()
    expect(await ui.find({ text: /Cache, Settings · 2 item\(s\) · no app with this ID \(may be a command-line tool\)/ })).toBeDefined()

    await ui.press({ key: 'mark-all' })
    expect((await ui.find({ key: 'reveal' }))?.text).toMatch(/\(1, 900 MB\)/)
    await ui.press({ key: 'reveal' })
    const shown = [H + '/Library/Caches/com.spotify.client', H + '/Library/Preferences/com.spotify.client.plist']
    expect(revealed(calls)).toEqual(shown)
    expect(await ui.find({ text: /Showed 2 item\(s\) in Finder/ })).toBeDefined()

    // Moved in Finder, then rescanned: nothing left
    for (const p of shown) exists.delete(p)
    await ui.press({ key: 'rescan' })
    expect(await ui.find({ key: 'name-0' })).toBeUndefined()
    expect(await ui.find({ text: /No leftovers from removed apps found/ })).toBeDefined()
    expect(await ui.find({ text: /System extensions of removed apps/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a container held by a running extension is shown, with what to do first`, async ($, on) => {
    const calls: string[][] = []
    await setup(on, calls, { extension: true })
    const ui = await mount($, surface)
    await ui.press({ key: 'orphans' })

    expect((await ui.find({ key: 'name-1' }))?.text).toBe('com.example.app')
    expect(await ui.find({ text: /its extension "Example Extension" is still running/ })).toBeDefined()
    expect(await ui.find({ text: /System extensions of removed apps/ })).toBeDefined()
    expect(await ui.find({ text: /com\.example\.app\.extension · still running/ })).toBeDefined()

    await ui.press({ key: 'mark-1' })
    await ui.press({ key: 'reveal' })
    expect(revealed(calls).sort()).toEqual([H + '/Library/Caches/com.example.app', H + '/Library/Containers/com.example.app'])
    expect(await ui.find({ text: /"Example Extension" still running, so macOS protects its containers/ })).toBeDefined()
    await ui.unmount()
  })
}
