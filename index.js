/**
 * Research workflow commands for DeepSeek Harness.
 *
 * One `/feynman` command: 12 workflow subcommands (deepresearch, lit, review,
 * review-loop, audit, replicate, recipe, compare, draft, autoresearch,
 * summarize, log) that steer the model with workflow briefs, plus session
 * subcommands for project state, research tools/roles, AlphaXiv, web results,
 * and source selection.
 *
 * For local development, `dsh plugin --profile <name> add <path-to-checkout>`.
 */
import { WORKFLOWS, SESSION_COMMANDS, THINKING_LEVELS, buildPrompt, parseLoopArgs, parseSummarizeArgs, loopFollowupPrompt } from './prompts.js'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { mountResearchTools } from './lib/research-tools.js'
import { createResearchSkillProvider, createRoleTool, ROLES } from './lib/resources.js'
import { createSearchContentTool, createCodeSearchTool, storedWebResults } from './lib/web-results.js'
import { createFetchContentTool } from './lib/fetch-content.js'
import { createSourceCheckTool } from './lib/source-check.js'
import { describeScaffold, scaffoldProject } from './lib/init-scaffold.js'
import { createContentStore } from './lib/content-store.js'
import { alphaCommand } from './lib/alpha-command.js'
import { createWorkflowTool } from './lib/workflow-tool.js'

export const name = 'feynman'
// The review-loop driver resolves agents from the registry on turn/end;
// without 'agents' the lookup misses and rounds after the first never queue.
export const inject = ['commands', 'agents']

/**
 * The settings entry the browser card reads: the settings domain keys one form
 * per mounted row, so this is the row id in `cordis.patch.yml`, not a namespace
 * the host registers itself.
 */
const RESEARCH_KEYS_NAMESPACE = 'feynman'

/**
 * The two env refs, also the settings-card schema. Review-loop bounds live
 * in prompts.js rather than row config.
 */
export const Config = Schema.object({
  hfTokenEnv: Schema.string().role('credential-ref').default('HF_TOKEN').volatile(),
  alphaxivTokenEnv: Schema.string().role('credential-ref').default('ALPHAXIV_API_KEY').volatile(),
})

// --- key configuration (Hugging Face + AlphaXiv) ---
//
// Secrets live in the credentials seam ($DSH_HOME/.credentials.yaml, env, .env
// fallbacks), never in row config. Row config names only the env refs, so one
// deployment can point at different vault names without touching code.
// Zero-click path: `export HF_TOKEN=… ALPHAXIV_API_KEY=…`; managed path: /keys.

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Unwrap a volatile config ref (anything with `get()`) to its current value. */
function plainConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return plainConfig(value.get())
  return value
}

/** Schema input: volatile refs become their current snapshots. The live refs stay on the row. */
function detachConfig(value) {
  const plain = plainConfig(value)
  if (plain !== value) return plain
  if (Array.isArray(value)) return value.map(detachConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, detachConfig(child)]))
  }
  return value
}

/**
 * Per-instance plugin state. Module-level state outlives plugin unload and is
 * shared by every instance, so a patch reload would re-run apply on top of the
 * previous instance's loops.
 */
function createState(rawConfig) {
  const checked = resolveConfig(rawConfig)
  const read = (field) => {
    const source = rawConfig !== null && typeof rawConfig === 'object' && Object.hasOwn(rawConfig, field)
      ? rawConfig[field]
      : checked[field]
    const live = plainConfig(source)
    return typeof live === 'string' ? live : plainConfig(checked[field])
  }
  const refs = {
    hfTokenEnv: read('hfTokenEnv'),
    alphaxivTokenEnv: read('alphaxivTokenEnv'),
  }
  for (const [field, value] of Object.entries(refs)) {
    if (typeof value !== 'string' || !REF_PATTERN.test(value)) {
      throw new Error(`[feynman] ${field} must be an env-var name (letters, digits, underscore); got ${JSON.stringify(value)}`)
    }
  }
  return {
    refs,
    // Live row: volatile fields update in place.
    source: () => ({
      hfTokenEnv: read('hfTokenEnv'),
      alphaxivTokenEnv: read('alphaxivTokenEnv'),
    }),
    loops: new Map(),
    curator: new Set(),
    // Fetched document text shared by feynman_fetch_content and feynman_search_content.
    content: createContentStore(),
  }
}

/**
 * Row config through the exported schema: defaults applied, out-of-range values
 * rejected. Cordis validates the same schema before apply; this is the
 * direct-apply and shared-code path, and it owns the plugin-facing message.
 */
function resolveConfig(rawConfig) {
  try {
    return Config(detachConfig(rawConfig))
  } catch (error) {
    throw new Error(`[feynman] ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read live refs from the settings scope when valid, else the row fallback. */
function liveRefs(state) {
  try {
    const value = state.source()
    if (value !== null && typeof value === 'object') {
      const { hfTokenEnv, alphaxivTokenEnv } = value
      if (typeof hfTokenEnv === 'string' && typeof alphaxivTokenEnv === 'string') {
        return { hfTokenEnv, alphaxivTokenEnv }
      }
    }
  } catch { /* fall through to row config */ }
  return state.refs
}

/** Whether the settings namespace behind the config card is served. */
function cardState(ctx) {
  try {
    const settings = service(ctx, 'settings')
    if (!settings) return 'settings service absent: card unavailable on minimal profiles'
    // The service the harness mounts (`SettingsForms`) has no `get`: it lists
    // one descriptor per configurable row through `describe()`. Probing for a
    // `get` method threw a TypeError, which read as an unserved namespace even
    // while the card was mounted.
    const descriptors = typeof settings.describe === 'function' ? settings.describe() : undefined
    const served = Array.isArray(descriptors)
      && descriptors.some((descriptor) => descriptor?.ns === RESEARCH_KEYS_NAMESPACE)
    return served
      ? 'namespace served: the card is on the Plugins page, on the feynman row\'s Configure control'
      : 'namespace NOT served'
  } catch (error) {
    return `namespace NOT served (${error instanceof Error ? error.message : String(error)})`
  }
}

/** Optional service lookup: ctx.get returns undefined when absent. */
const service = (ctx, key) => ctx.get?.(key)

/** Configured state of one ref without ever exposing the value. */
async function keyState(ctx, ref) {
  try {
    const info = await service(ctx, 'credentials')?.describe?.(ref)
    if (info) return info.configured ? `set (${info.source ?? 'store'})` : 'unset'
  } catch { /* fall through to env */ }
  return process.env[ref] ? 'set (environment)' : 'unset'
}

/** The two key-state lines shared by /keys (no args) and /status. */
async function keySummary(ctx, refs) {
  const [hf, ax] = await Promise.all([keyState(ctx, refs.hfTokenEnv), keyState(ctx, refs.alphaxivTokenEnv)])
  return [
    `Hugging Face key (${refs.hfTokenEnv}): ${hf}`,
    `AlphaXiv key (${refs.alphaxivTokenEnv}): ${ax}`,
    `OpenAlex key (OPENALEX_API_KEY): ${await keyState(ctx, 'OPENALEX_API_KEY')}`,
    `Semantic Scholar key (SEMANTIC_SCHOLAR_API_KEY): ${await keyState(ctx, 'SEMANTIC_SCHOLAR_API_KEY')}`,
  ]
}

async function keysHandler(invocation, ctx, state) {
  const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
  const creds = service(ctx, 'credentials')
  const refs = liveRefs(state)
  if (args.length === 0) {
    return {
      kind: 'success',
      text: [
        ...await keySummary(ctx, refs),
        `Config card: ${cardState(ctx)}`,
        'AlphaXiv uses OAuth: /feynman alpha login|status. The legacy key is retained for config compatibility.',
        '',
        `Usage: /feynman keys set <hf|openalex|semanticscholar|alphaxiv> <value> stores the key in the managed credentials file.`,
        `Or export ${refs.hfTokenEnv} / ${refs.alphaxivTokenEnv} before launch; env shadows the store.`,
      ].join('\n'),
    }
  }
  if (args.length < 3 || args[0].toLowerCase() !== 'set') {
    return { kind: 'error', text: 'Usage: /feynman keys | /feynman keys set <hf|openalex|semanticscholar|alphaxiv> <value>' }
  }
  const which = args[1].toLowerCase()
  const fields = { hf: refs.hfTokenEnv, alphaxiv: refs.alphaxivTokenEnv, openalex: 'OPENALEX_API_KEY', semanticscholar: 'SEMANTIC_SCHOLAR_API_KEY' }
  const ref = Object.hasOwn(fields, which) ? fields[which] : undefined
  if (ref === undefined) return { kind: 'error', text: 'Usage: /feynman keys set <hf|openalex|semanticscholar|alphaxiv> <value>' }
  const value = args.slice(2).join(' ')
  if (creds?.set === undefined) {
    return { kind: 'error', text: `Credentials store is not mounted; export ${ref}=… before launch instead.` }
  }
  return creds.set(ref, value).then(
    () => ({ kind: 'success', text: `${ref} key stored. Values are never echoed.` }),
    (error) => ({ kind: 'error', text: `Could not store key: ${error instanceof Error ? error.message : String(error)}` }),
  )
}

// --- commands ---

function err(text) { return { kind: 'error', text } }

/**
 * Single dispatcher behind `/feynman`. The first token names a workflow or
 * session subcommand; the rest is that subcommand's raw input. Attachments
 * ride along on the sub-invocation.
 */
function researchHandler(invocation, ctx, sessionHandlers, state) {
  const [, sub = '', rest = ''] = invocation.rawInput.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? []
  const name = sub.toLowerCase()
  // The registry admits attachments for the whole command; a subcommand that
  // queues no message must refuse them so the composer keeps the originals.
  if (invocation.attachments.length > 0 && !queuesMessage(name, rest)) {
    return err(`/feynman ${name || '(bare)'} does not use attachments; attach them to a workflow, log, outputs, or btw.`)
  }
  if (!name) return helpHandler({ ...invocation, rawInput: '' })
  const subInvocation = { ...invocation, rawInput: rest }
  if (Object.hasOwn(WORKFLOWS, name)) return workflowHandler(name, subInvocation, state)
  const session = Object.hasOwn(sessionHandlers, name) ? sessionHandlers[name] : undefined
  if (session) return session(subInvocation, ctx)
  return err(`Unknown subcommand "${sub}". Usage: /feynman <${[...Object.keys(WORKFLOWS), ...Object.keys(SESSION_COMMANDS)].join(' | ')}>.`)
}

/** Session subcommands whose handler sends the invocation's attachments to the model. */
const MESSAGE_SESSION_COMMANDS = new Set(['outputs', 'btw', 'run', 'websearch'])

/** Whether `/feynman <name> <rest>` carries its attachments into a queued message. */
function queuesMessage(name, rest) {
  if (Object.hasOwn(WORKFLOWS, name)) return !(name === 'review-loop' && rest.toLowerCase() === 'stop')
  return MESSAGE_SESSION_COMMANDS.has(name)
}

function workflowHandler(kind, invocation, state) {
  const spec = WORKFLOWS[kind]
  const args = invocation.rawInput.trim()
  const usage = `Usage: /feynman ${kind} ${spec.hint}`
  // `/log` is the one workflow whose upstream form takes no argument.
  if (!args && kind !== 'log') return err(usage)
  if (kind === 'review-loop' && args.toLowerCase() === 'stop') {
    const loop = state.loops.get(invocation.agent.session.id)
    if (!loop) return { kind: 'success', text: 'No review loop is running.' }
    if (loop.pending !== undefined) invocation.agent.inbox?.remove(loop.pending)
    state.loops.delete(invocation.agent.session.id)
    return { kind: 'success', text: `Review loop for "${loop.target}" stopped after ${loop.round - 1} round(s).` }
  }
  // Queue the workflow brief as the agent's next turn; the followup IS the work.
  // Structured workflows reject unknown flags instead of absorbing them into the source/topic.
  if (kind === 'summarize') {
    const parsed = parseSummarizeArgs(args)
    if (parsed.error) return err(parsed.error)
    if (!parsed.source) return err(usage)
    if (parsed.unsupported.length > 0) {
      return err(`Unsupported flag(s): ${parsed.unsupported.join(', ')}. See \`Usage: /feynman ${kind} ${spec.hint}\`.`)
    }
    const body = buildPrompt(kind, parsed, liveRefs(state))
    invocation.agent.followup(userMessage(invocation, `${kind}: ${args}\n\n${body}`))
    return { kind: 'success', text: `/feynman ${kind} workflow started. Output lands in outputs/.` }
  }
  const body = kind === 'review-loop'
    ? reviewLoopPrompt(invocation, args, state)
    : buildPrompt(kind, args, liveRefs(state))
  if (body === null) return err(usage)
  const message = userMessage(invocation, `${kind}: ${args}\n\n${body}`)
  invocation.agent.followup(message)
  // The round's turn is the one that appends this exact message.
  if (kind === 'review-loop') state.loops.get(invocation.agent.session.id).pending = message.id
  return { kind: 'success', text: `/feynman ${kind} workflow started. Output lands in outputs/.` }
}

function reviewLoopPrompt(invocation, args, state) {
  const { target, rounds } = parseLoopArgs(args)
  if (!target) return null
  const previous = state.loops.get(invocation.agent.session.id)
  if (previous?.pending !== undefined) invocation.agent.inbox?.remove(previous.pending)
  // `pending`: id of the queued round message; `open`: its turn has started.
  state.loops.set(invocation.agent.session.id, { target, rounds, round: 1, pending: undefined, open: false })
  const brief = buildPrompt('review-loop', target, liveRefs(state))
  return `${brief}\n\nRound 1 of ${rounds}; follow-ups will drive re-review.`
}

/**
 * Frozen user message for the queued follow-up. Built through the llm seam so
 * identity branding, role, and deep-frozen content match every other producer;
 * the queued message is handed to followup()/inject() and must not be mutated.
 */
function userMessage(invocation, text) {
  const content = [...invocation.attachments, { type: 'text', text }]
  return createUserMessage({
    content,
    // Producer source, not forged 'user': title/outline/activity consumers gate human input on kind === 'user'.
    source: { kind: 'feynman', form: 'relay' },
  })
}

const runExecutable = promisify(execFile)

/** `pandoc` powers the preview skill; report it instead of assuming it exists. */
async function pandocState() {
  try {
    const { stdout } = await runExecutable('pandoc', ['--version'], { timeout: 4000 })
    const version = stdout.split('\n')[0].trim()
    return version || 'available'
  } catch {
    return 'missing (install from pandoc.org; PDF output also needs a LaTeX engine)'
  }
}

async function doctorHandler(invocation, ctx, state) {
  if (invocation.rawInput.trim()) return err('Usage: /feynman doctor (no arguments)')
  const refs = liveRefs(state)
  const lines = ['Feynman diagnostics:']
  for (const [label, ref] of [['Hugging Face', refs.hfTokenEnv], ['AlphaXiv', refs.alphaxivTokenEnv]]) {
    lines.push(`- ${label} key (${ref}): ${await keyState(ctx, ref)}`)
  }
  for (const [label, ref] of [['OpenAlex', 'OPENALEX_API_KEY'], ['Semantic Scholar', 'SEMANTIC_SCHOLAR_API_KEY']]) lines.push(`- ${label} key (${ref}): ${await keyState(ctx, ref)}`)
  const present = (key) => service(ctx, key) !== undefined && service(ctx, key) !== null
  for (const [label, key] of [['credentials store', 'credentials'], ['settings (config card)', 'settings'], ['research tools', 'tools'], ['research skills', 'skills'], ['attachments', 'attachments']]) {
    lines.push(`- ${label}: ${present(key) ? 'mounted' : 'absent (related commands degrade to an error or guidance text)'}`)
  }
  lines.push(`- Config card: ${cardState(ctx)}`)
  try { await import('@llamaindex/liteparse'); lines.push('- Native document parser: available') }
  catch { lines.push('- Native document parser: unavailable on this installation/platform; check LiteParse optional dependencies') }
  lines.push(`- Pandoc (preview): ${await pandocState()}`)
  return { kind: 'success', text: lines.join('\n') }
}

async function statusHandler(invocation, ctx, state) {
  if (invocation.rawInput.trim()) return err('Usage: /feynman status (no arguments)')
  const refs = liveRefs(state)
  return {
    kind: 'success',
    text: [
      'Feynman setup summary:',
      ...(await keySummary(ctx, refs)).map((line) => `- ${line}`),
      `- Key refs: hfTokenEnv=${refs.hfTokenEnv} alphaxivTokenEnv=${refs.alphaxivTokenEnv} (row config; invalid names fail at load)`,
      '- Model route: one profile route (see the agent-default-model row); per-turn overrides are not supported here.',
      `- Thinking levels: ${THINKING_LEVELS.join(', ')} (note a level with /feynman thinking <level>).`,
      '- For the full checklist run /feynman doctor.',
    ].join('\n'),
  }
}

function helpHandler() {
  const lines = ['Research workflows (`/feynman <subcommand>`):']
  for (const n of Object.keys(WORKFLOWS)) lines.push(`  ${n} ${WORKFLOWS[n].hint}: ${WORKFLOWS[n].description}`)
  lines.push('Session (`/feynman <subcommand>`):')
  for (const n of Object.keys(SESSION_COMMANDS)) lines.push(`  ${n}: ${SESSION_COMMANDS[n]}`)
  lines.push('', 'Tip: /feynman review-loop <artifact> [rounds] iterates review→fix→re-review; /feynman review-loop stop ends it.')
  return { kind: 'success', text: lines.join('\n') }
}

/** Queue a model turn from a prompt template; the Focus suffix is shared. */
function followupHandler(invocation, prompt, ack) {
  const focus = invocation.rawInput.trim()
  invocation.agent.followup(userMessage(invocation, focus ? `${prompt} Focus: ${focus}` : prompt))
  return { kind: 'success', text: ack }
}

async function initHandler(invocation) {
  if (invocation.rawInput.trim()) return err('Usage: /feynman init (no arguments)')
  const root = invocation.agent?.session?.header?.cwd
  if (!root) return err('No workspace is available; open a project session and rerun /feynman init')
  try {
    return { kind: 'success', text: describeScaffold(await scaffoldProject(root)) }
  } catch (error) {
    return err(`Could not scaffold the project: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function outputsHandler(invocation) {
  return followupHandler(invocation,
    'List research artifacts under outputs/, papers/, experiments/, and notes/ when present (group outputs by workflow: <slug>.md deepresearch/lit, *-comparison.md compare, *-review.md review, *-audit.md audit, *-replication-plan.md replicate, *-recipe.md recipe, *-draft.md draft, *-summary.md summarize). Include provenance, plans, notes, and any older research artifacts found. Summarize what each contains in one line; list paths, not raw source bodies.',
    'Artifact listing queued as the next turn.')
}

function btwHandler(invocation) {
  const q = invocation.rawInput.trim()
  if (!q) return err('Usage: /feynman btw <question>')
  // Non-waking context: visible at the next step boundary without hijacking the running turn.
  invocation.agent.inject(userMessage(invocation, `Side question (answer when convenient, main task first): ${q}`))
  return { kind: 'success', text: 'Side question noted as context; the main turn continues undisturbed.' }
}

export async function thinkingHandler(invocation, ctx = {}) {
  const level = invocation.rawInput.trim().toLowerCase()
  const model = invocation.agent?.model
  const current = model?.current?.()
  if (!level) {
    const active = current?.reasoningEffort ?? 'route default'
    return { kind: 'success', text: `Thinking level: ${active}. Levels: ${THINKING_LEVELS.join(', ')}.` }
  }
  if (!THINKING_LEVELS.includes(level)) return err(`Unknown thinking level "${level}". Levels: ${THINKING_LEVELS.join(', ')}.`)
  if (!current?.provider || !current?.model) {
    return err('No model route is recorded for this session. Choose a model first, then set the thinking level.')
  }
  // Validate against the route's advertised efforts when the adapter exposes them;
  // unsupported values would otherwise fail at the next model request.
  let supported
  const llm = service(ctx, 'llm')
  if (llm?.resolveModelInfo) {
    try {
      const info = await llm.resolveModelInfo(current.provider, current.model)
      supported = info?.reasoning?.efforts?.map((effort) => String(effort.id))
    } catch {
      supported = undefined
    }
  }
  if (supported?.length && !supported.includes(level)) {
    return err(`Model ${current.provider}/${current.model} does not support thinking level "${level}". Supported: ${supported.join(', ')}.`)
  }
  try {
    model.select({ provider: current.provider, model: current.model, reasoningEffort: level })
  } catch (error) {
    return err(`Could not set thinking level: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { kind: 'success', text: `Thinking level set to ${level} for this session.` }
}

export function apply(ctx, config = {}) {
  const state = createState(config)

  ctx.inject?.(['tools'], (scope) => {
    state.toolRuntime = scope.tools
    state.research = mountResearchTools(scope, () => liveRefs(state))
    scope.tools.register(createRoleTool())
    scope.tools.register(createFetchContentTool(scope.tools, { store: state.content }))
    scope.tools.register(createSearchContentTool({ store: state.content }))
    scope.tools.register(createSourceCheckTool(scope.tools, { store: state.content }))
    scope.tools.register(createWorkflowTool(() => liveRefs(state)))
    if (!scope.tools.schemas?.().some((tool) => tool.name === 'code_search')) scope.tools.register(createCodeSearchTool(scope.tools))
  })
  ctx.inject?.(['skills'], (scope) => scope.skills.registerProvider(createResearchSkillProvider))
  ctx.inject?.(['systemPrompt'], (scope) => scope.systemPrompt.section({
    name: 'feynman-research', order: 700, interpolate: false,
    text: () => `Research date (UTC): ${new Date().toISOString().slice(0, 10)}. Prefer primary evidence; distinguish source assertions, inferences, and verified checks. Research tools: feynman_fetch_content for PDFs, GitHub repositories/issues, and multi-URL batches; feynman_search_content to page (offset/limit) or search (findText) a long fetched source; feynman_source_check to gather claim-level passages into outputs/<slug>-source-check.md (read them; the artifact is not a verdict); feynman_science_database_search, Hugging Face inspection, document_parse/search/screenshot, authenticated alpha tools when visible. Load feynman_research_role before role-specific delegation; use DSH's actual subagent schema and consume completed results before synthesis. Never invent measurements or citations; keep numeric claims and visuals tied to raw evidence. Write final research artifacts and provenance to disk and check they exist before delivery. Read existing CHANGELOG.md before resuming substantial work; append meaningful progress and blockers, not trivial one-shot changes.`,
  }))
  ctx.effect(() => () => { state.disposed = true; state.loginProcess?.kill() })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || result.isError || exec.name !== 'web_search' || !state.curator.has(exec.agent?.session?.id)) return decision
    exec.signal.throwIfAborted()
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), createUserMessage({
      source: { kind: 'feynman', form: 'relay' },
      content: [{ type: 'text', text: 'Search curator is on: show a shortlist of the retrieved sources with URLs and snippets, then wait for the user to choose sources before fetching or synthesizing. Report blocks and empty results honestly.' }],
    })] }
  })

  ctx.effect(() => {
    const disposers = []
    const sessionHandlers = {
      help: helpHandler,
      init: initHandler, outputs: outputsHandler, btw: btwHandler, thinking: (inv) => thinkingHandler(inv, ctx),
      keys: (inv, context) => keysHandler(inv, context, state),
      doctor: (inv, context) => doctorHandler(inv, context, state),
      status: (inv, context) => statusHandler(inv, context, state),
      tools: () => {
        if (!state.toolRuntime) return err('The tools service is not mounted.')
        const tools = state.toolRuntime.schemas?.() ?? [...(state.research?.tools ?? []), createRoleTool(), createFetchContentTool(undefined, { store: state.content }), createSearchContentTool({ store: state.content }), createSourceCheckTool(undefined, { store: state.content })]
        return { kind: 'success', text: tools.map((tool) => `${tool.name}: ${tool.description.split('\n')[0]}\n  Parameters: ${Object.keys(tool.parameters?.properties ?? {}).join(', ') || '(none)'}`).join('\n') || 'No tools are registered.' }
      },
      subagents: () => ({ kind: 'success', text: Object.entries(ROLES).map(([role, spec]) => `${role}: ${spec.description}`).join('\n') }),
      run: (inv) => {
        const [, role, task] = inv.rawInput.match(/^(\S+)\s+([\s\S]+)$/) ?? []
        if (!Object.hasOwn(ROLES, role ?? '') || !task?.trim()) return err('Usage: /feynman run <researcher|reviewer|writer|verifier> <task>')
        const spec = ROLES[role]
        const policy = spec.tools === null ? 'All visible tools are allowed.' : `Allowed tools: ${spec.tools.join(', ')}. Do not use tools outside this list.`
        inv.agent.followup(userMessage(inv, `Run the ${role} research role for this task: ${task}\n\nThinking level: ${spec.thinking}. ${policy}\n\n${spec.content}\n\nDelegate through the visible DSH subagent tool when available, including these role rules, the thinking level (as reasoning_effort only when the schema exposes it) and the task in its prompt; otherwise perform the role as lead. Use file outputs and verify completion before delivery.`))
        return { kind: 'success', text: `${role} task queued as the next turn.` }
      },
      alpha: async (inv) => {
        try { return { kind: 'success', text: await alphaCommand(inv, state, (text) => {
          if (!state.disposed) { try { inv.agent.inject(userMessage({ ...inv, attachments: [] }, text)) } catch {} }
        }) } } catch (error) { return err(error instanceof Error ? error.message : String(error)) }
      },
      search: (inv) => {
        const results = storedWebResults(inv.agent.session, inv.rawInput.trim()).slice(-40)
        return { kind: 'success', text: results.length ? results.map((item) => `${item.id} [${item.tool}${item.isError ? ', failed' : ''}]: ${item.text.replace(/\s+/g, ' ').slice(0, 350)}`).join('\n') : 'No matching stored web results in this session.' }
      },
      websearch: (inv) => {
        if (!inv.rawInput.trim()) return err('Usage: /feynman websearch <query>')
        return followupHandler(inv, `Run web_search with the user's queries. Show source URLs and snippets; ${state.curator.has(inv.agent.session.id) ? 'wait for source selection before fetching or synthesis' : 'fetch and inspect the most relevant primary sources, then summarize with citations'}. Save findings and search provenance under outputs/.notes/.`, 'Web research queued as the next turn.')
      },
      curator: (inv) => {
        const mode = inv.rawInput.trim().toLowerCase()
        const id = inv.agent.session.id
        if (!mode) return { kind: 'success', text: `Search curator: ${state.curator.has(id) ? 'on' : 'off'}.` }
        if (!['on', 'off'].includes(mode)) return err('Usage: /feynman curator [on|off]')
        if (mode === 'on') state.curator.add(id); else state.curator.delete(id)
        return { kind: 'success', text: `Search curator: ${mode}.` }
      },
    }
    // One top-level name; everything else rides `feynman <subcommand>`.
    // Bare generic names (log, help, …) belong to the host or the user.
    disposers.push(ctx.commands.register({
      definitionId: 'dsh-feynman:feynman',
      name: 'feynman',
      description: '⟁ Research workflows and session utilities (subcommands: workflow names plus log, help, init, outputs, btw, thinking, keys, doctor, status)',
      input: { hint: '<workflow | subcommand> [args]', attachments: true },
      recordInput: false,
      handler: (inv) => researchHandler(inv, ctx, sessionHandlers, state),
    }))
    // /review-loop driver. A round is the turn that appends the loop's own
    // queued message as `user/message` (the agent loop records a claimed
    // follow-up that way in the turn it opens), so a turn already running at
    // dispatch, or a human turn in between, never counts. When that turn
    // completes the next round is queued; any other end (error, abort,
    // blocked, max-tokens) spends the round's message and ends the loop.
    // Keyed by session id: the registry keys agents by session id.
    const offTurn = ctx.on('session/event', (session, event) => {
      const loop = state.loops.get(session.id)
      if (loop === undefined) return
      if (event?.type === 'user/message') {
        if (event.data?.id === loop.pending) loop.open = true
        return
      }
      if (event?.type !== 'turn/end' || !loop.open) return
      loop.open = false
      // `agents` is injected, so the service is present; ctx.get is for the
      // optional seams only. The identity guard matches upstream
      // (api/session-controller): the emitted session IS agent.session.
      const agent = ctx.agents.get(session.id)
      if (event.data?.reason?.kind !== 'completed' || loop.round >= loop.rounds
        || !agent || agent.session !== session) {
        state.loops.delete(session.id)
        return
      }
      loop.round += 1
      // followup appends: wait until publication and the retiring turn settle.
      void agent.whenIdle().then(() => {
        if (state.loops.get(session.id) !== loop || ctx.agents.get(session.id) !== agent) return
        const message = userMessage({ attachments: [], agent }, loopFollowupPrompt(loop.target, loop.round, loop.rounds - loop.round))
        loop.pending = message.id
        agent.followup(message)
      }).catch(() => { if (state.loops.get(session.id) === loop) state.loops.delete(session.id) })
    })
    // A session that goes away mid-loop takes its loop state with it.
    const offDisposed = ctx.on('session/disposed', (session) => { state.loops.delete(session.id); state.curator.delete(session.id) })
    return () => { offTurn?.(); offDisposed?.(); state.loops.clear(); for (const d of disposers) d() }
  })
}
