import { describe as group, expect, test } from 'claude-code/testing'

import { caffeinateArgs, clockLabel, describe, parseApps, parseClockTime } from '../hooks/awake'

// 14:00 local time on a fixed day
const NOW = new Date(2026, 0, 15, 14, 0).getTime()
const at = (h: number, m: number, day = 15) => new Date(2026, 0, day, h, m).getTime()

// `lsappinfo list` as macOS prints it, cut down to the lines read
const LSAPPINFO = ` 1) "loginwindow" ASN:0x0-0x101:
    bundleID="com.apple.loginwindow"
    bundle path="/System/Library/CoreServices/loginwindow.app"
    pid = 415 token=[sess=100020 pid=415] type="UIElement" flavor=3
 2) "Finder" ASN:0x0-0x202:
    bundleID="com.apple.finder"
    bundle path="/System/Library/CoreServices/Finder.app"
    pid = 636 token=[sess=100020 pid=636] type="Foreground" flavor=3
 3) "Studio" ASN:0x0-0x303:
    bundleID="com.example.studio"
    bundle path="/Applications/Example Studio.app"
    pid = 612 token=[sess=100020 pid=612] type="Foreground" flavor=3
 4) "Studio" ASN:0x0-0x404:
    bundleID="com.example.studio"
    bundle path="/Applications/Example Studio.app"
    pid = 701 token=[sess=100020 pid=701] type="Foreground" flavor=3
 5) "Another App" ASN:0x0-0x505:
    bundleID="com.example.another"
    bundle path="/Applications/Another App.app"
    pid = 480 token=[sess=100020 pid=480] type="Foreground" flavor=3
 6) "ExampleAgent" ASN:0x0-0x606:
    bundleID="com.example.agent"
    bundle path="/Applications/Example Studio.app/Contents/Library/ExampleAgent.app"
    pid = 650 token=[sess=100020 pid=650] type="UIElement" flavor=3
 7) "exampled" ASN:0x0-0x707:
    bundleID=[ NULL ]
    bundle path="/usr/libexec/exampled"
    pid = 102 token=[sess=100020 pid=102] type="BackgroundOnly" flavor=3
 8) "example-emulator" ASN:0x0-0x808:
    bundleID=[ NULL ]
    bundle path="/Users/example/sdk/emulator/example-emulator"
    pid = 900 token=[sess=100020 pid=900] type="Foreground" flavor=3
`

group('caffeinate arguments', () => {
  test('until stopped keeps the display awake too, unless it may sleep', () => {
    expect(caffeinateArgs({}, false, NOW)).toEqual(['-i', '-d'])
    expect(caffeinateArgs({}, true, NOW)).toEqual(['-i'])
  })

  test('a timed session ends after the seconds left, at least one', () => {
    expect(caffeinateArgs({ endsAt: NOW + 3_600_000 }, false, NOW)).toEqual(['-i', '-d', '-t', '3600'])
    expect(caffeinateArgs({ endsAt: NOW - 5 }, true, NOW)).toEqual(['-i', '-t', '1'])
  })

  test('while an app runs waits on its pid', () => {
    expect(caffeinateArgs({ app: { name: 'Example Studio', pid: 4242 } }, true, NOW)).toEqual(['-i', '-w', '4242'])
  })
})

group('running apps', () => {
  test('only apps with a Dock icon, named after their bundle, without Finder, sorted by name', () => {
    expect(parseApps(LSAPPINFO)).toEqual([
      { name: 'Another App', pid: 480 },
      { name: 'Example Studio', pid: 612 },
      { name: 'example-emulator', pid: 900 },
    ])
  })
})

group('times typed by the person', () => {
  test('24-hour and am/pm times, later today', () => {
    expect(parseClockTime('18:30', NOW)).toBe(at(18, 30))
    expect(parseClockTime('6:30 pm', NOW)).toBe(at(18, 30))
    expect(parseClockTime('6PM', NOW)).toBe(at(18, 0))
    expect(parseClockTime('18.05', NOW)).toBe(at(18, 5))
    expect(parseClockTime('23', NOW)).toBe(at(23, 0))
  })

  test('a time already past today is tomorrow', () => {
    expect(parseClockTime('8:00', NOW)).toBe(at(8, 0, 16))
    expect(parseClockTime('12 am', NOW)).toBe(at(0, 0, 16))
    expect(parseClockTime('14:00', NOW)).toBe(at(14, 0, 16))
  })

  test('anything else is not a time', () => {
    for (const text of ['', 'soon', '24:00', '18:60', '13 pm', '0 am', '1h']) expect(parseClockTime(text, NOW)).toBeUndefined()
  })
})

group('what a session says', () => {
  test('until a time today or tomorrow, while an app runs, or until stopped', () => {
    expect(clockLabel(at(9, 5), NOW)).toBe('09:05')
    expect(describe({ startedAt: NOW, endsAt: at(18, 30) }, NOW)).toBe('until 18:30')
    expect(describe({ startedAt: NOW, endsAt: at(8, 0, 16) }, NOW)).toBe('until tomorrow 08:00')
    expect(describe({ startedAt: NOW, app: { name: 'Example Studio', pid: 1 } }, NOW)).toBe('while Example Studio runs')
    expect(describe({ startedAt: NOW }, NOW)).toBe('until you stop it')
  })
})
