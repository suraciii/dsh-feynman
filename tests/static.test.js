/**
 * Static/style gates for the artifact-root layout.
 *
 * These read the shipped files rather than rendering prompts: they catch a
 * hardcoded hidden-root path, a skill that names a project-root directory, or a
 * template constant that drifted from its reviewed bytes.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROJECT_AGENTS_TEMPLATE, SESSION_LOGS_README } from '../lib/init-scaffold.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

/** A bare artifact prefix: not already under the root, a URL, or a longer word. */
const BARE_PREFIX = /(?<![\w./-])(outputs|papers|notes|experiments)\//g

test('T-STATIC-01: skills name the artifact root instead of project-root directories', () => {
  const dir = join(ROOT, 'resources/skills')
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
    const text = readFileSync(join(dir, name), 'utf8')
    assert.deepEqual([...text.matchAll(BARE_PREFIX)].map((match) => match[0]), [], name)
  }
  const preview = read('resources/skills/feynman-preview.md')
  assert.match(preview, /\$ARTIFACT_ROOT\/outputs\//)
  assert.doesNotMatch(preview, /pandoc outputs\//)
})

test('T-STATIC-02: code has no hardcoded hidden root outside the layout module', () => {
  const files = [
    'index.js',
    'prompts.js',
    ...readdirSync(join(ROOT, 'lib'))
      .filter((name) => name.endsWith('.js') && name !== 'project-paths.js')
      .map((name) => `lib/${name}`),
    ...readdirSync(join(ROOT, 'evals'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => `evals/${name}`),
  ]
  const literal = /(?<![\w./-])\.feynman(?=[/'"`\s])/g
  for (const file of files) {
    const text = read(file)
    assert.deepEqual([...text.matchAll(literal)].map((match) => match[0]), [], file)
  }
})

test('T-STATIC-03: the persona declares the artifact root instead of fixed locations', () => {
  const persona = read('cordis.patch.yml')
  assert.match(persona, /project artifact root is recorded in `\.feynman\/project\.json`/)
  assert.doesNotMatch(persona, /Locations: `outputs\/`/)
})

test('T-STATIC-04: the client picker and command catalog agree on the init wording', () => {
  const client = read('lib/client.js')
  assert.match(client, /\['init', '', '[^']*artifact root[^']*'\]/)
  const prompts = read('prompts.js')
  assert.match(prompts, /init: 'Create AGENTS\.md, the artifact root, and session-log folders/)
})

test('T-STATIC-05: init templates still match the reviewed upstream bytes', () => {
  // Upstream's template source is not vendored in this checkout, so the hash is
  // the guard: rendering happens at write time, the exported constant must not move.
  assert.equal(createHash('sha256').update(PROJECT_AGENTS_TEMPLATE).digest('hex'), '83ace41a4a1c4e8e63048a3c0f12761d3cfc346baedbf3a276f4ef384c2ab7e6')
  assert.equal(createHash('sha256').update(SESSION_LOGS_README).digest('hex'), '45ef0b0c4f6f7d3042d02b75544c244a75d3a67ffeb5ccc9f2a6d65026dfbd8c')
})

test('the autoresearch template has no bare session-file names left', () => {
  const text = read('resources/workflows.json')
  assert.deepEqual([...text.matchAll(/(?<![\w./-])autoresearch\.(?:md|jsonl|sh)/g)], [])
  assert.equal(text.split('experiments/autoresearch.').length - 1, 6)
})
