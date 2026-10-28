import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { slugify, stripArxivPrefix, parseLoopArgs, parseSummarizeArgs, loopFollowupPrompt, buildPrompt, WORKFLOWS, SESSION_COMMANDS, THINKING_LEVELS } from '../prompts.js'
import { apply } from '../index.js'

// Every Feynman workflow slash command is mapped.
test('all Feynman workflow commands mapped', () => {
  for (const cmd of ['deepresearch', 'lit', 'review', 'audit', 'replicate', 'recipe', 'compare', 'draft', 'autoresearch']) {
    assert.ok(WORKFLOWS[cmd], `missing /${cmd}`)
    assert.ok(WORKFLOWS[cmd].prompt('x').length > 100, `/${cmd} prompt is a stub`)
  }
  assert.ok(WORKFLOWS['review-loop'], 'missing /review-loop')
  assert.ok(WORKFLOWS.log.prompt('').length > 100, 'log prompt is a stub and needs no argument')
  assert.match(WORKFLOWS.log.prompt('citation fixes'), /Focus this entry on: citation fixes/)
  assert.ok(WORKFLOWS.summarize.prompt(parseSummarizeArgs('paper.pdf')).length > 100, 'summarize prompt is a stub')
})

// Every Feynman session/utility command is mapped.
test('all session commands mapped', () => {
  for (const cmd of ['help', 'init', 'outputs', 'btw', 'thinking', 'keys', 'doctor', 'status']) {
    assert.ok(SESSION_COMMANDS[cmd], `missing /${cmd}`)
  }
  assert.ok(THINKING_LEVELS.includes('max') && THINKING_LEVELS.includes('off'))
})

// The composed brief carries live key refs and still assumes nothing else.
test('composed brief names key refs, nothing external', () => {
  for (const [cmd, spec] of Object.entries(WORKFLOWS)) {
    const arg = cmd === 'summarize' ? parseSummarizeArgs('sample input') : 'sample input'
    const p = spec.prompt(arg).toLowerCase()
    for (const term of ['sota', 'pmid']) {
      assert.ok(!p.includes(term), `/${cmd} prompt references "${term}" the model cannot know`)
    }
    assert.ok(p.includes('web_search') && p.includes('web_fetch'), `/${cmd} prompt names no concrete tools`)
  }
  const full = buildPrompt('recipe', 'finetune bert', { hfTokenEnv: 'MY_HF', alphaxivTokenEnv: 'MY_AX' }).toLowerCase()
  assert.ok(full.includes('my_hf') && full.includes('my_ax'), 'brief misses live key refs')
})
test('arxiv: prefix normalizes to the bare ID everywhere it matters', () => {
  assert.equal(stripArxivPrefix('arxiv:2401.12345'), '2401.12345')
  assert.equal(stripArxivPrefix('arXiv:2401.12345'), '2401.12345')
  assert.equal(stripArxivPrefix('2401.12345'), '2401.12345')
  assert.equal(stripArxivPrefix('attention is all you need'), 'attention is all you need')
  const prefixed = WORKFLOWS.review.prompt('arxiv:2401.12345')
  const bare = WORKFLOWS.review.prompt('2401.12345')
  assert.equal(prefixed, bare)
  assert.ok(!prefixed.includes('arxiv:'), 'prefix leaks into the brief')
  assert.equal(WORKFLOWS.audit.prompt('arxiv:2401.12345'), WORKFLOWS.audit.prompt('2401.12345'))
})
test('arxiv: prefixes normalize inside ID lists, flags survive', () => {
  assert.equal(stripArxivPrefix('arxiv:2401.12345 arxiv:2402.67890'), '2401.12345 2402.67890')
  assert.equal(stripArxivPrefix('scaling laws'), 'scaling laws')
  assert.equal(WORKFLOWS.compare.prompt('arxiv:2401.12345 arxiv:2402.67890'), WORKFLOWS.compare.prompt('2401.12345 2402.67890'))
  assert.ok(WORKFLOWS.draft.prompt('--from-session').includes('--from-session'), 'draft flag survives')
})
test('review names its plan and evidence artifacts', () => {
  const brief = WORKFLOWS.review.prompt('2401.12345')
  assert.ok(brief.includes('outputs/.plans/2401-12345-review-plan.md'), 'review plan path')
  assert.ok(brief.includes('outputs/.drafts/2401-12345-review-evidence.md'), 'review evidence path')
})
test('slugify + loop args', () => {
  assert.equal(slugify('Scaling Laws! 2024'), 'scaling-laws-2024')
  assert.deepEqual(parseLoopArgs('paper.pdf 5'), { target: 'paper.pdf', rounds: 5 })
  assert.deepEqual(parseLoopArgs('paper.pdf'), { target: 'paper.pdf', rounds: 3 })
  assert.deepEqual(parseLoopArgs(''), { target: '', rounds: 3 })
  assert.ok(loopFollowupPrompt('p', 2, 1).includes('round 2'))
})
test('summarize parses controls and quoted file paths, rejecting unsafe window settings', () => {
  const defaults = parseSummarizeArgs('paper.pdf')
  assert.deepEqual(defaults, { source: 'paper.pdf', windowSize: 6000, overlap: 500, tier1Threshold: 8000, tier2Threshold: 60000, unsupported: [], error: null })
  assert.deepEqual(parseSummarizeArgs('--window-size 4000 "papers/my  study.pdf" --overlap 100 --tier1-threshold 5000 --tier2-threshold 20000'), {
    source: 'papers/my  study.pdf', windowSize: 4000, overlap: 100, tier1Threshold: 5000, tier2Threshold: 20000, unsupported: [], error: null,
  })
  assert.equal(parseSummarizeArgs("'papers/my study.pdf' --overlap 0").source, 'papers/my study.pdf')
  for (const flags of ['--window-size', '--window-size nope', '--overlap -1', '--window-size 1.5', '--window-size 9007199254740992', '--window-size 0 --overlap 0', '--window-size 500', '--overlap 7000', '--tier1-threshold 0', '--tier2-threshold 8000', '--tier1-threshold 70000']) {
    assert.ok(parseSummarizeArgs(`paper.pdf ${flags}`).error, `invalid controls accepted: ${flags}`)
  }
  assert.equal(parseSummarizeArgs('--overlap 0').source, '')
  assert.deepEqual(parseSummarizeArgs('paper.pdf --invented').unsupported, ['--invented'])
})

test('summarize dispatcher validates before queuing and preserves attachments and resolved controls', async () => {
  let handler
  const messages = []
  const agent = { session: { id: 'summary' }, followup: (message) => messages.push(message) }
  apply({ effect: (fn) => fn(), commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: () => undefined }, {})
  for (const args of ['', '--overlap 0', 'paper.pdf --invented', 'paper.pdf --window-size 500', 'paper.pdf --tier1-threshold 0']) {
    const result = await handler({ rawInput: `summarize ${args}`, agent, attachments: [] })
    assert.equal(result.kind, 'error', result.text)
  }
  assert.equal(messages.length, 0, 'invalid settings queued work')
  const attachment = { type: 'image', attachment: { hash: 'h', mediaType: 'image/png' } }
  const result = await handler({ rawInput: 'summarize "papers/my study.pdf" --window-size 4000 --overlap 100', agent, attachments: [attachment] })
  assert.equal(result.kind, 'success')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].content[0], attachment)
  const brief = messages[0].content[1].text
  assert.match(brief, /single-source summary of "papers\/my study.pdf"/)
  assert.match(brief, /advancing by 3900 characters with 100 overlap/)
  assert.match(brief, /outputs\/papers-my-study-pdf-summary\.md/)
  const listed = await handler({ rawInput: 'outputs', agent, attachments: [] })
  assert.equal(listed.kind, 'success')
  assert.match(messages.at(-1).content[0].text, /\*-summary\.md summarize/)
})

test('upstream workflow contracts keep continuation, provenance, and evidence boundaries', () => {
  assert.match(buildPrompt('deepresearch', 'topic'), /continue immediately in the same turn/)
  assert.match(buildPrompt('deepresearch', 'show me the plan first'), /only when the user explicitly asked to review the plan first/)
  assert.match(buildPrompt('lit', 'topic'), /outputs\/topic-lit-review\.provenance\.md/)
  const research = buildPrompt('review', 'paper.pdf')
  assert.match(research, /two independent indexes/)
  assert.match(research, /launch receipt is not completion/)
  assert.match(research, /stored key alone does not establish that access/)
  assert.doesNotMatch(research, /Honk with Authorization/)
  const summary = buildPrompt('summarize', parseSummarizeArgs('paper.pdf'))
  assert.match(summary, /no external research/)
  assert.match(summary, /decoded Unicode characters, not bytes/)
  assert.match(summary, /missing\/failed chunks become explicit character-range coverage gaps/)
})

// Credential refs come from the row. `/feynman doctor` prints the live values.
test('volatile row refs unwrap before schema validation and stay live', async () => {
  let handler
  let hf = 'LIVE_HF'
  apply({
    effect: (fn) => { fn(); return () => {} },
    commands: { register: (definition) => { handler = definition.handler; return () => {} } },
    on: () => () => {},
    get: () => undefined,
    inject: () => {},
  }, { hfTokenEnv: { get: () => hf }, alphaxivTokenEnv: { get: () => 'LIVE_AX' } })
  const first = await handler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.match(first.text, /Hugging Face key \(LIVE_HF\)/)
  assert.match(first.text, /AlphaXiv key \(LIVE_AX\)/)
  hf = 'NEXT_HF'
  const second = await handler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.match(second.text, /Hugging Face key \(NEXT_HF\)/)
})
test('row config is the base for credential refs', async () => {
  let handler
  apply({
    effect: (fn) => { fn(); return () => {} },
    commands: { register: (definition) => { handler = definition.handler; return () => {} } },
    on: () => () => {},
    get: () => undefined,
    inject: () => {},
  }, { hfTokenEnv: 'CUSTOM_HF' })
  const result = await handler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Hugging Face key \(CUSTOM_HF\)/)
  assert.match(result.text, /AlphaXiv key \(ALPHAXIV_API_KEY\)/)
})
test('a credential ref that is not an env-var name fails at load', () => {
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    commands: { register: () => () => {} },
    on: () => () => {},
    get: () => undefined,
  }
  assert.throws(() => apply(ctx, { hfTokenEnv: 'HF TOKEN' }), /\[feynman\] hfTokenEnv must be an env-var name/)
  assert.throws(() => apply(ctx, { alphaxivTokenEnv: '' }), /\[feynman\] alphaxivTokenEnv must be an env-var name/)
  assert.throws(() => apply(ctx, { hfTokenEnv: 42 }), /\[feynman\]/)
})

test('one /feynman dispatcher covers every subcommand', async () => {
  const registered = []
  const followups = []
  const agent = { id: 'test-agent', session: { id: 'test-agent' }, followup: (m) => followups.push(m), inject: () => {} }
  apply({
    effect: (fn) => { fn(); return () => {} },
    commands: { register: (d) => { registered.push(d); return () => {} } },
    on: () => () => {},
    get: () => undefined,
  }, {})
  assert.equal(registered.length, 1)
  const feynman = registered[0]
  assert.equal(feynman.name, 'feynman')
  assert.equal(feynman.recordInput, false)
  const run = (rawInput) => feynman.handler({ rawInput, agent, attachments: [] })
  for (const sub of [...Object.keys(WORKFLOWS), ...Object.keys(SESSION_COMMANDS)]) {
    const result = await run(`${sub} sample input`)
    assert.ok(result && (result.kind === 'success' || result.kind === 'error'), `${sub}: bad kind`)
    assert.equal(typeof result.text, 'string', `${sub}: text must be a string`)
    if (result.kind === 'error') assert.ok(result.text.length > 0, `${sub}: empty error`)
  }
  const unknown = await run('frobnicate x')
  assert.equal(unknown.kind, 'error')
  const bare = await run('')
  assert.equal(bare.kind, 'success', 'bare /feynman shows help')
  assert.ok(followups.length > 0, 'workflow handlers queue model turns')
  // Steering messages carry identity and a plugin source, never a forged human one.
  for (const m of followups) {
    assert.equal(m.role, 'user')
    assert.equal(typeof m.id, 'string')
    assert.equal(m.source.kind, 'feynman')
    // Built through createUserMessage: deep-frozen for every consumer downstream.
    assert.ok(Object.isFrozen(m), 'queued message is frozen')
    assert.ok(Object.isFrozen(m.content), 'queued message content is frozen')
  }
  assert.equal(new Set(followups.map((m) => m.id)).size, followups.length, 'steering ids collide')
  // Doctor + status answer directly (no followup queued).
  const before = followups.length
  const doctor = await run('doctor')
  assert.equal(doctor.kind, 'success')
  assert.ok(doctor.text.includes('credentials store'), 'doctor covers active seams')
  const status = await run('status')
  assert.equal(status.kind, 'success')
  assert.ok(status.text.includes('setup summary'), 'status summarizes setup')
  assert.equal(followups.length, before, 'diagnostics queue no model turn')
})

test('upstream-retired commands are absent from catalogs/help and cannot queue work', async () => {
  let handler
  const messages = []
  const agent = { session: { id: 'removed' }, followup: (m) => messages.push(m), inject: (m) => messages.push(m) }
  apply({ effect: (fn) => fn(), commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: () => undefined }, {})
  const help = await handler({ rawInput: 'help', agent, attachments: [] })
  for (const sub of ['rank', 'paper', 'watch', 'jobs', 'preview', 'feynman-model', 'web-results']) {
    assert.equal(Object.hasOwn(WORKFLOWS, sub), false)
    assert.equal(Object.hasOwn(SESSION_COMMANDS, sub), false)
    assert.ok(!help.text.split('\n').some((line) => line.startsWith(`  ${sub} `) || line.startsWith(`  ${sub}:`)))
    const result = await handler({ rawInput: `${sub} sample`, agent, attachments: [] })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Unknown subcommand/)
    const attached = await handler({ rawInput: `${sub} sample`, agent, attachments: [{ type: 'text', text: 'keep me' }] })
    assert.equal(attached.kind, 'error', 'removed commands must leave attachments in the composer')
  }
  assert.equal(messages.length, 0)
})

// The registry hands admitted attachments to the handler, and a handler that
// cannot use them must return an error so the composer keeps the originals.
// A success here would drop the user's image or file without a trace.
test('subcommands that queue no message refuse attachments instead of dropping them', async () => {
  let handler
  const followups = []
  const injected = []
  const agent = { session: { id: 's' }, followup: (m) => followups.push(m), inject: (m) => injected.push(m) }
  apply({
    effect: (fn) => { fn(); return () => {} },
    commands: { register: (d) => { handler = d.handler; return () => {} } },
    on: () => () => {},
    get: () => undefined,
  }, {})
  const image = Object.freeze({ type: 'image', attachment: { hash: 'h', mediaType: 'image/png' } })
  const run = (rawInput) => handler({ rawInput, agent, attachments: [image] })
  for (const line of ['', 'help', 'doctor', 'status', 'keys', 'init',
    'thinking', 'thinking high', 'review-loop stop']) {
    const result = await run(line)
    assert.equal(result.kind, 'error', `/feynman ${line} dropped an attachment: ${result.text}`)
    assert.match(result.text, /attachments/)
  }
  assert.equal(followups.length + injected.length, 0, 'a refused invocation queued a message')
  // Every message-queuing subcommand carries the attachment into the model turn.
  for (const line of ['deepresearch x', 'review-loop paper.pdf 2', 'summarize paper.pdf', 'log', 'outputs', 'btw why']) {
    const result = await run(line)
    assert.equal(result.kind, 'success', `/feynman ${line}: ${result.text}`)
    const sent = [...followups, ...injected].at(-1)
    assert.equal(sent.content[0].type, 'image', `/feynman ${line} queued its message without the attachment`)
  }
})

test('review-loop clamps an out-of-range round count to the cap', async () => {
  let handler
  const followups = []
  const agent = { session: { id: 'clamp' }, followup: (m) => followups.push(m), inject: () => {} }
  apply({
    effect: (fn) => { fn(); return () => {} },
    commands: { register: (d) => { handler = d.handler; return () => {} } },
    on: () => () => {},
    get: () => undefined,
  }, {})
  const run = (rawInput) => handler({ rawInput, agent, attachments: [] })
  for (const [line, rounds] of [['review-loop paper.pdf 20', 10], ['review-loop paper.pdf 0', 1]]) {
    assert.equal((await run(line)).kind, 'success')
    const text = followups.at(-1).content[0].text
    assert.ok(text.includes('research artifact: paper.pdf'), `${line}: the round count leaked into the artifact name`)
    assert.ok(text.includes(`Round 1 of ${rounds};`), `${line}: expected ${rounds} rounds`)
    assert.match((await run('review-loop stop')).text, /for "paper\.pdf" stopped/)
  }
})

// The loop advances only when the turn its own queued message opened ends:
// the agent loop appends that exact message as `user/message` in the turn it
// starts, so an unrelated turn (one already running at dispatch, or a human
// turn in between) never counts as a round.
function loopHarness() {
  const followups = []
  const session = { id: 'loop-session' }
  const pending = []
  const agent = {
    id: 'loop-session', session, whenIdle: () => Promise.resolve(),
    followup: (m) => { followups.push(m); pending.push(m) }, inject: () => {},
    inbox: { nextTurn: pending, remove: (id) => {
      const at = pending.findIndex((message) => message.id === id)
      if (at < 0) return false
      pending.splice(at, 1)
      return true
    } },
  }
  const effects = []
  const listeners = {}
  let handler
  const registry = new Map([['loop-session', agent]])
  apply({
    effect: (fn) => { effects.push(fn()); return () => {} },
    commands: { register: (d) => { handler = d.handler; return () => {} } },
    on: (event, fn) => { listeners[event] = fn; return () => {} },
    // `agents` is injected, so the plugin reads it directly.
    agents: { get: (id) => registry.get(id) },
    get: () => undefined,
  }, {})
  const emit = (type, data) => listeners['session/event'](session, { type, data })
  return {
    followups,
    agent,
    dispose: () => { for (const off of effects.reverse()) off?.() },
    session,
    listeners,
    run: (rawInput) => handler({ rawInput, agent, attachments: [] }),
    /** One turn: optionally carrying `message`, ending with `reason`. */
    turn: async (message, reason = { kind: 'completed' }) => {
      if (message !== undefined) agent.inbox.remove(message.id)
      emit('turn/start', { turn: 1 })
      if (message !== undefined) emit('user/message', message)
      emit('turn/end', { turn: 1, reason })
      await Promise.resolve()
    },
  }
}

test('review-loop advances only on the turn its own queued message opened', async () => {
  const loop = loopHarness()
  assert.equal((await loop.run('review-loop paper.pdf 3')).kind, 'success')
  assert.equal(loop.followups.length, 1, 'round 1 queued at dispatch')
  await loop.turn()
  assert.equal(loop.followups.length, 1, 'a turn already running at dispatch is not round 1')
  await loop.turn({ id: 'human-message', role: 'user', content: [] })
  assert.equal(loop.followups.length, 1, 'an unrelated turn is not a round')
  await loop.turn(loop.followups[0])
  assert.equal(loop.followups.length, 2, 'round 2 queued after the round 1 turn')
  assert.ok(loop.followups[1].content[0].text.includes('round 2'), 'round 2 brief')
  await loop.turn(loop.followups[1])
  assert.equal(loop.followups.length, 3, 'round 3 queued after the round 2 turn')
  await loop.turn(loop.followups[2])
  assert.equal(loop.followups.length, 3, 'loop ends after the final round')
  assert.ok((await loop.run('review-loop stop')).text.includes('No review loop'))
})

// A round turn that errors, is aborted, or ends any way but `completed` ends
// the loop: its queued message is spent, so waiting for another completion
// would let an unrelated turn count as the round.
test('review-loop queues after publication, and stop withdraws only its pending round', async () => {
  const loop = loopHarness()
  let publishing = false
  const followup = loop.agent.followup
  loop.agent.followup = (message) => {
    assert.equal(publishing, false, 'followup reentered event publication')
    followup(message)
  }
  await loop.run('review-loop paper.pdf 3')
  publishing = true
  const turn = loop.turn(loop.followups[0])
  publishing = false
  await turn
  assert.equal(loop.followups.length, 2)
  loop.agent.inbox.nextTurn.push({ id: 'unrelated' })
  await loop.run('review-loop stop')
  assert.deepEqual(loop.agent.inbox.nextTurn.map((message) => message.id), ['unrelated'])
})

test('a deferred review-loop round cannot survive stop, replacement, or unload', async () => {
  for (const action of ['stop', 'replace', 'unload']) {
    const loop = loopHarness()
    let idle
    loop.agent.whenIdle = () => new Promise((resolve) => { idle = resolve })
    await loop.run('review-loop paper.pdf 3')
    await loop.turn(loop.followups[0])
    if (action === 'stop') assert.match((await loop.run('review-loop stop')).text, /stopped after 1 round/)
    else if (action === 'replace') await loop.run('review-loop other.pdf 2')
    else loop.dispose()
    const before = loop.followups.length
    idle()
    await Promise.resolve()
    assert.equal(loop.followups.length, before, action)
  }
})

test('a replacement review loop withdraws the previous pending round only', async () => {
  const loop = loopHarness()
  await loop.run('review-loop old.pdf 3')
  loop.agent.inbox.nextTurn.push({ id: 'unrelated' })
  await loop.run('review-loop new.pdf 2')
  assert.equal(loop.agent.inbox.nextTurn.length, 2)
  assert.equal(loop.agent.inbox.nextTurn[0].id, 'unrelated')
  assert.match(loop.agent.inbox.nextTurn[1].content[0].text, /new\.pdf/)
})

test('a review-loop round that does not complete ends the loop', async () => {
  for (const reason of [{ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } }, { kind: 'aborted', reason: { kind: 'user' } }]) {
    const loop = loopHarness()
    await loop.run('review-loop paper.pdf 3')
    await loop.turn(loop.followups[0], reason)
    await loop.turn(loop.followups[0])
    assert.equal(loop.followups.length, 1, `${reason.kind}: the loop queued another round`)
    assert.ok((await loop.run('review-loop stop')).text.includes('No review loop'), `${reason.kind}: loop state survived`)
  }
})

// Loop state is keyed by session id; a session disposed before its round
// completes must not keep its entry until the plugin unloads.
test('a disposed session drops its review-loop state', async () => {
  const loop = loopHarness()
  await loop.run('review-loop paper.pdf 3')
  loop.listeners['session/disposed'](loop.session)
  assert.ok((await loop.run('review-loop stop')).text.includes('No review loop'), 'the disposed session kept its loop')
})

// Plugin state is per apply instance: a second load must not see the first
// instance's loops (module-level state would leak across a patch reload).
test('review-loop state is per apply instance', async () => {
  const make = () => {
    let handler
    const session = { id: 'shared-session' }
    const agent = { id: 'shared-session', session, followup: () => {}, inject: () => {} }
    apply({
      effect: (fn) => { fn(); return () => {} },
      commands: { register: (d) => { handler = d.handler; return () => {} } },
      on: () => () => {},
      get: () => undefined,
    }, {})
    return (rawInput) => handler({ rawInput, agent, attachments: [] })
  }
  const first = make()
  const second = make()
  await first('review-loop paper.pdf 3')
  const leaked = await second('review-loop stop')
  assert.ok(leaked.text.includes('No review loop'), 'second instance sees the first instance loop')
  const owned = await first('review-loop stop')
  assert.ok(owned.text.includes('stopped after 0 round'), 'first instance lost its own loop')
})

// /feynman doctor must read the settings service the harness actually mounts
// (`SettingsForms`): `describe()` lists one descriptor per configurable row and
// carries no `get`. Probing `settings.get(ns)` throws on that surface, so the
// doctor reported the card namespace unserved even while the card was mounted.
/** The settings service surface the harness exposes: methods only, no `get`. */
const describeSettings = (ns) => ({
  describe: () => [{ ns, autoGenerate: true, schema: {}, value: {}, revision: 0, applies: 'live' }],
  update: async () => {},
})

let cardHandler
let cardServices
beforeEach(() => {
  let handler
  cardServices = {}
  apply({
    effect: (fn) => { fn(); return () => {} },
    commands: { register: (d) => { handler = d.handler; return () => {} } },
    on: () => () => {},
    get: (key) => cardServices[key],
    inject: () => {},
  }, {})
  cardHandler = handler
})
const cardLineOf = (text) => text.split('\n').find((line) => line.includes('Config card:')) ?? ''

test('/feynman doctor reports the card namespace served against the real settings surface', async () => {
  cardServices.settings = describeSettings('feynman')
  const result = await cardHandler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(cardLineOf(result.text), /namespace served/, `/feynman doctor misread the settings surface: ${cardLineOf(result.text)}`)
})

test('a settings service serving another namespace still reports NOT served', async () => {
  cardServices.settings = describeSettings('someone-else')
  const result = await cardHandler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.match(cardLineOf(result.text), /namespace NOT served/, 'an unserved namespace must not be reported as served')
})

test('a settings service that cannot be queried reports NOT served, never a crash', async () => {
  cardServices.settings = {
    describe: () => { throw new Error('settings document is unavailable') },
    update: async () => {},
  }
  const result = await cardHandler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(cardLineOf(result.text), /namespace NOT served \(settings document is unavailable\)/)
})

test('an absent settings service reports the card as unavailable, not unserved', async () => {
  const result = await cardHandler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.match(cardLineOf(result.text), /settings service absent/)
})

test('the card state answers the real surface end to end through /keys', async () => {
  cardServices.settings = describeSettings('feynman')
  const keys = await cardHandler({ rawInput: 'keys', agent: { session: { id: 's' } }, attachments: [] })
  assert.match(keys.text, /namespace served/, '/keys misread the settings surface')
  // /status names key state and the model route; the card line belongs to
  // /keys and /doctor only, so it must not grow one by accident.
  const status = await cardHandler({ rawInput: 'status', agent: { session: { id: 's' } }, attachments: [] })
  assert.ok(!status.text.includes('Config card'), '/status gained a card line')
})

// docs/testing.md:37-41: a real in-process Cordis composition, not a
// hand-built ctx: mount the shipped entry, assert its registrations, dispose
// the fiber, and assert the teardown.
test('real Cordis composition mounts the plugin and tears it down', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { name, inject, apply } = await import('../index.js')
  const registered = []
  const session = { id: 'real-session' }
  const followups = []
  const agent = { id: 'real-session', session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m), inject: () => {} }
  const ctx = new Context()
  ctx.provide('commands', {
    register: (definition) => {
      registered.push(definition)
      return () => { const i = registered.indexOf(definition); if (i >= 0) registered.splice(i, 1) }
    },
  })
  ctx.provide('agents', { get: (id) => (id === agent.id ? agent : undefined) })

  const fiber = await ctx.plugin({ name, inject, apply }, {})
  assert.equal(registered.length, 1, 'exactly one command registered')
  assert.equal(registered[0].name, 'feynman')
  assert.equal(registered[0].definitionId, 'dsh-feynman:feynman', 'branded id keeps its string value')
  const started = await registered[0].handler({ rawInput: 'review-loop paper.pdf 3', agent, attachments: [] })
  assert.equal(started.kind, 'success')
  assert.equal(followups.length, 1, 'round 1 queued through the real handler')
  // The review-loop driver is live on the real event bus.
  ctx.emit('session/event', session, { type: 'user/message', data: followups[0] })
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await Promise.resolve()
  assert.equal(followups.length, 2, 'turn/end advanced the loop through the real bus')

  await fiber.dispose()
  assert.equal(registered.length, 0, 'command registration outlives the fiber')
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(followups.length, 2, 'session/event listener disposed with the fiber')
})

// --- perf gates -----------------------------------------------------------
// Instruction-level numbers were recorded with `taskset -c 2 perf stat -e
// instructions,cycles` over 20000 prompt builds: 3072 instructions per
// build on this host). Tests must survive a loaded runner, so they gate on
// retired CPU time and on the frozen prompt text instead of wall clock.

/** The brief args the digest was reviewed against; changing one changes the digest. */
const DIGEST_ARGS = {
  deepresearch: 'Quantum error correction — fault tolerance\nwith unicode: café, 東京, emoji 🚀',
  lit: 'arxiv:2301.00001 diffusion models',
  review: 'arxiv:2301.00001',
  'review-loop': 'paper X',
  audit: 'repo url --paper arxiv:1',
  replicate: 'claim: scaling holds',
  recipe: 'fine-tune a 7B model',
  compare: 'arxiv:1 arxiv:2',
  draft: '--from-session',
  autoresearch: 'prompt optimisation',
  log: 'citation fixes for the audit brief',
  summarize: parseSummarizeArgs('papers/long report.pdf --window-size 4000 --overlap 100 --tier1-threshold 5000 --tier2-threshold 20000'),
}

test('every workflow brief is byte-identical to the reviewed text', () => {
  const digest = createHash('sha256')
  for (const kind of Object.keys(WORKFLOWS)) {
    for (const refs of [{}, { hfTokenEnv: 'A', alphaxivTokenEnv: 'B' }]) {
      digest.update(`${kind}\u0000${JSON.stringify(refs)}\u0000${buildPrompt(kind, DIGEST_ARGS[kind], refs)}`)
    }
  }
  digest.update(loopFollowupPrompt('paper X', 2, 2))
  assert.equal(
    digest.digest('hex'),
    '5ab92a400276b98d236c4d2b6384b7666289c0b80f612c7b34f7096d4708241e',
    'prompt text changed: update the digest deliberately',
  )
})

test('prompt construction stays inside its CPU-time budget', () => {
  const kinds = ['deepresearch', 'lit', 'review', 'audit', 'replicate', 'recipe', 'compare', 'draft', 'autoresearch', 'summarize']
  let sink = 0
  // One batch = every workflow once. The denominator builds comparable-sized
  // text (per-workflow concatenation, joined) without the builder, and both
  // halves of a pair are timed in the same window. The
  // old gate divided by nothing: an absolute 2.0us/build budget against a
  // 0.64us baseline relies on the host being quiet, and a loaded host tripped
  // it on contention alone (2.198us/build). String assembly is what both sides
  // spend, so contention lands on both and divides out.
  const referenceLines = Object.fromEntries(kinds.map((kind) => [kind,
    Math.ceil(buildPrompt(kind, DIGEST_ARGS[kind], {}).length / `reference ${kind} line 00\n`.length),
  ]))
  const measuredBatch = (iterations) => {
    for (let i = 0; i < iterations; i += 1) {
      sink += kinds.map((kind) => buildPrompt(kind, DIGEST_ARGS[kind], {})).join('\u0000').length
    }
  }
  const referenceBatch = (iterations) => {
    for (let i = 0; i < iterations; i += 1) {
      sink += kinds.map((kind) => {
        let text = ''
        for (let line = 0; line < referenceLines[kind]; line += 1) text += `reference ${kind} line ${line}\n`
        return text
      }).join('\u0000').length
    }
  }
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const pairedRatio = (measure, reference, samples, iterations) => {
    measure(20)
    reference(20)
    const ratios = []
    for (let i = 0; i < samples; i += 1) {
      const before = process.cpuUsage()
      measure(iterations)
      const middle = process.cpuUsage()
      reference(iterations)
      const after = process.cpuUsage()
      const measured = (middle.user - before.user) + (middle.system - before.system)
      const base = (after.user - middle.user) + (after.system - middle.system)
      if (base > 0) ratios.push(measured / base)
    }
    return median(ratios)
  }
  const ratio = pairedRatio(measuredBatch, referenceBatch, 41, 10)
  assert.ok(sink > 0)
  console.log(`feynman-prompt: ${ratio.toFixed(2)}x the reference assembly`)
  // Normalize by rendered payload size so adding evidence instructions does
  // not masquerade as slower assembly. The 3.2x regression budget is unchanged;
  // the frozen digest above separately requires deliberate protocol changes.
  assert.ok(
    ratio <= 3.2,
    `prompt build cost ${ratio.toFixed(2)}x the reference assembly; limit 3.2x`,
  )
})


test('workflow and side-question relays preserve multiline input and code indentation', async () => {
  let handler
  const messages = []
  const agent = { session: { id: 'fixture' }, followup: (message) => messages.push(message), inject: (message) => messages.push(message) }
  apply({ effect: (fn) => fn(), commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: () => undefined }, {})
  const prompt = 'Check this code:\n```js\nif (ready) {\n  launch()\n}\n```'
  for (const verb of ['audit', 'btw']) {
    const result = await handler({ rawInput: `${verb} ${prompt}`, agent, attachments: [] })
    assert.equal(result.kind, 'success')
    assert.ok(messages.at(-1).content[0].text.includes(prompt), `${verb} must retain the literal prompt`)
  }
})

// The upstream `/log` takes no argument; it must still queue the full brief.
test('/feynman log queues the upstream session-log brief with and without a focus', async () => {
  let handler
  const queued = []
  const agent = { session: { id: 'log-session' }, followup: (message) => queued.push(message), inject: () => {} }
  apply({ effect: (fn) => fn(), commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: () => undefined }, {})
  const bare = await handler({ rawInput: 'log', agent, attachments: [] })
  assert.equal(bare.kind, 'success')
  assert.match(queued.at(-1).content.at(-1).text, /Write a session log for the current research work/)
  assert.doesNotMatch(queued.at(-1).content.at(-1).text, /Focus:/)
  const focused = await handler({ rawInput: 'log citation fixes', agent, attachments: [] })
  assert.equal(focused.kind, 'success')
  assert.match(queued.at(-1).content.at(-1).text, /Focus this entry on: citation fixes/)
  const attached = await handler({ rawInput: 'log', agent, attachments: [{ type: 'text', text: 'keep me' }] })
  assert.equal(attached.kind, 'success', 'log carries attachments into its queued message')
  assert.equal(queued.at(-1).content.length, 2)
})

// `/feynman init` writes the upstream templates itself and keeps existing files.
test('init scaffolds AGENTS.md and session-log folders without a model turn', async () => {
  let handler
  const followups = []
  apply({ effect: (fn) => { fn(); return () => {} }, commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: () => undefined, inject: () => {} }, {})
  const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url))
  const root = await mkdtemp(join(scratch, 'init-'))
  const invocation = { rawInput: 'init', agent: { session: { id: 's', header: { cwd: root } }, followup: (message) => followups.push(message), inject: () => {} }, attachments: [] }
  const first = await handler(invocation)
  assert.equal(first.kind, 'success', first.text)
  assert.match(first.text, /created: AGENTS\.md, notes\/session-logs\/README\.md/)
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
  assert.match(agents, /## Verification Gates/)
  assert.match(await readFile(join(root, 'notes', 'session-logs', 'README.md'), 'utf8'), /Use `\/log`/)
  assert.equal(followups.length, 0, 'init must not queue a model turn')

  await writeFile(join(root, 'AGENTS.md'), '# my own guide\n')
  const second = await handler(invocation)
  assert.match(second.text, /created: nothing; kept existing: AGENTS\.md, notes\/session-logs\/README\.md/)
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# my own guide\n')
  assert.equal((await handler({ ...invocation, rawInput: 'init extra' })).kind, 'error')
  assert.equal((await handler({ ...invocation, agent: { session: { id: 's' } } })).kind, 'error')
})

// Pandoc powers the preview skill; doctor reports it instead of assuming it.
test('doctor reports pandoc availability', async () => {
  let handler
  apply({ effect: (fn) => { fn(); return () => {} }, commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: () => undefined, inject: () => {} }, {})
  const result = await handler({ rawInput: 'doctor', agent: { session: { id: 's' } }, attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /- Pandoc \(preview\): /)
})
