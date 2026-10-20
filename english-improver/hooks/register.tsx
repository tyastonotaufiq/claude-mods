// english-improver: after each prompt the person sends, shows how a native
// speaker would write it, with a few short notes, in a band above the prompt.
//
// What happens to the prompt is the person's choice (the band's Mode button):
//  - show (the default): it goes to Claude as typed, at once, and the check
//    runs beside the turn on a small, fast model.
//  - rewrite: the prompt waits for the check and Claude gets the improved one.
//  - ask: the prompt waits for the check and the person picks which to send.
// A prompt with a code block, or a check that fails, is always sent as typed.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Mode, Suggestion } from '../types'
import { MODES, modeOf, noteLine, parseReply, proseOf, requestFor, shouldCheck, SYSTEM } from './english'

const MODEL = 'haiku'

const suggestion = atom({ plugin: 'english-improver', key: 'suggestion' } as const, null as Suggestion | null)
const enabled = atom({ plugin: 'english-improver', key: 'enabled' } as const, true)
const mode = atom({ plugin: 'english-improver', key: 'mode' } as const, 'show' as Mode)

type $ = EngineInterface

const SEND_IMPROVED = 'Send improved'
const SEND_MINE = 'Send mine'

/** Which check is the newest, so a slow reply to an older prompt never replaces a newer one. */
let latest = 0
let errorLogged = false

/** Words the person wrote: typed here, from their phone, or dictated through another plugin as theirs. */
function isPersons(origin: PromptOrigin | undefined): boolean {
  if (!origin) return false
  return origin.kind === 'composer' || origin.kind === 'bridge' || (origin.kind === 'plugin' && origin.asUser === true)
}

/**
 * Ask the model for a more natural version of `text`. Resolves the suggestion,
 * or undefined when the prompt already reads naturally, the call failed, or a
 * newer prompt came in meanwhile. A prompt that waits is held at most `timeoutMs`.
 */
async function check($: $, text: string, timeoutMs: number): Promise<Suggestion | undefined> {
  const id = ++latest
  await update($, suggestion, () => null)
  const prose = proseOf(text)
  const r = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: requestFor(prose),
    maxTokens: 800,
    effort: 'low',
    timeoutMs,
  })
  if (id !== latest) return undefined
  if (!r.isAnswered) {
    if (r.reason === 'api-error' && !errorLogged) {
      errorLogged = true
      $.ui.log(`English Improver could not reach ${MODEL} (${r.status ?? 'error'}); it will keep trying with each prompt.`)
    }
    return undefined
  }
  return parseReply(r.text, prose)
}

async function show($: $, s: Suggestion | undefined) {
  if (s) await update($, suggestion, () => s)
}

/** The question asked in ask mode: the improved prompt and what changed. */
function askText(s: Suggestion): string {
  return ['Send this instead?', '', s.improved, '', ...s.notes.map(noteLine)].join('\n').trim()
}

async function setEnabled($: $, on: boolean) {
  await $.store.set('enabled', on)
  await update($, enabled, () => on)
  if (!on) await update($, suggestion, () => null)
}

async function chooseMode($: $) {
  let picked: string
  try {
    picked = await $.ui.ask('What should happen to your prompt when there is a more natural version?', {
      header: 'English',
      options: MODES.map(m => m.label),
    })
  } catch {
    return // dismissed
  }
  const chosen = MODES.find(m => m.label === picked)?.mode
  if (!chosen) return
  await $.store.set('mode', chosen)
  await update($, mode, () => chosen)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('enabled')
    await update($, enabled, () => saved !== false)
    const savedMode = modeOf(await $.store.get('mode'))
    await update($, mode, () => savedMode)
    try {
      await $.command.register({
        name: 'english-improver',
        description: 'Turn English Improver on or off',
        argumentHint: '[on|off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/english-improver could not be registered: ' + (err instanceof Error ? err.message : String(err)))
    }
    return next(e)
  })

  on('command.run', { command: 'english-improver' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const want = arg === 'on' ? true : arg === 'off' ? false : !(await read($, enabled))
    await setEnabled($, want)
    return {
      text: want
        ? 'English Improver is on: after each prompt, a more natural version shows above the prompt box.'
        : 'English Improver is off. Run /english-improver to turn it back on.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !isPersons(e.origin) || !shouldCheck(e.text) || !(await read($, enabled))) {
      return next(e)
    }
    const m = await read($, mode)
    // A rewrite would lose the code blocks the check leaves out, so those are only shown
    if (m === 'show' || e.text.includes('```')) {
      void check($, e.text, 20_000).then(s => show($, s))
      return next(e)
    }

    $.ui.status('Improving your English…')
    const s = await check($, e.text, 10_000)
    $.ui.status(undefined)
    if (!s) return next(e)

    let useImproved = m === 'rewrite'
    if (m === 'ask') {
      try {
        useImproved = (await $.ui.ask(askText(s), { header: 'English', options: [SEND_IMPROVED, SEND_MINE] })) === SEND_IMPROVED
      } catch {
        useImproved = false // dismissed: send what they typed
      }
    }
    await show($, useImproved ? { ...s, sent: true } : s)
    return next(useImproved ? { ...e, text: s.improved } : e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, suggestion)
    if (e.props.hasSurvey || !s || !(await read($, enabled))) return next(e)
    const m = await read($, mode)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="green" wrap="wrap">{'✎ ' + s.improved}</Text>
        {s.notes.map((n, i) => (
          <Box key={'note-' + i}>
            <Text dimColor wrap="wrap">{'  ' + noteLine(n)}</Text>
          </Box>
        ))}
        {s.sent ? <Text dimColor wrap="wrap">{'  Sent to Claude instead of what you typed.'}</Text> : null}
        <Box flexDirection="row" columnGap={2}>
          <Button
            key="mode"
            label={'Mode: ' + (MODES.find(x => x.mode === m)?.short ?? m)}
            plain
            onPress={() => void chooseMode($)}
          />
          <Button key="dismiss" label="Dismiss" plain onPress={() => void update($, suggestion, () => null)} />
        </Box>
      </Box>
    )
  })
}
