# Research-quality evals

A fixed question set run through the real plugin, scored deterministically. The purpose is to answer "did this prompt/tool change make the research better or worse?" with files on disk instead of inspection.

Two stages, one command:

- **Stage A** checks the artifact contract: did the run leave the promised files, with provenance and evidence-shaped content?
- **Stage B** resolves the cited arXiv IDs and DOIs and checks that each identifier is attached to the right paper (`title`), plus key-paper recall against the question's expected papers (`recall`). Lookup failures are excluded rather than counted as bad citations.

## Run

```sh
export DEEPSEEK_API_KEY=...          # the route's key; headless ignores the GUI credential store
node evals/run.mjs --model deepseek/official --ids q01,q04 --workflow lit
```

Options: `--workflow lit|deepresearch`, `--ids q01,q04`, `--timeout-min 45`, `--work-root <dir>`, `--results-dir <dir>`, `--score-only <workdir> --slug <slug>`, `--no-resolve`.

`--no-resolve` skips the network lookups and leaves `valid`/`title` null. Use it for offline scoring or when arXiv/Crossref are unreachable; stage-A columns and `recall` (which is local) are unaffected.

Results go to `evals/results/<date>-<workflow>-<model>.jsonl` (one row per question) plus a `.md` summary. Workspaces stay under `--work-root` (default `~/.cache/dsh-feynman-evals`) so a scorer change can rescore them without rerunning the model.

## What is scored

| Column | Meaning |
|---|---|
| `done` | Final artifact **and** its provenance sidecar exist on disk. |
| `plan` | `outputs/.plans/<slug>.md` exists. |
| `provenance_fields` | How many of the 8 required provenance labels are present (Date, Rounds, Sources consulted/accepted/rejected, Verification, Plan, Research files). |
| `sources` | Unique URLs, preferring the document's Sources/References section. |
| `cites` | Distinct arXiv IDs and DOIs in the final artifact. arXiv needs an `arXiv:`/URL prefix; arXiv's own DOI prefix is resolved as an arXiv id. |
| `valid` | Share of looked-up identifiers that resolve (arXiv API, Crossref, then the doi.org handle system). Failed lookups are left out of the denominator; `unresolved` lists the misses. |
| `title` | Among resolved identifiers with a known title, share whose title is at least 60% present (content-token overlap) on a line carrying the identifier, or whose first author's surname appears there. `title_mismatch` lists the rest with the resolved title and overlap. |
| `recall` | Share of the question's expected key papers that appear in the artifact, matched by any listed identifier or by the exact normalized title. `key_missing` lists the rest. |
| `todos` | `TODO` markers: an explicit "not verified" is allowed; an invented result is not. |
| `blocked` | `Verification: BLOCKED` is recorded. |
| `wall_seconds` | Wall clock for the whole one-shot run. |

Stage-B limits: `title` is a token-overlap heuristic, not a human judgement; `recall` only sees the ids/titles listed in `questions.jsonl`, so a better paper than the listed one still scores as a miss; `valid` says an identifier exists, not that it supports the claim.

## Isolation: no profile changes

Each run uses a throwaway `DSH_HOME` (headless profile auto-created from the shipped template) and a generated `--patch` overlay:

```yaml
- id: system-prompt
  config:
    personaPrefix: |
      You are Feynman, a research-first AI agent.
- insert:
    - id: feynman-eval-mount
      name: /absolute/path/to/dsh-feynman/index.js
      config: {}
```

Nothing is installed, no profile file is edited, and the user's real `$DSH_HOME` is untouched. The plugin's own research prompt section, skills provider, tools, roles and commands mount at root level.

**Fidelity caveat:** this mounts base tools + the plugin + a short persona, not the `feynman` preset's full cloned `standard` composition. The workflow brief is injected with `buildPrompt()`, so the eval measures the plugin and its instructions, not the GUI's preset-selection wiring. Do not read a passing eval as proof of the preset composition.

## Artifact naming

The scorer prefers upstream's `outputs/<slug>.md` (deepresearch and lit) with `outputs/<slug>.provenance.md`, the `papers/<slug>.md` fallback, and still accepts this plugin's legacy `outputs/<slug>-brief.md` and `outputs/<slug>-lit-review.md` so older runs remain scorable. Provenance is looked up next to the final artifact and by slug. A run that writes the wrong name scores `done: 0`, which is the point.

## Comparing runs

Use the same model and the same ids before and after a change, and commit both result files with the change (mirrors upstream's rule). Treat a single run as noisy: read the rows and the `final`/`error` columns, not only the percentages.

Example:

```text
| id | done | plan | prov | cites | valid | title | recall | sources | todos | blocked | wall | final | error |
```

## Questions and licensing

`questions.jsonl` has 12 items:

- `q01`–`q06`: Feynman's paper-discovery search benchmark (upstream `evals/questions.jsonl`, MIT).
- `q07`–`q09`: LitQA2 items from [futurehouse/lab-bench](https://huggingface.co/datasets/futurehouse/lab-bench), **CC-BY-SA-4.0**, redistributed with attribution and the same license.
- `q10`–`q12`: hand-authored cross-domain topics.

Keep the set fixed. Adding or editing a question breaks comparison with earlier results; add a new id instead.

## Status

- Stage A: implemented, unit-tested (`tests/evals.test.js`), and smoke-tested for the no-credential path.
- Stage B: implemented in `resolve.mjs`, unit-tested with a stubbed `fetch`, and smoke-tested once against live arXiv/Crossref (a real id carrying the wrong title was flagged as a mismatch).
- Baseline: **not run**. No result files are committed yet; any score you see in a report is from a later, explicitly dated run.
