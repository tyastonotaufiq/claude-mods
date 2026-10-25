import { describe, expect, test } from 'claude-code/testing'

import type { AppInfo, Leftover } from '../types'
import {
  explainTrashError,
  extensionStatus,
  findOrphans,
  idsIn,
  isContainer,
  isRemovableApp,
  isRemovableLeftover,
  isSystemApp,
  markedByDefault,
  matchesQuery,
  matchLeftover,
  mergeLeftovers,
  ownerById,
  parseFindings,
  parseInfoPlist,
  parseSystemExtensions,
  PLACES,
  runningExtensionOf,
  strayExtensions,
} from '../hooks/uninstaller'

const H = '/Users/t'
const place = (rel: string) => PLACES.find(p => p.rel === rel)!

const slack: AppInfo = {
  path: '/Applications/Slack.app',
  id: 'com.tinyspeck.slackmacgap',
  name: 'Slack',
  version: '4.41',
  names: ['Slack'],
}
const chrome: AppInfo = { path: '/Applications/Google Chrome.app', id: 'com.google.Chrome', name: 'Google Chrome', version: '130', names: ['Chrome'] }
const canary: AppInfo = {
  path: '/Applications/Google Chrome Canary.app',
  id: 'com.google.Chrome.canary',
  name: 'Google Chrome Canary',
  version: '132',
  names: ['Chrome Canary'],
}

describe('what may be moved to the Trash', () => {
  test('apps in /Applications, ~/Applications, and one folder down', async () => {
    expect(isRemovableApp('/Applications/Slack.app', H)).toBe(true)
    expect(isRemovableApp(H + '/Applications/Tool.app', H)).toBe(true)
    expect(isRemovableApp('/Applications/Example Studio 2025/Example Studio 2025.app', H)).toBe(true)
  })

  test('never anything else as an app', async () => {
    expect(isRemovableApp('/Applications', H)).toBe(false)
    expect(isRemovableApp('/Applications/Example Studio 2025', H)).toBe(false)
    expect(isRemovableApp('/System/Applications/Notes.app', H)).toBe(false)
    expect(isRemovableApp('/Applications/Xcode.app/Contents/Applications/Simulator.app', H)).toBe(false)
    expect(isRemovableApp('/Applications/../System/Applications/Mail.app', H)).toBe(false)
    expect(isRemovableApp(H + '/Downloads/Thing.app', H)).toBe(false)
  })

  test('leftovers directly inside the places apps write to', async () => {
    expect(isRemovableLeftover(H + '/Library/Caches/com.tinyspeck.slackmacgap', H)).toBe(true)
    expect(isRemovableLeftover(H + '/Library/Preferences/com.tinyspeck.slackmacgap.plist', H)).toBe(true)
    expect(isRemovableLeftover(H + '/Library/Preferences/ByHost/com.x.y.ABC.plist', H)).toBe(true)
    expect(isRemovableLeftover(H + '/Library/Containers/com.x.y', H)).toBe(true)
    expect(isRemovableLeftover(H + '/.vscode', H)).toBe(true)
    expect(isRemovableLeftover(H + '/.config/gh', H)).toBe(true)
  })

  test('never the places themselves, deeper files, or keys and shell setup', async () => {
    expect(isRemovableLeftover(H + '/Library/Caches', H)).toBe(false)
    expect(isRemovableLeftover(H + '/Library/Preferences/ByHost', H)).toBe(false)
    expect(isRemovableLeftover(H + '/Library/Caches/com.x.y/data', H)).toBe(false)
    expect(isRemovableLeftover(H + '/Library/Keychains/login.keychain-db', H)).toBe(false)
    expect(isRemovableLeftover(H + '/Library/Mail/V10', H)).toBe(false)
    expect(isRemovableLeftover(H + '/Documents/thesis', H)).toBe(false)
    expect(isRemovableLeftover(H + '/.ssh', H)).toBe(false)
    expect(isRemovableLeftover(H + '/.zshrc', H)).toBe(false)
    expect(isRemovableLeftover(H + '/.config', H)).toBe(false)
    expect(isRemovableLeftover(H + '/Library/Caches/../Keychains', H)).toBe(false)
    expect(isRemovableLeftover('/Library/Caches/com.x.y', H)).toBe(false)
    expect(isRemovableLeftover('/Users/other/Library/Caches/com.x.y', H)).toBe(false)
  })

  test('macOS apps are never offered', async () => {
    expect(isSystemApp({ path: '/Applications/Safari.app', id: 'com.apple.Safari' })).toBe(true)
    expect(isSystemApp({ path: '/System/Applications/Notes.app', id: 'com.apple.Notes' })).toBe(true)
    expect(isSystemApp({ path: '/Applications/Xcode.app', id: 'com.apple.dt.Xcode' })).toBe(false)
  })
})

describe('matching files to apps', () => {
  test('bundle IDs inside file names', async () => {
    expect(idsIn('com.x.y.plist')).toEqual(['com.x.y'])
    expect(idsIn('group.com.x.y')).toEqual(['group.com.x.y', 'com.x.y'])
    expect(idsIn('ABCDE12345.com.x.y')).toEqual(['abcde12345.com.x.y', 'com.x.y'])
  })

  test('the longest installed ID owns a file', async () => {
    const ids = [chrome.id, canary.id]
    expect(ownerById('com.google.Chrome', ids)).toBe('com.google.chrome')
    expect(ownerById('com.google.Chrome.canary.plist', ids)).toBe('com.google.chrome.canary')
    expect(ownerById('com.google.Chrome.helper', ids)).toBe('com.google.chrome')
    expect(ownerById('com.google.Chromebook', ids)).toBeUndefined()
  })

  test('by ID anywhere, by name only where apps use names', async () => {
    const installed = [slack, chrome, canary]
    expect(matchLeftover('com.tinyspeck.slackmacgap', place('Library/Containers'), slack, installed)).toBe('id')
    expect(matchLeftover('com.tinyspeck.slackmacgap.savedState', place('Library/Saved Application State'), slack, installed)).toBe('id')
    expect(matchLeftover('Slack', place('Library/Application Support'), slack, installed)).toBe('name')
    expect(matchLeftover('Slack', place('Library/Containers'), slack, installed)).toBeUndefined()
    expect(matchLeftover('Slacker', place('Library/Application Support'), slack, installed)).toBeUndefined()
  })

  test("Chrome's files aren't Canary's, and a shared name belongs to nobody", async () => {
    const installed = [chrome, canary]
    expect(matchLeftover('com.google.Chrome.canary', place('Library/Caches'), chrome, installed)).toBeUndefined()
    expect(matchLeftover('com.google.Chrome.canary', place('Library/Caches'), canary, installed)).toBe('id')
    const twin = { ...slack, path: '/Applications/Slack Beta.app', id: 'com.tinyspeck.beta' }
    expect(matchLeftover('Slack', place('Library/Application Support'), slack, [slack, twin])).toBeUndefined()
  })

  test('ID matches are marked; name matches and shared containers are not', async () => {
    const rows: Leftover[] = [
      { path: slack.path, size: 0, place: 'App', match: 'app', reason: '' },
      { path: H + '/Library/Caches/com.tinyspeck.slackmacgap', size: 0, place: 'Cache', match: 'id', reason: '' },
      { path: H + '/Library/Application Support/Slack', size: 0, place: 'App data', match: 'name', reason: '' },
      { path: H + '/Library/Group Containers/X.com.tinyspeck', size: 0, place: 'Shared container', match: 'id', reason: '', shared: true },
      { path: H + '/.slack', size: 0, place: 'Found by Claude', match: 'claude', reason: '' },
    ]
    expect(markedByDefault(rows)).toEqual([slack.path, H + '/Library/Caches/com.tinyspeck.slackmacgap'])
  })
})

describe('leftovers of removed apps', () => {
  test('grouped by ID, without Apple, installed apps or their developers', async () => {
    const children = [
      { path: H + '/Library/Caches/com.spotify.client', place: place('Library/Caches') },
      { path: H + '/Library/Preferences/com.spotify.client.plist', place: place('Library/Preferences') },
      { path: H + '/Library/Preferences/com.apple.finder.plist', place: place('Library/Preferences') },
      { path: H + '/Library/Preferences/com.google.Keystone.Agent.plist', place: place('Library/Preferences') },
      { path: H + '/Library/Caches/com.tinyspeck.slackmacgap', place: place('Library/Caches') },
      { path: H + '/Library/Application Support/Spotify', place: place('Library/Application Support') },
    ]
    const orphans = findOrphans(children, [slack.id, chrome.id])
    expect(orphans).toEqual([
      {
        id: 'com.spotify.client',
        paths: [H + '/Library/Caches/com.spotify.client', H + '/Library/Preferences/com.spotify.client.plist'],
        places: ['Cache', 'Settings'],
        size: 0,
      },
    ])
  })
})

describe('system extensions', () => {
  // `systemextensionsctl list` as macOS 26 prints it
  const out = [
    '4 extension(s)',
    "--- com.apple.system_extension.network_extension (Go to 'System Settings > General > Login Items & Extensions > Network Extensions' to modify these system extension(s))",
    'enabled\tactive\tteamID\tbundleID (version)\tname\t[state]',
    '*\t*\tSAMPLE1234\torg.sample.agent.nwextension (7.2.3/0822)\tprovider\t[activated enabled]',
    '\t*\tWIDGET1234\tnet.widget.client.extension (6.3.3-1121/1)\tWidget Extension\t[activated waiting for user]',
    '*\t*\tEXAMPLE123\tcom.example.app.extension (6.5.2/3624198.2610060731)\tExample Extension\t[activated enabled]',
    '\t\tEXAMPLE123\tcom.example.app.helper (6.4.0/2903266.2602091446)\tExample Helper\t[terminated waiting to uninstall on reboot]',
  ].join('\n')
  const exts = parseSystemExtensions(out)

  test('parsed one per row, the header and notes skipped', async () => {
    expect(exts.map(x => [x.id, x.name, x.active])).toEqual([
      ['org.sample.agent.nwextension', 'provider', true],
      ['net.widget.client.extension', 'Widget Extension', true],
      ['com.example.app.extension', 'Example Extension', true],
      ['com.example.app.helper', 'Example Helper', false],
    ])
    expect(exts.map(extensionStatus)).toEqual(['still running', 'still running', 'still running', 'removed when you restart'])
  })

  test("listed when no installed app owns them, nor one from the same developer", async () => {
    const stray = strayExtensions(exts, ['com.example.app', 'net.widget.desktop'])
    expect(stray.map(x => x.name)).toEqual(['provider'])
  })

  test("a removed app's running extension holds its containers", async () => {
    expect(runningExtensionOf('com.example.app', exts)?.name).toBe('Example Extension')
    expect(runningExtensionOf('com.example', exts)?.name).toBe('Example Extension')
    expect(runningExtensionOf('com.spotify.client', exts)).toBeUndefined()
    expect(isContainer(H + '/Library/Containers/com.example.app')).toBe(true)
    expect(isContainer(H + '/Library/Group Containers/EXAMPLE123.group.com.example.app')).toBe(true)
    expect(isContainer(H + '/Library/Caches/com.example.app')).toBe(false)
  })

  test("Finder's -5000 in words", async () => {
    const raw = "29:108: execution error: Finder got an error: The operation can't be completed because you don't have the necessary permission. (-5000)"
    expect(explainTrashError(raw)).toBe('macOS refused permission (Finder error -5000).')
    expect(explainTrashError('something else')).toBe('something else')
  })
})

describe('parsing', () => {
  test('an Info.plist as JSON', async () => {
    const app = parseInfoPlist(
      JSON.stringify({ CFBundleIdentifier: 'com.microsoft.VSCode', CFBundleName: 'Code', CFBundleShortVersionString: '1.95.0' }),
      '/Applications/Visual Studio Code.app',
    )
    expect(app).toEqual({
      path: '/Applications/Visual Studio Code.app',
      id: 'com.microsoft.VSCode',
      name: 'Visual Studio Code',
      version: '1.95.0',
      names: ['Code'],
    })
    expect(parseInfoPlist('{}', '/Applications/X.app')).toBeUndefined()
    expect(parseInfoPlist('not json', '/Applications/X.app')).toBeUndefined()
  })

  test("Claude's findings: this app only, removable only, never another app's container", async () => {
    const text = JSON.stringify({
      app: 'com.tinyspeck.slackmacgap',
      items: [
        { path: '~/.slack', sizeBytes: 2048, reason: 'CLI settings' },
        { path: '~/.ssh', sizeBytes: 10 },
        { path: '~/Library/Containers/com.other.app', sizeBytes: 10 },
        { path: '~/Library/Containers/com.tinyspeck.slackmacgap.helper', sizeBytes: 10 },
      ],
    })
    expect(parseFindings(text, 'com.tinyspeck.slackmacgap', H).map(l => l.path)).toEqual([
      H + '/.slack',
      H + '/Library/Containers/com.tinyspeck.slackmacgap.helper',
    ])
    expect(parseFindings(text, 'com.other.app', H)).toEqual([])
  })

  test('merging keeps one row per path and nothing nested', async () => {
    const row = (path: string, match: Leftover['match']): Leftover => ({ path, size: 0, place: '', match, reason: '' })
    const merged = mergeLeftovers(
      [row(H + '/.slack', 'id')],
      [row(H + '/.slack', 'claude'), row(H + '/.slack/logs', 'claude')],
    )
    expect(merged).toEqual([row(H + '/.slack', 'id')])
  })

  test('search by name or bundle ID', async () => {
    expect(matchesQuery(slack, 'sla')).toBe(true)
    expect(matchesQuery(slack, 'tinyspeck')).toBe(true)
    expect(matchesQuery(slack, 'zoom')).toBe(false)
    expect(matchesQuery(slack, '  ')).toBe(true)
  })
})

describe('what counts as a bundle ID', () => {
  test('group and team prefixes come off in turn', async () => {
    expect(idsIn('group.U5SR49N3PT.only.if.Amphetamine')).toEqual([
      'group.u5sr49n3pt.only.if.amphetamine',
      'u5sr49n3pt.only.if.amphetamine',
      'only.if.amphetamine',
    ])
  })

  test("log files, cache names and Apple's Shortcuts aren't removed apps", async () => {
    const children = ['warp.log.old.1', 'main.kts.compiled.cache', 'is.workflow.shortcuts', 'groups.com.apple.podcasts', 'net.whatsapp.whatsapp'].map(
      name => ({ path: H + '/Library/Caches/' + name, place: place('Library/Caches') }),
    )
    expect(findOrphans(children, []).map(o => o.id)).toEqual(['net.whatsapp.whatsapp'])
  })
})

test("an app's helpers share its row", async () => {
  const children = [
    { path: H + '/Library/Containers/net.whatsapp.whatsapp.intents', place: place('Library/Containers') },
    { path: H + '/Library/Containers/net.whatsapp.whatsapp', place: place('Library/Containers') },
    { path: H + '/Library/Application Scripts/net.whatsapp.whatsapp.shared', place: place('Library/Application Scripts') },
    { path: H + '/Library/Containers/net.whatsapp.whatsappsmb', place: place('Library/Containers') },
  ]
  expect(findOrphans(children, [])).toEqual([
    {
      id: 'net.whatsapp.whatsapp',
      paths: [
        H + '/Library/Containers/net.whatsapp.whatsapp',
        H + '/Library/Application Scripts/net.whatsapp.whatsapp.shared',
        H + '/Library/Containers/net.whatsapp.whatsapp.intents',
      ],
      places: ['Container', 'App scripts'],
      size: 0,
    },
    { id: 'net.whatsapp.whatsappsmb', paths: [H + '/Library/Containers/net.whatsapp.whatsappsmb'], places: ['Container'], size: 0 },
  ])
})
