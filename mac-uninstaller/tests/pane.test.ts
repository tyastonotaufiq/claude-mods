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
  opts: { running?: boolean; findings?: string; trashFails?: boolean; extension?: boolean } = {},
) {
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
    '/usr/bin/trash',
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
    if (argv[0] === 'pgrep') return opts.running ? ok('123\n') : ok('', 1)
    if (argv[0] === 'systemextensionsctl') return ok(opts.extension ? extensions : '')
    // Spotlight knows com.other.app is still installed, outside /Applications
    if (argv[0] === 'mdfind') return ok(argv[1]?.includes('com.other.app') ? H + '/Downloads/Other.app\n' : '')
    if (argv[0] === '/usr/bin/trash' || argv[0] === 'osascript') {
      if (!opts.trashFails) for (const p of argv.slice(1)) exists.delete(p)
      return ok('', opts.trashFails ? 1 : 0)
    }
    return ok('')
  })
}

function answer(on: any, choice: string, asked: string[] = []) {
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => {
    asked.push(e.questions[0].question)
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: choice } } } as never
  })
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

async function setup(on: any, calls: string[][], opts: Parameters<typeof fakeMac>[2] = {}) {
  fakeMac(on, calls, opts)
  mock.store(on)
  mock.env(on, { HOME: H })
  mock.clock(on, { now: 1_760_000_000_000 })
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

  test(`${surface}: uninstalls an app with what it left, after asking`, async ($, on) => {
    const calls: string[][] = []
    const asked: string[] = []
    await setup(on, calls)
    answer(on, 'Move to Trash', asked)
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
    expect((await ui.find({ key: 'uninstall' }))?.text).toMatch(/\(4, 1000 MB\)/)
    await ui.press({ key: 'uninstall' })
    expect(asked[0]).toMatch(/Move Slack and 3 leftover\(s\), 1000 MB, to the Trash\?/)

    const trashCall = calls.find(c => c[0] === '/usr/bin/trash')
    expect(trashCall).toContain('/Applications/Slack.app')
    expect(trashCall).toContain(H + '/Library/Containers/' + SLACK)
    expect(trashCall).not.toContain(H + '/Library/Application Support/Slack')
    expect(calls.some(c => c[0] === 'rm')).toBe(false)
    expect(await ui.find({ text: /Moved 4 item\(s\), 1000 MB, to the Trash/ })).toBeDefined()
    expect((await ui.find({ key: 'name-0' }))?.text).toMatch(/Application Support\/Slack/)
    await ui.unmount()
  })

  test(`${surface}: a running app isn't moved, and cancelling moves nothing`, async ($, on) => {
    const calls: string[][] = []
    await setup(on, calls, { running: true })
    answer(on, 'Cancel')
    const ui = await mount($, surface)
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'app-1' })

    await ui.press({ key: 'uninstall' })
    expect(await ui.find({ text: /Slack is running\. Quit it/ })).toBeDefined()

    // Leftovers alone don't need the app quit, but Cancel stops them
    await ui.press({ key: 'mark-0' })
    await ui.press({ key: 'uninstall' })
    expect(calls.some(c => c[0] === '/usr/bin/trash' || c[0] === 'osascript')).toBe(false)
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
    expect((await ui.find({ key: 'uninstall' }))?.text).toMatch(/\(4,/)
    await ui.unmount()
  })

  test(`${surface}: finds and trashes leftovers of removed apps`, async ($, on) => {
    const calls: string[][] = []
    const asked: string[] = []
    await setup(on, calls)
    answer(on, 'Move to Trash', asked)
    const ui = await mount($, surface)
    await ui.press({ key: 'orphans' })

    expect((await ui.find({ key: 'name-0' }))?.text).toBe('com.spotify.client')
    expect(await ui.find({ key: 'name-1' })).toBeUndefined()
    expect(await ui.find({ text: /Cache, Settings · 2 item\(s\) · no app with this ID \(may be a command-line tool\)/ })).toBeDefined()

    await ui.press({ key: 'mark-all' })
    expect((await ui.find({ key: 'trash' }))?.text).toMatch(/\(1, 900 MB\)/)
    await ui.press({ key: 'clear' })
    await ui.press({ key: 'mark-0' })
    await ui.press({ key: 'trash' })
    expect(asked[0]).toMatch(/Move what 1 removed app\(s\) left, 2 item\(s\), 900 MB, to the Trash\?/)
    const trashCall = calls.find(c => c[0] === '/usr/bin/trash')
    expect(trashCall).toEqual([
      '/usr/bin/trash',
      H + '/Library/Caches/com.spotify.client',
      H + '/Library/Preferences/com.spotify.client.plist',
    ])
    expect(await ui.find({ text: /Moved 2 item\(s\) to the Trash/ })).toBeDefined()

    // Rescanning finds nothing left
    await ui.press({ key: 'rescan' })
    expect(await ui.find({ key: 'name-0' })).toBeUndefined()
    expect(await ui.find({ text: /No leftovers from removed apps found/ })).toBeDefined()
    expect(await ui.find({ text: /System extensions of removed apps/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a container held by a running extension is shown but not moved`, async ($, on) => {
    const calls: string[][] = []
    const asked: string[] = []
    await setup(on, calls, { extension: true })
    answer(on, 'Move to Trash', asked)
    const ui = await mount($, surface)
    await ui.press({ key: 'orphans' })

    expect((await ui.find({ key: 'name-1' }))?.text).toBe('com.example.app')
    expect(await ui.find({ text: /its extension "Example Extension" is still running/ })).toBeDefined()
    expect(await ui.find({ text: /System extensions of removed apps/ })).toBeDefined()
    expect(await ui.find({ text: /com\.example\.app\.extension · still running/ })).toBeDefined()

    // The cache goes; the container stays, with the reason
    await ui.press({ key: 'mark-1' })
    await ui.press({ key: 'trash' })
    expect(asked[0]).toMatch(/1 item\(s\)/)
    expect(calls.find(c => c[0] === '/usr/bin/trash')).toEqual(['/usr/bin/trash', H + '/Library/Caches/com.example.app'])
    expect(await ui.find({ text: /Skipped: "Example Extension" still running, so macOS protects 1 container/ })).toBeDefined()
    await ui.unmount()
  })
}
