# dsh-feynman

Research workflows and tools for DeepSeek Harness, adapted from [Feynman v0.5.41](https://github.com/Companion-Inc/feynman/tree/17dfe0f87defa754ea915e834e9f401d292ae3d2). `/feynman deepresearch "mechanistic interpretability"` queues the investigation as the agent's next turn and produces a cited research document with provenance.

The plugin supplies 11 workflows, 16 session commands, 16 research skills, and four research roles. It also mounts actual literature clients, Hugging Face inspection, document parsing/search/screenshots, and authenticated AlphaXiv tools. Workflows are model instructions; retrieval and document tools are executable implementations.

## Install

Requires DeepSeek Harness `>=0.2.1-rc.2 <0.3.0`. Restart DSH and refresh the browser after upgrading.

```sh
dsh plugin --profile web add --save-exact @maci0/dsh-feynman@0.24.0
```

Install as a bundle, then restart `dsh web` and refresh the browser. The package's own `cordis.patch.yml` mounts its writable configuration row. Do not also insert the row into the profile patch: Cordis does not deduplicate row IDs.

Node `^22.22.0 || >=24.0.0` is required; the Alpha Hub dependency sets the Node 22 floor. A bare GitHub spec follows `main`; pin a tag for reproducible installs. `/feynman doctor` reports mounted research seams and key state. `/feynman tools` lists the actual tool catalog.

## Research workflows

Each workflow queues a frozen, plugin-branded user message as the next model turn. Attachments are carried into that turn. Bare `/feynman` opens a subcommand picker; selecting a command that needs arguments returns its usage line.

Stopping a review loop removes its queued round prompt. An already running turn finishes.

| Command | Result |
|---|---|
| `deepresearch <topic>` | Planned investigation, cited brief, intermediate evidence, adversarial checks, provenance. Continues after planning; add “show me the plan first” to request approval. |
| `lit <topic-or-lab>` | Literature review with consensus, disagreements, open questions, verified citations and provenance. Lab/author mode resolves identity and logs reachable publications. |
| `review <arXiv-ID \| URL \| file>` | Internal critique with severity and confidence, evidence notes, reproducibility checks, and a revision recommendation. |
| `review-loop <artifact> [rounds]` | DSH review → fix → re-review driver. Three rounds by default, clamped to 1–10. `stop` ends it early. |
| `audit <arXiv-ID \| repo> [--paper ID]` | Paper claims compared with implementation, with exact source/code locations and reproducibility risks. |
| `replicate <paper-or-claim>` | Source-backed replication plan. Execution waits for an explicit environment choice. |
| `recipe <task>` | Ranked ML recipes with result, dataset, hyperparameters, compute, implementation, availability checks and provenance. |
| `compare <topic-or-sources>` | Evidence, agreement/disagreement, methodology and confidence matrix. |
| `draft <topic \| --from-session>` | Paper-style draft under `papers/`; unsupported results remain gaps or TODOs. |
| `autoresearch <idea>` | Bounded hypothesis → experiment → analysis → decision loop, with benchmark checks and durable experiment records. |
| `summarize <source> [flags]` | Single-source summary of a paper, report, repository README, local file or PDF, with bounded reading and coverage notes. |

Prefix every command with `/feynman`.

```text
/feynman summarize "papers/long report.pdf"
/feynman summarize https://github.com/owner/repo --window-size 4000 --overlap 100
```

Summarize controls count decoded characters: `--window-size` (6000), `--overlap` (500), `--tier1-threshold` (8000), `--tier2-threshold` (60000). Inputs below tier 1 are read directly; longer inputs use overlapping windows, then chunks with up to four concurrent children when available. Sequential reading is the fallback. Window size must exceed overlap, and `0 < tier1 < tier2`. Invalid values and unknown flags fail before work is queued. Quote paths containing spaces. A summary describes the supplied source and does not independently verify its claims.

## Research tools and roles

`feynman_science_database_search` covers Semantic Scholar, OpenAlex, known arXiv IDs, PubMed, Europe PMC, bioRxiv, medRxiv and Crossref. The upstream clients retain exact lookup modes, citation/reference and author/venue queries, PubMed ID conversion/related/citation/full-text routing, OA section extraction, pacing, bounded retry, and discovery-index fallback. Explicit arXiv versions remain distinct.

`hf_dataset_info`, `hf_repo_files`, and `hf_repo_read_file` inspect Hub metadata, schemas/splits, inventories and small text files. Credentials resolve per call through DSH; environment values take precedence. Keys are removed from returned evidence and errors.

`document_parse`, `document_search`, and `document_screenshot` use the same LiteParse 2.10.1 version upstream's pi-docparser 4.0.0 pins. Native work runs in isolated, cancellable subprocesses with bounded outputs. Screenshots are delivered through DSH's attachments service when mounted and retain saved-file references. Document and custom OCR-data paths must resolve inside the session's effective workspace, including symlink targets. Office conversion/OCR can need LibreOffice/Tesseract; missing dependencies are reported. DOCX paragraph extraction is available without LibreOffice, with layout/table/footnote/image gaps stated explicitly.

`code_search` uses an existing host code-search tool when mounted; otherwise the plugin bridges to host web search for public repository/docs examples. `feynman_search_content` reads bounded stored web results from this session. `feynman_workflow` lets an agent load and perform a workflow without a human slash command.

`feynman_research_role` provides the upstream researcher, writer, verifier and reviewer protocols. `/feynman subagents` lists them; `/feynman run <role> <task>` queues the role task. These are research roles applied through DSH's actual subagent interface, not Pi model aliases or workflow scripts. Missing delegation falls back to lead-owned work. Sixteen prefixed `feynman-*` skills cover literature, critique, replication, recipes, comparison, writing, experiments, paper access, PDF exploration, plain-language explanation, preview and continuity.

## AlphaXiv

```text
/feynman alpha login
/feynman alpha status
/feynman alpha search "transformer scaling laws" --mode semantic
/feynman alpha get 2106.09685 --full-text
/feynman alpha ask 2106.09685 "What optimizer did they use?"
/feynman alpha code https://github.com/owner/repo src/model.py
/feynman alpha annotate 2106.09685 "Check the ablations"
/feynman alpha annotate --clear 2106.09685
/feynman alpha annotate --list
/feynman alpha logout
```

The bundled Alpha Hub client handles OAuth and refresh. Login displays its consent URL; on a remote host, pass the final callback URL with `/feynman alpha login <callback-URL>`. Credentials stay in Alpha Hub's protected `~/.ahub/auth.json`. Account tools mount after sign-in and are removed on logout; local annotations stay available. Missing or failed access falls back to literature sources with AlphaXiv-only checks marked blocked. The legacy AlphaXiv key field remains compatible with existing configuration but does not authenticate this OAuth client.

## Session commands

`log`, `help`, `init`, `outputs`, `btw`, `thinking`, `keys`, `doctor`, `status`, `tools`, `subagents`, `run`, `alpha`, `search`, `websearch`, `curator`.

`/feynman search [query]` browses **stored web results in the current session**. `/feynman websearch <query>` queues live web research. `/feynman curator on` asks the model to show retrieved URLs/snippets and wait for source selection before fetching or synthesis; `off` disables it. Curator state is session-local and ends with disposal/restart.

`outputs` browses `outputs/`, `papers/`, `experiments/` and `notes/`, including older research artifacts. Plans and draft evidence remain under `outputs/.plans/` and `.drafts/`; summarization checkpoints use `.notes/`. `log` writes a durable session record. `init` bootstraps research directories and preserves existing project instructions. `btw` injects non-waking side-question context; it does not start Pi's independent side-thread runtime. `thinking` records a reasoning preference without pretending to change provider configuration.

## Credentials

The Plugins page's `feynman` row has a Research Keys card. `hfTokenEnv` defaults to `HF_TOKEN`; `alphaxivTokenEnv` defaults to legacy `ALPHAXIV_API_KEY`. Both are validated env-var references. Save/Clear operates on DSH's credential store, never settings; `/feynman keys` reports state without echoing values.

`/feynman keys set <hf|openalex|semanticscholar> <value>` stores a research key. `OPENALEX_API_KEY` and `SEMANTIC_SCHOLAR_API_KEY` are resolved from DSH's credentials service or the environment per operation. Export `HUGGINGFACE_HUB_TOKEN` as an HF fallback, or point `hfTokenEnv` at it. `NCBI_API_KEY`, `NCBI_EMAIL` and `CROSSREF_MAILTO` retain upstream's environment behavior. AlphaXiv uses `/feynman alpha login`, not an API-key field. Never put secret literals in prompts or artifacts.

## Upgrade from 0.21.x

Upstream-retired `rank`, `paper`, `watch`, `jobs`, `preview`, `feynman-model` and `web-results` are removed. Prior-session `search` is removed too; the name now matches upstream's stored-web-results behavior. Use `lit`/`deepresearch` for discovery and read-order guidance, `summarize` for one source, the preview skill for rendering, and DSH's own job/model/session controls. Existing files are not deleted. The DSH review loop remains.

The [capability comparison](docs/upstream-20261013.md) maps upstream research capabilities to this release. Pi-specific provider, terminal and session controls remain the host's responsibility.

## Development

```sh
bun install --frozen-lockfile
bun run build
bun test
bun run test:node
```

The committed `lib/upstream.js` bundles adapted, pinned research/document sources for Node; the host and browser entry points stay JavaScript. CI verifies Bun and Node 22.22/24. Source hashes and versions live in `upstream.manifest.json`; `vendor/` holds the matching code and licenses. Tests cover real Cordis/tool-runtime mounting and teardown, retrieval fixtures, credentials/cancellation, PubMed parser regressions, native PDF parsing/search/screenshots, workspace confinement, roles/skills, stored results, curator behavior, command relays and review-loop ownership.

Loops and curator state are instance-local. Host edits require remounting/HMR; browser edits require a page refresh. Authenticated remote services still require the user's account and available network routes. No paywall bypasses.

## Licence

MIT. Research clients, workflow protocols, role instructions and skills adapted from Feynman © 2026 Companion, Inc. Document tools adapted from pi-docparser © 2026 MaxedApps GmbH / Maximilian Schwarzmüller. See `NOTICE` and the bundled third-party licenses. LiteParse is an external Apache-2.0 dependency.
