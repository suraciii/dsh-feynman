/**
 * dsh-feynman browser half.
 *
 * One card on the Plugins page, bound to the settings form the settings domain
 * serves for this package's `feynman` row. The card edits nothing in that
 * namespace: the refs it shows are row config. It stages the two key
 * literals locally and writes them through `remote.credentials`, so a literal
 * never rides a settings response (the WebSearchCard pattern). The card learns
 * only configured/writable booleans via `remote.credentials.describe`.
 *
 * Plain JavaScript on purpose: the client module system serves this file as a
 * lazy-CJS factory on `window.__ModuleLoader__`; `react` is provided.
 */

window.__ModuleLoader__.load({
  id: '@maci0/dsh-feynman',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /**
     * This plugin's locale namespace and slot key. The settings form is
     * separate: the settings domain keys one form per mounted row, so the card
     * reads `feynman`, the row id in `cordis.patch.yml`.
     */
    const NAMESPACE = 'research-keys'

    /** The row id whose config form the card edits. */
    const SETTINGS_NAMESPACE = 'feynman'

    const CSS = [
      '.rk-body{border-top:0.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:12px}',
      '.rk-field{display:flex;flex-direction:column;gap:6px}',
      '.rk-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.rk-row{display:flex;gap:8px}',
      '.rk-input{flex:1;min-width:0;font:inherit;font-size:13px;padding:6px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.rk-btn{appearance:none;font:inherit;font-size:13px;padding:6px 14px;cursor:pointer;color:var(--dsw-alias-label-primary);background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.rk-btn:disabled{cursor:default;opacity:.5}',
      '.rk-badge{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.rk-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.rk-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
    ].join('')

    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    const en = {
      summary: 'Hugging Face credentials and a legacy AlphaXiv key. Use /feynman alpha login for AlphaXiv.',
      set: 'set',
      unset: 'not set',
      unknown: 'unknown',
      hfLabel: 'Hugging Face API key',
      axLabel: 'Legacy AlphaXiv API key',
      inputLabel: 'New value for {label}',
      save: 'Save',
      clear: 'Clear',
      hint: 'Keys are stored in the managed credentials file, never in settings. Empty input clears nothing; use Clear.',
      envNote: 'A key exported in the environment shadows the stored one.',
    }

    /** Slot id → settings ref field; labels resolve as `${id}Label`. */
    const SLOTS = { hf: 'hfTokenEnv', ax: 'alphaxivTokenEnv' }

    /**
     * `/feynman` subcommand rows for the bare-invocation picker. Static copy
     * of the host catalog (prompts.js WORKFLOWS + SESSION_COMMANDS); the
     * client bundle cannot import the host module. Internal by design: the
     * `/client` entry exports nothing beyond what cordis loading needs, and
     * `client.test.js` asserts the rendered picker options instead.
     */
    const SUBCOMMANDS = [
      ['deepresearch', '<topic>', 'Source-heavy investigation → research brief'],
      ['lit', '<topic-or-lab>', 'Literature review: consensus, disagreements, open questions'],
      ['review', '<arXiv-ID | URL | file>', 'Internal review with severity-graded feedback'],
      ['review-loop', '<artifact> [rounds=3] | stop', 'Bounded review→fix→re-review loop'],
      ['audit', '<arXiv-ID | repo-URL>', "Paper's claims vs its codebase"],
      ['replicate', '<paper | claim>', 'Source-backed replication plan'],
      ['recipe', '<training-task>', 'Ranked implementable ML training recipes'],
      ['compare', '<topic | paper-IDs>', 'Agreement/disagreement matrix'],
      ['draft', '<topic | --from-session>', 'Paper-style draft from findings'],
      ['autoresearch', '<idea>', 'Hypothesis→experiment→analysis→decision loop'],
      ['summarize', '<source> [flags]', 'Single-source summary with bounded reading'],
      ['log', '', 'Write a durable session log'],
      ['help', '', 'Show grouped research commands'],
      ['init', '', 'Bootstrap AGENTS.md, the artifact root, and session-log folders'],
      ['outputs', '', 'Browse research artifacts under the project artifact root'],
      ['btw', '<question>', 'Side question as non-waking context'],
      ['thinking', '[level]', 'Note a thinking level'],
      ['keys', '', 'Show or store research API keys'],
      ['doctor', '', 'Diagnose keys, seams, card'],
      ['status', '', 'Setup summary'],
      ['tools', '', 'Mounted research tools and parameters'],
      ['subagents', '', 'Research role catalog'],
      ['run', '<role> <task>', 'Run one research role'],
      ['alpha', '[action] [args]', 'AlphaXiv login, papers, code, annotations'],
      ['search', '[query]', 'Browse stored web results'],
      ['websearch', '<query>', 'Run and inspect web research'],
      ['curator', '[on|off]', 'Toggle source selection'],
    ]

    /** Configured-state word: ellipsis before an answer, `unknown` when the lookup failed. */
    const word = (t, state) => state === undefined ? '…'
      : state.unknown === true ? t('unknown') : t(state.configured ? 'set' : 'unset')

    function refsOf(snapshot) {
      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      return {
        hfTokenEnv: typeof value.hfTokenEnv === 'string' ? value.hfTokenEnv : 'HF_TOKEN',
        alphaxivTokenEnv: typeof value.alphaxivTokenEnv === 'string' ? value.alphaxivTokenEnv : 'ALPHAXIV_API_KEY',
      }
    }

    /**
     * One key row: status badge, password input, save/clear.
     * The staged literal lives in component state and is cleared on save.
     * @param remote - the browser remote context for credential writes.
     */
    function KeyRow(props) {
      // NOTE: `ref` is reserved by React and never arrives as a prop;
      // the credential reference rides `credRef` instead.
      const { t, remote, label, credRef, state, onRefresh } = props
      // `state` is undefined until the credentials domain answers for `credRef`;
      // writes stay enabled meanwhile, and a refused write reports its error.
      const writable = state === undefined || state.writable
      const [staged, setStaged] = React.useState('')
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const run = async (fn) => {
        setError(null)
        setBusy(true)
        try {
          const response = await fn()
          if (!response.ok) setError(response.error.message)
          else setStaged('')
          onRefresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      return React.createElement(
        'div',
        { className: 'rk-field' },
        React.createElement('span', { className: 'rk-label' }, label),
        React.createElement('span', { className: 'rk-badge', title: state?.failure }, `${credRef}: ${word(t, state)}`),
        React.createElement(
          'div',
          { className: 'rk-row' },
          React.createElement('input', {
            type: 'password',
            className: 'rk-input',
            value: staged,
            autoComplete: 'off',
            spellCheck: false,
            disabled: busy || !writable,
            // The label beside the field is a plain span, so the field names
            // itself: without this a screen reader announces only "password".
            'aria-label': t('inputLabel', { label }),
            onChange: (event) => { setStaged(event.target.value) },
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'rk-btn',
              disabled: busy || !writable || staged === '',
              onClick: () => { void run(() => remote.credentials.set(credRef, staged)) },
            },
            t('save'),
          ),
          state?.configured === true
            ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'rk-btn',
                disabled: busy || !writable,
                onClick: () => { void run(() => remote.credentials.unset(credRef)) },
              },
              t('clear'),
            )
            : null,
        ),
        error === null ? null : React.createElement('div', { className: 'rk-error' }, error),
      )
    }

    function createCard(scope, remote, t) {
      const useKeys = () => React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      )
      /** Live card refreshers, so a key written elsewhere updates open cards. */
      const refreshers = new Set()

      const Card = function ResearchKeysCard(props) {
        const snapshot = useKeys()
        const [states, setStates] = React.useState({})
        const refreshGeneration = React.useRef(0)
        const ready = snapshot.status === 'ready'
        const summary = props != null && props.view === 'summary'
        const refs = refsOf(snapshot)

        const refresh = async () => {
          const started = ++refreshGeneration.current
          // The reference is resolved at call time: a rename while a read is in
          // flight must not make the next read answer for the old reference.
          const live = refsOf(scope.getSnapshot())
          const entries = await Promise.all(Object.entries(SLOTS).map(async ([id, refField]) => {
            const ref = live[refField]
            let failure
            const response = await remote.credentials.describe([ref]).catch((cause) => {
              failure = cause instanceof Error ? cause.message : String(cause)
              return undefined
            })
            // Coerce at the wire boundary: only strict booleans reach state,
            // so no response shape can ever render as a child.
            const view = response !== null && typeof response === 'object' && response.ok === true
              ? response.value?.[ref]
              : undefined
            const info = view !== null && typeof view === 'object' ? view : undefined
            // A lookup with no usable answer says nothing about the key, so it
            // reads unknown (reason as the tooltip), never "not set".
            if (info === undefined) {
              const refused = response !== null && typeof response === 'object' && response.ok === false
                && typeof response.error?.message === 'string' ? response.error.message : undefined
              const reason = failure ?? refused
              return [id, { ref, unknown: true, writable: true, ...reason === undefined ? {} : { failure: reason } }]
            }
            // The answer carries the reference it describes. Two reads can
            // settle out of order, and the reference can be renamed between
            // them, so a state without that stamp is dropped at render.
            return [id, { ref, configured: info?.configured === true, writable: info?.writable !== false }]
          }))
          if (started === refreshGeneration.current) setStates(Object.fromEntries(entries))
        }

        // Every hook runs before any early return: the form starts `loading`
        // under the same mounted card, and React rejects a render that calls
        // more hooks than the one before it. A rename re-runs the read, since
        // no credential changed and no invalidation will arrive.
        React.useEffect(() => {
          if (!ready || summary) return undefined
          refreshers.add(refresh)
          void refresh()
          return () => { refreshGeneration.current += 1; refreshers.delete(refresh) }
        }, [ready, summary, refs.hfTokenEnv, refs.alphaxivTokenEnv])

        if (!ready) return null
        if (summary) return t('summary')

        return React.createElement(
          'div',
          { className: 'rk-page' },
          React.createElement(
            'div',
            { className: 'rk-body' },
              Object.entries(SLOTS).map(([id, refField]) => {
                // An answer for a reference the card no longer shows is no
                // answer: reporting it would name one reference's state under
                // another's label. It stays unknown until its own read lands.
                const answered = states[id]
                const state = answered !== undefined && answered.ref === refs[refField] ? answered : undefined
                return React.createElement(KeyRow, {
                  key: `${id}:${refs[refField]}`,
                  t,
                  remote,
                  label: `${t(`${id}Label`)} (${refs[refField]})`,
                  credRef: refs[refField],
                  state,
                  onRefresh: () => { void refresh() },
                })
              }),
              React.createElement('div', { className: 'rk-hint' }, `${t('hint')} ${t('envNote')}`),
            ),
        )
      }

      return { Card, refreshers }
    }

    /**
     * Mount the card: locale, scope, slot registration, credential invalidation.
     * Plus the `/feynman` bare-invocation picker: a subcommand popup whose
     * pick submits the completed `/feynman <sub>` line back through the host,
     * so the row offers subcommand completion the catalog row cannot.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NAMESPACE)
      // Single-locale registration: English is the documented fallback locale,
      // and the per-key fallback resolves every other language. Registering a
      // second namespace entry here would shadow later dictionaries.
      ctx.effect(
        () => ctx.locale.register(NAMESPACE, 'en', en),
        'dsh-feynman: locale dictionary',
      )

      const scope = ctx.configForms.get(SETTINGS_NAMESPACE)
      const { Card, refreshers } = createCard(scope, ctx.remote, t)

      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: '@maci0/dsh-feynman#feynman',
        locale: NAMESPACE,
      }, Card))

      ctx.effect(
        () => ctx.remote.$on('credentials/reference-updated', () => {
          for (const refresh of refreshers) void refresh()
        }),
        'dsh-feynman: credential invalidations',
      )

      ctx.effect(() => ctx.commandUi.decorate({
        name: 'feynman',
        available: () => true,
        ui: {
          kind: 'popupSelect',
          options: () => Promise.resolve(SUBCOMMANDS.map(([id, hint, detail]) => ({
            id,
            label: hint ? `/feynman ${id} ${hint}` : `/feynman ${id}`,
            ...(detail === undefined ? {} : { detail }),
          }))),
          onSelect: async (option, session) => {
            const live = ctx.sessions.binding(session.sessionId)?.session
            if (live === undefined) throw new Error('this session is not materialized yet')
            const result = await live.command(`/feynman ${option.id} `)
            if (!result.ok) throw new Error(`subcommand submit failed: ${result.error.code}: ${result.error.message}`)
            if (!result.value.matched) throw new Error('the host offers no /feynman command')
          },
        },
      }), 'dsh-feynman: /feynman subcommand picker')
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale', 'remote', 'remote.credentials', 'commandUi', 'sessions']
    return module.exports
  },
})
