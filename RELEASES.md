## Unreleased

- Make `/feynman thinking` a real setting: it records the level in DSH model selection (validated against the route's advertised efforts) instead of injecting a preference note, matching upstream's Pi `/thinking` behavior.
- Restore upstream role parameters: `feynman_research_role` now returns each role's `thinking` level (researcher/reviewer high, verifier/writer medium) and the upstream tool policy (writer has no retrieval tools), plus a `delegation` block. DSH has no per-child tool allowlist, so the prompt states the policy as a hard rule.
- Add `evals/`: a fixed 12-question research-quality eval that runs the real plugin in a one-shot headless session and scores each workspace deterministically (`done` = final artifact + provenance sidecar, plan, provenance fields, Sources, arXiv/DOI identifiers, TODO markers, blocked verification, wall time). It uses a throwaway `DSH_HOME` and a generated `--patch` overlay, so it never edits a DSH profile or installs a package. Stage B resolves cited arXiv IDs through the arXiv API and DOIs through Crossref/doi.org, reporting `valid`, title-to-identifier match and key-paper recall; lookup failures are excluded and `--no-resolve` keeps a run offline. No baseline has been run. Questions q07–q09 are LitQA2 (CC-BY-SA-4.0) with attribution.
- Add `feynman_fetch_content`: PDFs are saved into `.feynman/fetch/` and parsed to full text, GitHub repositories/issues/pull requests/blobs/trees resolve through the public API, HTML uses the host `web_fetch` reader with a direct status-checked fallback, and up to six URLs are fetched per call with per-URL errors. Full text is kept under an id for later paging.
- Add `offset`/`limit` paging and `findText` search (`findMode: "regex"`) to `feynman_search_content`, and let it read fetched documents as well as session web results.
- Add `feynman_source_check`: it searches for one claim, fetches up to five pages, ranks sentences by shared content words (CJK claims use character bigrams), and writes `outputs/<slug>-<hash>-source-check.md` plus a `.json` sidecar with a `status: "unclassified"` marker. The artifact lists passages; support stays a human/model judgement.
- Refuse loopback and private/link-local targets in `feynman_fetch_content` unless `FEYNMAN_FETCH_ALLOW_LOCAL=1`: literal addresses plus a DNS preflight of every resolved address, mirroring the host reader's public-address policy (preflight, not connection pinning).
- Make `/feynman init` deterministic: it writes `AGENTS.md` and `notes/session-logs/README.md` from the upstream templates, keeps existing files, and queues no model turn.
- Report pandoc in `/feynman doctor` with install guidance instead of leaving preview availability unknown.
- Move `log` into the workflow catalog so `feynman_workflow` can load it; `/feynman log [focus]` keeps working and no longer references a missing workflow.
- Backport the upstream arXiv fallbacks from v0.5.45/v0.5.46 (present in v0.5.58): a topic-shaped arXiv query falls back to OpenAlex semantic search, and an arXiv timeout/429/5xx falls back to Semantic Scholar records; an OpenAlex miss for an arXiv DOI is retried on arXiv.
- Correct agent-facing text that described parameters DSH does not expose: role web filters, Pi `output` on subagents, `alpha_search` in shell, the pandoc claim in the preview skill, plain `rg` over compressed transcripts, and the broken deep-research verifier/reviewer steps and provenance filename.
- Ship the research surface as a session preset instead of a host-level row. Installing the bundle no longer mounts research tools in every mode; select **Feynman 研究模式** in the mode selector, and sessions in other modes stay clean.
- The preset clones DSH's built-in `standard` preset with the Feynman persona, so a DSH upgrade that changes `standard` may need a matching plugin release.

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
