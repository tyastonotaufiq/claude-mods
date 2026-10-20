import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const REWRITE = JSON.stringify({
  improved: 'Can I mark everything here?',
  notes: [{ from: 'mark all', to: 'mark everything', why: '"all" alone sounds abrupt here' }],
})

// The engine beneath the plugin: prompts enter as given, the model answers
// with `reply` (null: the call timed out), and every request it gets is kept in `asked`.
function engine(on: any, asked: string[], reply: () => string | null = () => REWRITE, sent: string[] = []) {
  on('command.register', () => ({ value: { command: 'english-improver' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text }
  })
  // The engine's own band
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('model.complete', (_: unknown, e: { prompt: string }) => {
    asked.push(e.prompt)
    const text = reply()
    if (text === null) return { value: { isAnswered: false, reason: 'aborted', usage: {} } }
    return { value: { isAnswered: true, text, usage: {} } }
  })
  mock.store(on)
}

/**
 * A prompt as the person types it at the terminal. The check runs beside the
 * turn, after the prompt has gone on, so this waits a moment for it to land.
 */
async function type($: any, text: string) {
  const result = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await new Promise(r => (globalThis as any).setTimeout(r, 50))
  return result
}

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function mount($: any, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'english-improver', surface, component: 'AbovePrompt', props: BAND as never })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: sends the prompt unchanged and shows a more natural version`, async ($, on) => {
    const asked: string[] = []
    const sent: string[] = []
    engine(on, asked, undefined, sent)
    await start($)

    const result = await type($, 'can i mark all here?')
    expect(result).toMatchObject({ text: 'can i mark all here?' })
    expect(sent).toEqual(['can i mark all here?'])
    expect(asked[0]).toContain('can i mark all here?')

    const ui = await mount($, surface)
    expect(await ui.find({ text: /✎ Can I mark everything here\?/ })).toBeDefined()
    expect(await ui.find({ text: /mark all → mark everything · "all" alone sounds abrupt here/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: shows nothing when the prompt already reads naturally`, async ($, on) => {
    const asked: string[] = []
    engine(on, asked, () => '{"natural": true}')
    await start($)
    await type($, 'Can you run the tests again?')
    expect(asked).toHaveLength(1)

    const ui = await mount($, surface)
    expect(await ui.find({ text: /✎/ })).toBeUndefined()
    await ui.unmount()
  })
}

test("doesn't check short replies, or a plugin's own messages", async ($, on) => {
  const asked: string[] = []
  engine(on, asked)
  await start($)
  await type($, 'yes')
  await $.prompt.submit({ text: 'The build finished with two warnings.', wait: false, origin: { kind: 'plugin', name: 'ci' } })
  expect(asked).toEqual([])
})

test('/english-improver off stops checking and hides the band; on brings it back', async ($, on) => {
  const asked: string[] = []
  engine(on, asked)
  await start($)

  await type($, 'can i mark all here?')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: /✎/ })).toBeDefined()

  const off = await $.command.run({ command: 'english-improver', args: 'off' } as never)
  expect(off).toMatchObject({ text: expect.stringMatching(/English Improver is off/) })
  expect(await ui.find({ text: /✎/ })).toBeUndefined()
  await type($, 'how i can run this project?')
  expect(asked).toHaveLength(1)

  await $.command.run({ command: 'english-improver', args: 'on' } as never)
  await type($, 'how i can run this project?')
  expect(asked).toHaveLength(2)
  await ui.unmount()
})

/**
 * The person's answers to the mod's questions: which mode to switch to, and
 * in ask mode which prompt to send. Every question asked is kept in `asked`.
 */
function answers(on: any, picks: { mode?: string; send?: string }, asked: string[] = []) {
  on('tool.call', { tool: 'AskUserQuestion' }, async (_: unknown, e: any) => {
    const q = e.questions[0].question as string
    asked.push(q)
    const answer = q.startsWith('Send this instead?') ? picks.send : picks.mode
    if (!answer) throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [q]: answer } } } as never
  })
}

/** Switch mode from the band, which shows after a first prompt in show mode. */
async function switchMode($: any, ui: any) {
  await type($, 'can i mark all here?')
  await ui.press({ key: 'mode' })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the Mode button switches to rewrite, and Claude gets the improved prompt`, async ($, on) => {
    const sent: string[] = []
    engine(on, [], undefined, sent)
    answers(on, { mode: 'Rewrite, then send' })
    await start($)
    const ui = await mount($, surface)

    await switchMode($, ui)
    expect((await ui.find({ key: 'mode' }))?.text).toBe('Mode: Rewrite')

    await type($, 'can i mark all here?')
    expect(sent).toEqual(['can i mark all here?', 'Can I mark everything here?'])
    expect(await ui.find({ text: /Sent to Claude instead of what you typed/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: ask mode sends the improved prompt or yours, as picked`, async ($, on) => {
    const sent: string[] = []
    const questions: string[] = []
    const picks: { mode?: string; send?: string } = { mode: 'Ask each time' }
    engine(on, [], undefined, sent)
    answers(on, picks, questions)
    await start($)
    const ui = await mount($, surface)
    await switchMode($, ui)
    expect((await ui.find({ key: 'mode' }))?.text).toBe('Mode: Ask')

    picks.send = 'Send improved'
    await type($, 'can i mark all here?')
    expect(questions.at(-1)).toMatch(/^Send this instead\?\n\nCan I mark everything here\?\n\nmark all → mark everything/)
    expect(sent.at(-1)).toBe('Can I mark everything here?')

    picks.send = 'Send mine'
    await type($, 'can i mark all here?')
    expect(sent.at(-1)).toBe('can i mark all here?')
    // Still shown, to learn from, but not marked as sent
    expect(await ui.find({ text: /✎ Can I mark everything here\?/ })).toBeDefined()
    expect(await ui.find({ text: /Sent to Claude/ })).toBeUndefined()

    picks.send = undefined // dismissed: what they typed goes
    await type($, 'can i mark all here?')
    expect(sent.at(-1)).toBe('can i mark all here?')
    await ui.unmount()
  })
}

test('in rewrite mode, a prompt with code, or one that reads naturally, goes as typed', async ($, on) => {
  const sent: string[] = []
  let reply = REWRITE
  engine(on, [], () => reply, sent)
  answers(on, { mode: 'Rewrite, then send' })
  await start($)
  const ui = await mount($, 'terminal')
  await switchMode($, ui)

  const withCode = 'why this fail?\n```ts\nconst x: number = "a"\n```'
  await type($, withCode)
  expect(sent.at(-1)).toBe(withCode)
  expect(await ui.find({ text: /✎/ })).toBeDefined()
  expect(await ui.find({ text: /Sent to Claude/ })).toBeUndefined()

  reply = '{"natural": true}'
  await type($, 'Can you run the tests again?')
  expect(sent.at(-1)).toBe('Can you run the tests again?')
  await ui.unmount()
})

test('a check that times out in rewrite mode sends the prompt as typed', async ($, on) => {
  const sent: string[] = []
  let reply: string | null = REWRITE
  engine(on, [], () => reply, sent)
  answers(on, { mode: 'Rewrite, then send' })
  await start($)
  const ui = await mount($, 'terminal')
  await switchMode($, ui)

  reply = null
  await type($, 'how i can run this project?')
  expect(sent.at(-1)).toBe('how i can run this project?')
  await ui.unmount()
})
