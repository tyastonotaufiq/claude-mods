// english-improver: after each prompt the person sends, shows how a native
// speaker would write it, with a few short notes, in a band above the prompt.
//
// What happens to the prompt is the person's choice (the band's Mode button):
//  - show (the default): it goes to Claude as typed, at once, and the check
//    runs beside the turn on a small, fast model.
//  - rewrite: the prompt waits for the check and Claude gets the improved one.
//  - ask: the prompt waits for the check and the person picks which to send.
// A prompt with a code block, or a check that fails, is always sent as typed.
//
// `/english-improver page` gives the person's own English Improver page on
// claude.ai, for writing outside Claude Code, publishing page/english-improver.html
// to their account the first time.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Mode, Suggestion } from '../types'
import {
  findPage,
  findPageInJson,
  MODES,
  modeOf,
  noteLine,
  parseReply,
  proseOf,
  publishedUrl,
  requestFor,
  shouldCheck,
  slugIn,
  SYSTEM,
  versionIn,
} from './english'

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
  const id = latest
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

/** Runs a tool for /english-improver page, named as what the person asked for in the permission check. */
async function run($: $, input: Record<string, unknown>): Promise<string> {
  const r = await $.tool.call({ ...input, consent: 'The user ran /english-improver page' } as never)
  if (r.deny !== undefined) throw new Error(r.deny)
  if (r.isError) throw new Error(r.text ?? String(input.tool) + ' failed')
  return r.text ?? ''
}

const CONNECTOR = 'mcp__claude-artifacts__'
const TITLE = 'English Improver'
const DESCRIPTION = 'Paste any text and see how a native speaker would write it, with a note on each change.'

/**
 * The person's own English Improver page on claude.ai, for writing outside
 * Claude Code: the one they already have, else page/english-improver.html
 * published to their account as a new one. Through Claude Code's own Artifact
 * tool where the session has it, else through the claude.ai artifacts connector.
 */
async function pageUrl($: $): Promise<string> {
  const page = `${$.plugin.root}/page/english-improver.html`
  const tools = (await $.tool.list()).map(t => t.name)
  if (tools.includes('Artifact')) {
    const found = findPage(await run($, { tool: 'Artifact', action: 'list', limit: 200 }))
    if (found) return found
    // The Artifact tool publishes only a file it has seen read
    await run($, { tool: 'Read', file_path: page })
    const answer = await run($, { tool: 'Artifact', action: 'publish', file_path: page, icon: 'edit', description: DESCRIPTION, capabilities: { sample: {} } })
    const url = publishedUrl(answer)
    if (!url) throw new Error('the page was published, but its link was not in the answer')
    return url
  }
  if (!tools.includes(CONNECTOR + 'publish_version')) {
    throw new Error('this session has neither the Artifact tool nor the claude.ai artifacts connector. Sign in to Claude Code with your Claude account.')
  }
  const list = () => run($, { tool: CONNECTOR + 'list_artifacts', limit: 200 })
  const found = findPageInJson(await list())
  if (found) return found
  const content = '<!DOCTYPE html>\n' + (await $.fs.read(page))
  const slug = slugIn(await run($, { tool: CONNECTOR + 'publish_version', title: TITLE, icon: 'edit', content }))
  if (!slug) throw new Error('the page was published, but its id was not in the answer')
  // The page asks Claude to check the text, so it declares `sample`
  const version = versionIn(await run($, { tool: CONNECTOR + 'read_declaration', slug }))
  if (!version) throw new Error('the page was published, but its version could not be read')
  await run($, { tool: CONNECTOR + 'declare_capabilities', slug, base_version: version, capabilities: { sample: {} } })
  const url = findPageInJson(await list())
  if (!url) throw new Error('the page was published, but its link was not in your list')
  return url
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
        argumentHint: '[on|off|page]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('/english-improver could not be registered: ' + (err instanceof Error ? err.message : String(err)))
    }
    return next(e)
  })

  on('command.run', { command: 'english-improver' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'page') {
      try {
        const url = await pageUrl($)
        return { text: 'Your English Improver page, for emails, messages and anything else you write: ' + url }
      } catch (err) {
        return { text: 'Could not find or set up your English Improver page: ' + (err instanceof Error ? err.message : String(err)) }
      }
    }
    const want = arg === 'on' ? true : arg === 'off' ? false : !(await read($, enabled))
    await setEnabled($, want)
    return {
      text: want
        ? 'English Improver is on: after each prompt, a more natural version shows above the prompt box.'
        : 'English Improver is off. Run /english-improver to turn it back on.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || !isPersons(e.origin)) return next(e)
    // Any new prompt of theirs hides the last suggestion, and drops a reply still coming for it
    latest++
    await update($, suggestion, () => null)
    if (e.command || !shouldCheck(e.text) || !(await read($, enabled))) return next(e)
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
        <Button
          key="mode"
          label={'Mode: ' + (MODES.find(x => x.mode === m)?.short ?? m)}
          plain
          onPress={() => void chooseMode($)}
        />
      </Box>
    )
  })
}
