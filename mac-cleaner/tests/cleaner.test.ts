import { describe, expect, test } from 'claude-code/testing'

import type { CleanItem } from '../types'
import {
  commonFolder,
  finderTrashScript,
  humanSize,
  isTrashable,
  mergeItems,
  parseDf,
  parseDu,
  parseFindings,
  rowLabel,
  rowPaths,
  tildify,
} from '../hooks/cleaner'

const H = '/Users/t'
const MB = 1024 * 1024

describe('what may be trashed', () => {
  test('caches, build output and things inside Downloads', async () => {
    expect(isTrashable(H + '/Library/Caches/com.spotify.client', H)).toBe(true)
    expect(isTrashable(H + '/Library/Developer/Xcode/DerivedData', H)).toBe(true)
    expect(isTrashable(H + '/.gradle/caches', H)).toBe(true)
    expect(isTrashable(H + '/Downloads/big.dmg', H)).toBe(true)
  })

  test('never the home folder, top-level folders, or parents of protected places', async () => {
    expect(isTrashable(H, H)).toBe(false)
    expect(isTrashable(H + '/Downloads', H)).toBe(false)
    expect(isTrashable(H + '/Library', H)).toBe(false)
    expect(isTrashable(H + '/Library/Caches', H)).toBe(false)
    expect(isTrashable(H + '/.gradle', H)).toBe(false)
  })

  test('never iCloud, Mail, Photos, keys or anything outside home', async () => {
    expect(isTrashable(H + '/Library/Mobile Documents/com~apple~CloudDocs/x', H)).toBe(false)
    expect(isTrashable(H + '/Library/Mail/V10', H)).toBe(false)
    expect(isTrashable(H + '/Pictures/Photos Library.photoslibrary', H)).toBe(false)
    expect(isTrashable(H + '/Library/Keychains/login.keychain-db', H)).toBe(false)
    expect(isTrashable(H + '/.ssh/id_ed25519', H)).toBe(false)
    expect(isTrashable(H + '/Library/Containers/com.docker.docker', H)).toBe(false)
    expect(isTrashable('/System/Library/Caches', H)).toBe(false)
    expect(isTrashable('/Users/other/Library/Caches/x', H)).toBe(false)
    expect(isTrashable(H + 'x/Library/Caches/y', H)).toBe(false)
    expect(isTrashable(H + '/Library/Caches/../Keychains', H)).toBe(false)
  })
})

describe('parsing', () => {
  test('du -sk', async () => {
    expect(parseDu(`2048\t${H}/Library/Logs\n10\t${H}/.npm/_cacache/\n`)).toEqual({
      [H + '/Library/Logs']: 2048 * 1024,
      [H + '/.npm/_cacache']: 10 * 1024,
    })
  })

  test('df -k', async () => {
    const out =
      'Filesystem   1024-blocks      Used Available Capacity iused ifree %iused  Mounted on\n' +
      '/dev/disk3s5   482797652 300000000 150000000    67% 1 2 0%   /System/Volumes/Data\n'
    expect(parseDf(out)).toEqual({ total: 482797652 * 1024, free: 150000000 * 1024 })
  })

  test("Claude's findings: valid rows kept, protected or malformed rows dropped", async () => {
    const text = JSON.stringify({
      items: [
        { path: '~/Downloads/old.iso', sizeBytes: 4e9, category: 'Downloads', risk: 'review', reason: 'Old installer' },
        { path: H + '/Library/Mail/V10', sizeBytes: 9e9, risk: 'safe' },
        { path: H, sizeBytes: 1 },
        { nope: true },
        { path: H + '/Movies/clip.mov', sizeBytes: 'x', risk: 'banana' },
      ],
    })
    const items = parseFindings(text, H)
    expect(items.map(i => i.path)).toEqual([H + '/Downloads/old.iso', H + '/Movies/clip.mov'])
    expect(items[1]?.risk).toBe('review')
    expect(items[1]?.size).toBe(0)
    expect(parseFindings('not json', H)).toEqual([])
  })
})

describe('merging', () => {
  test('one row per path, nested rows dropped, small scan rows hidden, safe first', async () => {
    const scan = [
      { path: H + '/Library/Logs', size: 50 * MB, category: 'Logs', risk: 'safe' as const, reason: '', source: 'scan' as const },
      { path: H + '/.gradle/caches', size: 900 * MB, category: 'Gradle', risk: 'safe' as const, reason: '', source: 'scan' as const },
      { path: H + '/.npm/_cacache', size: 1 * MB, category: 'npm', risk: 'safe' as const, reason: '', source: 'scan' as const },
    ]
    const claude = [
      { path: H + '/.gradle/caches/modules-2', size: 800 * MB, category: 'x', risk: 'safe' as const, reason: '', source: 'claude' as const },
      { path: H + '/Downloads/a.dmg', size: 2000 * MB, category: 'Downloads', risk: 'review' as const, reason: '', source: 'claude' as const },
    ]
    expect(mergeItems(scan, claude).map(i => i.path)).toEqual([
      H + '/.gradle/caches',
      H + '/Library/Logs',
      H + '/Downloads/a.dmg',
    ])
  })

  test('small scan rows are summed per category into one row once they add up', async () => {
    const cache = (name: string, mb: number) => ({
      path: H + '/Library/Caches/' + name,
      size: mb * MB,
      category: 'App caches',
      risk: 'safe' as const,
      reason: 'Cache files.',
      source: 'scan' as const,
    })
    const scan = [
      cache('big', 500),
      cache('a', 4),
      cache('b', 3),
      cache('c', 4),
      cache('empty', 0),
      { path: H + '/Library/Logs', size: 2 * MB, category: 'Logs', risk: 'safe' as const, reason: '', source: 'scan' as const },
    ]
    const claude = [
      { path: H + '/Downloads/x.zip', size: 1 * MB, category: 'Downloads', risk: 'review' as const, reason: '', source: 'claude' as const },
    ]
    const rows = mergeItems(scan, claude)
    // The big cache, one summary of 11 MB, Claude's tiny find; 2 MB of logs alone stays hidden
    expect(rows.map(r => r.path)).toEqual([H + '/Library/Caches/big', 'small:App caches', H + '/Downloads/x.zip'])
    const summary = rows[1] as CleanItem
    expect(summary.size).toBe(11 * MB)
    expect(summary.risk).toBe('safe')
    expect(summary.reason).toBe('Cache files.')
    expect(rowPaths(summary)).toEqual([H + '/Library/Caches/a', H + '/Library/Caches/c', H + '/Library/Caches/b'])
    expect(rowLabel(summary, H)).toBe('3 items under 10 MB in ~/Library/Caches')

    // Merging again (after Claude adds findings) gives the same rows, not a summary of a summary
    expect(mergeItems(rows.filter(r => r.source === 'scan'), claude)).toEqual(rows)
    // A Claude finding on one of the small paths is not counted twice
    const flagged = mergeItems(rows.filter(r => r.source === 'scan'), [
      { ...cache('a', 4), source: 'claude' as const },
    ])
    expect(flagged.find(r => r.path === 'small:App caches')?.members?.length).toBe(3)
    expect(flagged.some(r => r.path === H + '/Library/Caches/a')).toBe(false)
  })

  test('common folder of a summary row', async () => {
    expect(commonFolder([H + '/.gradle/caches/x', H + '/.gradle/wrapper/dists'])).toBe(H + '/.gradle')
    expect(commonFolder([H + '/Library/Caches/a'])).toBe(H + '/Library/Caches')
    expect(rowLabel({ path: H + '/Library/Logs', size: 1, category: '', risk: 'safe', reason: '', source: 'scan' }, H)).toBe(
      '~/Library/Logs',
    )
  })
})

describe('formatting', () => {
  test('Finder script quotes paths', async () => {
    expect(finderTrashScript(['/a "b".txt', '/c\\d'])).toBe(
      'tell application "Finder" to delete {POSIX file "/a \\"b\\".txt", POSIX file "/c\\\\d"}',
    )
  })

  test('sizes and ~ paths', async () => {
    expect(humanSize(0)).toBe('—')
    expect(humanSize(1536 * MB)).toBe('1.5 GB')
    expect(tildify(H + '/Library/Logs', H)).toBe('~/Library/Logs')
    expect(tildify('/tmp/x', H)).toBe('/tmp/x')
  })
})
