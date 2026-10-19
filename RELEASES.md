## v0.24.0

- Update DSH dependencies to 0.2.1-rc.2 and Cordis utilities to their matching stable releases.
- Declare supported DSH versions through `engines.dsh`.

Restart DSH and refresh the browser after upgrading.

## v0.23.0

- Wait for agent quiescence before queuing the next review round, avoiding event-publication reentry.
- Remove queued review prompts when a loop is stopped or replaced; an already running turn finishes.
- Reduce benchmark oversampling and replace fixed UI-test sleeps with event-loop synchronization.
- Install the release from npm with an exact version pin.

Restart DSH and refresh the browser after upgrading.

## v0.22.1

Track DeepSeek Harness 0.2.1-alpha.3.

- Move the dsh packages to 0.2.1-alpha.3 and vendored cordis and schemastery to their alpha.2 builds.
- Raise the DSH floor to 0.2.1-alpha.3, the version `dsh-credentials` and `dsh-attachment` are pinned to. The 0.2.1-alpha.2 floor no longer describes what this release resolves.
- Rebuild the lockfile from scratch. An incremental resolve keeps already-locked peer entries, which left 17 transitive peers on 0.2.1-alpha.2 where dsh-tools@0.2.1-alpha.3 requires 0.2.1-alpha.3 from its peers.

Upgrade requires DSH `>=0.2.1-alpha.3 <0.3.0`, Node `^22.22.0 || >=24.0.0`, a DSH restart and browser refresh. AlphaXiv uses OAuth through `/feynman alpha login`; a legacy API key does not authenticate it. Provider, terminal and general session controls remain DSH-owned.

# Releases

## v0.22.0

Research parity with upstream Feynman v0.5.41 within DeepSeek Harness.

- Add real scholarly clients for eight literature databases, Hugging Face metadata/file tools, and Alpha Hub OAuth research tools with sign-in/status/logout and annotations.
- Add isolated document parsing, phrase search and screenshots with the upstream-pinned parser, cancellation, bounded output, DSH image attachments and DOCX paragraph fallback.
- Ship all 16 research skills, four role protocols, a model-facing workflow loader, stored-web-result browsing and source-selection mode.
- Expand workflows to the current upstream evidence/artifact contracts. Deep research continues after planning unless plan review is explicitly requested. Add source-on-disk summarization with validated window controls and durable coverage notes.
- Remove retired rank, paper, watch, jobs, preview, feynman-model and web-results commands. Search now browses current-session web results; previous-session search moves to the transcript-search skill/host controls. Existing artifacts are preserved.
- Resolve credentials per call, redact values from evidence/errors, forward retrieval cancellation, confine document/OCR-data paths to the workspace and dispose native workers and tool registrations on unload.

Upgrade requires DSH `>=0.2.1-alpha.2 <0.3.0`, Node `^22.22.0 || >=24.0.0`, a DSH restart and browser refresh. AlphaXiv uses OAuth through `/feynman alpha login`; a legacy API key does not authenticate it. Provider, terminal and general session controls remain DSH-owned.
