import { describe, expect, test } from 'claude-code/testing'

import {
  adbCandidates,
  baseName,
  deleteCommand,
  humanSize,
  infoLine,
  isDeletable,
  joinPath,
  parentPath,
  parseDevices,
  parseDroppedPaths,
  parseInfo,
  parseList,
  parseSizes,
  shQuote,
  trashCommand,
} from '../hooks/adb'

describe('adb helpers', () => {
  test('parses adb devices -l', async () => {
    const out = [
      'List of devices attached',
      'R5CT1234ABC    device usb:1-1 product:a54xns model:SM_A546E device:a54x transport_id:3',
      'emulator-5554  unauthorized transport_id:1',
      '',
    ].join('\n')
    expect(parseDevices(out)).toEqual([
      { serial: 'R5CT1234ABC', state: 'device', model: 'SM A546E' },
      { serial: 'emulator-5554', state: 'unauthorized', model: 'emulator-5554' },
    ])
  })

  test('parses device info for the header', async () => {
    // A Galaxy on charge, with \r\n line ends like older adb shells
    const phone = [
      'name=Galaxy A54 5G',
      'release=14',
      'sdk=34',
      'df=/dev/fuse 115343360 80740352 34603008 70% /storage/emulated',
      '  status: 2',
      '  level: 64',
      '',
    ].join('\r\n')
    const info = parseInfo(phone)
    expect(info).toEqual({
      name: 'Galaxy A54 5G',
      release: '14',
      sdk: '34',
      totalBytes: 115343360 * 1024,
      freeBytes: 34603008 * 1024,
      battery: 64,
      charging: true,
    })
    expect(infoLine(info)).toBe('Android 14 (API 34) · 33.0 GB free of 110 GB · Battery 64%, charging')

    // The emulator: no marketing name, not charging
    const emu = parseInfo('name=\nrelease=16\nsdk=36\ndf=/dev/fuse 10474476 6710460 3145728 68% /storage/emulated\n  status: 4\n  level: 100\n')
    expect(emu.name).toBe('')
    expect(infoLine(emu)).toBe('Android 16 (API 36) · 3.0 GB free of 10.0 GB · Battery 100%')

    // Nothing answered: nothing to show
    expect(infoLine(parseInfo(''))).toBe('')
  })

  test('parses a folder listing, folders first, odd names intact', async () => {
    const out = [
      'regular file/2048/1700000000/b photo.jpg',
      'directory/3488/1700000000/DCIM',
      'directory/3488/1700000000/.',
      'directory/3488/1700000000/..',
      "regular file/10/1700000000/it's a -> file.txt\r",
      'directory/3488/1700000000/Android',
    ].join('\n')
    const list = parseList(out, '/sdcard')
    expect(list.map(e => e.name)).toEqual(['Android', 'DCIM', 'b photo.jpg', "it's a -> file.txt"])
    expect(list[1]).toEqual({ name: 'DCIM', path: '/sdcard/DCIM', isDir: true, size: 3488, mtime: 1700000000 })
  })

  test('parses du -sk output into bytes', async () => {
    expect(parseSizes('120\tDCIM\n4\t.thumbnails\n', '/sdcard')).toEqual({
      '/sdcard/DCIM': 120 * 1024,
      '/sdcard/.thumbnails': 4096,
    })
  })

  test('paths', async () => {
    expect(joinPath('/', 'sdcard')).toBe('/sdcard')
    expect(joinPath('/sdcard/', 'DCIM')).toBe('/sdcard/DCIM')
    expect(parentPath('/sdcard/DCIM/Camera')).toBe('/sdcard/DCIM')
    expect(parentPath('/sdcard')).toBe('/')
    expect(parentPath('/')).toBe('/')
  })

  test('quotes for the device shell, including single quotes', async () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(deleteCommand(['/sdcard/a b', "/sdcard/it's"])).toBe(`rm -rf -- '/sdcard/a b' '/sdcard/it'\\''s'`)
    expect(trashCommand(['/sdcard/x'], 'S')).toBe(`mkdir -p '/sdcard/_adb_trash/S' && mv -- '/sdcard/x' '/sdcard/_adb_trash/S'/`)
  })

  test('only allows deletes strictly inside user storage', async () => {
    expect(isDeletable('/sdcard/DCIM/a.jpg')).toBe(true)
    expect(isDeletable('/storage/emulated/0/Download')).toBe(true)
    expect(isDeletable('/sdcard')).toBe(false)
    expect(isDeletable('/sdcard/')).toBe(false)
    expect(isDeletable('/storage/emulated/0')).toBe(false)
    expect(isDeletable('/system/app')).toBe(false)
    expect(isDeletable('/data/local/tmp/x')).toBe(false)
    expect(isDeletable('/sdcard/../system')).toBe(false)
    expect(isDeletable('/sdcard/_adb_trash')).toBe(false)
    expect(isDeletable('/sdcardx/file')).toBe(false)
  })

  test('looks for adb in the Android SDK before PATH and Homebrew', async () => {
    expect(adbCandidates({ home: '/Users/me' })).toEqual([
      '/Users/me/Library/Android/sdk/platform-tools/adb',
      '/Users/me/Android/Sdk/platform-tools/adb',
      'adb',
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
    ])
    const custom = adbCandidates({ home: '/Users/me', androidHome: '/opt/sdk/', sdkRoot: '/opt/sdk' })
    expect(custom[0]).toBe('/opt/sdk/platform-tools/adb')
    expect(custom.filter(c => c === '/opt/sdk/platform-tools/adb')).toHaveLength(1)
    expect(custom[1]).toBe('/Users/me/Library/Android/sdk/platform-tools/adb')
  })

  test('human sizes', async () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(250 * 1024 * 1024)).toBe('250 MB')
  })

  test('parses paths dropped into the push field', async () => {
    const home = '/Users/me'
    // Terminal.app and iTerm2: backslash-escaped, trailing space
    expect(parseDroppedPaths('/Users/me/My\\ Photos ', home)).toEqual(['/Users/me/My Photos'])
    // Several files dropped at once
    expect(parseDroppedPaths('/a/one.jpg /a/two\\ 2.jpg', home)).toEqual(['/a/one.jpg', '/a/two 2.jpg'])
    // Quoted, single or double, and an apostrophe escaped inside a name
    expect(parseDroppedPaths(`'/a/My Photos' "/b/x y.mp4" /c/it\\'s.txt`, home)).toEqual([
      '/a/My Photos',
      '/b/x y.mp4',
      "/c/it's.txt",
    ])
    // file:// URLs and ~/
    expect(parseDroppedPaths('file:///Users/me/My%20Photos/ ~/Desktop/a.jpg', home)).toEqual([
      '/Users/me/My Photos/',
      '/Users/me/Desktop/a.jpg',
    ])
    expect(parseDroppedPaths("   ''  ", home)).toEqual([''])
    expect(parseDroppedPaths('   ', home)).toEqual([])
  })

  test('base names for messages', async () => {
    expect(baseName('/Users/me/My Photos/')).toBe('My Photos')
    expect(baseName('/a/b.jpg')).toBe('b.jpg')
  })
})
