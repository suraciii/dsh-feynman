/**
 * Capture prompt hashes for the artifact-root layout regression.
 *
 * Two fixtures are expected:
 *   - `prompt-hashes-024.json`: the 0.24.0 behavior (root layout), captured
 *     before any template text changes.
 *   - `prompt-hashes.json`: after anchoring the autoresearch session files
 *     under `experiments/`, with root `''` still rendering upstream paths.
 *
 * Both files hash the root-`''` briefs only. The `.feynman/` mapping is covered
 * by the unit tests and the static gates, not here.
 *
 * Run: node experiments/capture-prompt-fixtures.mjs <out.json>
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildPrompt, parseSummarizeArgs } from '../prompts.js'

/** Fixed inputs: changing one invalidates both fixtures. */
export const FIXTURE_ARGS = {
  deepresearch: 'mechanistic interpretability',
  lit: 'retrieval augmented generation',
  review: '2401.12345',
  'review-loop': '2401.12345',
  audit: 'https://github.com/owner/repo',
  replicate: '2401.12345',
  recipe: 'fine-tune a 7B model on 8 GPUs',
  compare: 'vLLM vs SGLang',
  draft: 'efficient attention',
  autoresearch: 'improve MMLU by 2 points',
  log: '',
  summarize: parseSummarizeArgs('papers/long report.pdf --window-size 4000 --overlap 100 --tier1-threshold 5000 --tier2-threshold 20000'),
}

/** Hashes of every workflow brief rendered at the project root (`root: ''`). */
export function promptHashes() {
  const hashes = {}
  for (const [kind, args] of Object.entries(FIXTURE_ARGS)) {
    const text = buildPrompt(kind, args, { hfTokenEnv: 'HF_TOKEN', alphaxivTokenEnv: 'ALPHAXIV_API_KEY' }, { root: '' })
    hashes[kind] = createHash('sha256').update(text).digest('hex')
  }
  return hashes
}

import { pathToFileURL } from 'node:url'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2]
  if (!out) {
    console.error('Usage: node experiments/capture-prompt-fixtures.mjs <out.json>')
    process.exit(1)
  }
  const target = resolve(out)
  writeFileSync(target, `${JSON.stringify(promptHashes(), null, 2)}\n`)
  console.log(`wrote ${target}`)
}
