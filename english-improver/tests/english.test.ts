import { describe, expect, test } from 'claude-code/testing'

import { modeOf, noteLine, parseReply, proseOf, shouldCheck } from '../hooks/english'

describe('which prompts are checked', () => {
  test('a few words of prose', async () => {
    expect(shouldCheck('can i mark all here?')).toBe(true)
    expect(shouldCheck('please fix the bug in `src/app.ts`')).toBe(true)
  })

  test('not short replies, shell commands, memory notes or long pastes', async () => {
    expect(shouldCheck('yes')).toBe(false)
    expect(shouldCheck('go ahead')).toBe(false)
    expect(shouldCheck('!git status --short')).toBe(false)
    expect(shouldCheck('# always use pnpm here')).toBe(false)
    expect(shouldCheck('why this fail ' + 'x'.repeat(2100))).toBe(false)
    expect(shouldCheck('```\nconst a = 1\nconst b = 2\nconst c = 3\n```')).toBe(false)
  })

  test("code blocks don't count toward a prompt's prose", async () => {
    expect(proseOf('why this fail?\n```ts\nconst x: number = "a"\n```\nhelp me')).toBe('why this fail?\n \nhelp me')
    expect(shouldCheck('why this fail?\n```\n' + 'log line\n'.repeat(400) + '```')).toBe(true)
  })
})

describe("reading the model's reply", () => {
  const original = 'can i mark all here?'

  test('a rewrite with notes', async () => {
    const reply = JSON.stringify({
      improved: 'Can I mark everything here?',
      notes: [
        { from: 'mark all', to: 'mark everything', why: '"all" alone sounds abrupt as an object' },
        { from: 'i', to: 'I', why: 'Always capitalized' },
      ],
    })
    expect(parseReply(reply, original)).toEqual({
      original,
      improved: 'Can I mark everything here?',
      notes: [
        { from: 'mark all', to: 'mark everything', why: '"all" alone sounds abrupt as an object' },
        { from: 'i', to: 'I', why: 'Always capitalized' },
      ],
    })
  })

  test('JSON wrapped in other text or a code fence still reads', async () => {
    const reply = 'Here you go:\n```json\n{"improved": "Can I mark everything here?", "notes": []}\n```'
    expect(parseReply(reply, original)?.improved).toBe('Can I mark everything here?')
  })

  test('nothing when it already reads naturally, or only case and a full stop changed', async () => {
    expect(parseReply('{"natural": true}', original)).toBeUndefined()
    expect(parseReply('{"improved": "Can I mark all here?"}', original)).toBeUndefined()
    expect(parseReply('{"improved": "fix the build."}', 'fix the build')).toBeUndefined()
  })

  test('nothing from a reply that is not the JSON asked for', async () => {
    expect(parseReply('Sure! Can I mark everything here?', original)).toBeUndefined()
    expect(parseReply('{"improved": 3}', original)).toBeUndefined()
    expect(parseReply('{not json}', original)).toBeUndefined()
  })

  test('at most three notes, and none that change nothing', async () => {
    const notes = [
      { from: 'a', to: 'a', why: '' },
      ...['b', 'c', 'd', 'e'].map(x => ({ from: x, to: x.toUpperCase(), why: '' })),
    ]
    const s = parseReply(JSON.stringify({ improved: 'Can I mark everything here?', notes }), original)
    expect(s?.notes.map(n => n.from)).toEqual(['b', 'c', 'd'])
  })

  test('a note as the band shows it', async () => {
    expect(noteLine({ from: 'mark all', to: 'mark everything', why: 'more natural' })).toBe('mark all → mark everything · more natural')
    expect(noteLine({ from: 'i', to: 'I', why: '' })).toBe('i → I')
  })
})

test('a stored mode, or show when there is none', async () => {
  expect(modeOf('rewrite')).toBe('rewrite')
  expect(modeOf('ask')).toBe('ask')
  expect(modeOf(undefined)).toBe('show')
  expect(modeOf('loud')).toBe('show')
})
