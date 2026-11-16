/**
 * Prompt-rendering tests for the artifact-root layout.
 *
 * The regression fixtures hash the root-`''` output of every workflow:
 *   - prompt-hashes-024.json: 0.24.0 behavior,
 *   - prompt-hashes.json: after anchoring autoresearch's session files under
 *     `experiments/`.
 * Only autoresearch may differ between the two.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { FIXTURE_ARGS, promptHashes } from '../experiments/capture-prompt-fixtures.mjs'
import { buildPrompt, parseSummarizeArgs } from '../prompts.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const BASELINE_024 = fixture('prompt-hashes-024.json')
const BASELINE = fixture('prompt-hashes.json')

/** A bare artifact prefix (not already under a root or another path segment). */
const BARE_PREFIX = /(?<![\w./-])(outputs|papers|notes|experiments)\//g
const barePrefixes = (text) => [...text.matchAll(BARE_PREFIX)].map((match) => match[0])

const prompt = (kind, args = FIXTURE_ARGS[kind], layout = {}) => buildPrompt(kind, args, undefined, layout)

test('T-REG-01: root layout renders the anchored baseline byte-for-byte', () => {
  assert.deepEqual(promptHashes(), BASELINE)
})

test('T-REG-02: only autoresearch differs from 0.24.0, with six anchored paths', () => {
  const changed = Object.keys(BASELINE_024).filter((kind) => BASELINE_024[kind] !== BASELINE[kind])
  assert.deepEqual(changed, ['autoresearch'])
  const text = prompt('autoresearch', FIXTURE_ARGS.autoresearch, { root: '' })
  assert.equal(text.split('experiments/autoresearch.').length - 1, 6)
  assert.deepEqual(text.match(/(?<![\w./-])autoresearch\.(?:md|jsonl|sh)/g) ?? [], [])
})

test('T-PROMPT-01: twelve workflows exist and render at the project root', () => {
  assert.equal(Object.keys(FIXTURE_ARGS).length, 12)
  for (const kind of Object.keys(FIXTURE_ARGS)) {
    const text = prompt(kind, FIXTURE_ARGS[kind], { root: '' })
    assert.ok(text.length > 0, kind)
    assert.ok(!text.includes('Artifact root:'), `${kind} has no header at the project root`)
  }
})

test('T-PROMPT-02: deepresearch maps artifact paths under .feynman/', () => {
  const text = prompt('deepresearch', undefined, { root: '.feynman' })
  assert.ok(text.includes('.feynman/outputs/'))
  assert.ok(text.includes('.feynman/outputs/.plans/'))
  assert.deepEqual(barePrefixes(text), [])
})

test('T-PROMPT-03: the log brief maps all four directories', () => {
  const text = prompt('log', '', { root: '.feynman' })
  for (const dir of ['outputs', 'papers', 'notes', 'experiments']) {
    assert.ok(text.includes(`.feynman/${dir}/`), dir)
  }
  assert.deepEqual(barePrefixes(text), [])
})

test('T-PROMPT-04: user input with an artifact prefix is never rewritten', () => {
  const topic = 'outputs/ 目录怎么设计'
  const text = prompt('deepresearch', topic, { root: '.feynman' })
  assert.ok(text.includes(topic))
  assert.ok(!text.includes('.feynman/outputs/ 目录怎么设计'), 'user input must not be mapped')
  assert.ok(text.includes('.feynman/outputs/'))
})

test('T-PROMPT-05: a review target that looks like a path survives verbatim', () => {
  const target = 'papers/2401.12345.pdf'
  const text = prompt('review', target, { root: '.feynman' })
  assert.ok(text.includes(target))
  assert.ok(!text.includes('.feynman/papers/2401.12345.pdf'))
})

test('T-PROMPT-06: summarize keeps the source and writes under the artifact root', () => {
  const text = prompt('summarize', parseSummarizeArgs('"papers/my study.pdf"'), { root: '.feynman' })
  assert.ok(text.includes('papers/my study.pdf'))
  assert.ok(!text.includes('.feynman/papers/my study.pdf'), 'source input must not be mapped')
  assert.ok(text.includes('.feynman/outputs/papers-my-study-pdf-summary.md'))
  assert.ok(text.includes('.feynman/outputs/.notes/papers-my-study-pdf-notes.md'))
})

test('T-PROMPT-07: the log brief writes its session log under .feynman/notes/', () => {
  const text = prompt('log', 'citation fixes', { root: '.feynman' })
  assert.ok(text.includes('.feynman/notes/'))
  assert.deepEqual(barePrefixes(text), [])
})

test('T-PROMPT-08: the same process can render both layouts without frozen state', () => {
  const rootFirst = prompt('log', '', { root: '' })
  const mapped = prompt('log', '', { root: '.feynman' })
  const rootAgain = prompt('log', '', { root: '' })
  assert.ok(rootAgain.includes('`notes/`'))
  assert.ok(!rootAgain.includes('.feynman'))
  assert.ok(mapped.includes('`.feynman/notes/`'))
  assert.ok(!rootFirst.includes('.feynman'))
})

test('T-PROMPT-09: the header names the root and the grep path; root layout has none', () => {
  const text = prompt('deepresearch', undefined, { root: '.feynman' })
  assert.match(text, /^Artifact root: \.feynman\/ \(project layout\)\./)
  assert.ok(text.includes('pass `path: ".feynman"`'))
  const rootText = prompt('deepresearch', undefined, { root: '' })
  assert.ok(!rootText.includes('Artifact root:'))
})

test('T-PROMPT-10: source_check paths inside the tool prelude are mapped', () => {
  const text = prompt('deepresearch', undefined, { root: '.feynman' })
  assert.ok(text.includes('.feynman/outputs/<slug>-source-check.md'))
})

test('T-PROMPT-11: a resolution note becomes a Note line in the header', () => {
  const text = prompt('deepresearch', undefined, { root: '.feynman', note: 'legacy layout: outputs/.plans' })
  assert.ok(text.includes('Note: legacy layout: outputs/.plans'))
})

test('T-PROMPT-12: mapping never double-prefixes an already-rooted path', () => {
  const text = prompt('deepresearch', undefined, { root: '.feynman' })
  assert.ok(!text.includes('.feynman/.feynman/'))
  assert.equal(text.split('.feynman/.feynman').length - 1, 0)
})

test('T-PROMPT-13: the tool prelude appears once per brief', () => {
  for (const kind of ['deepresearch', 'summarize', 'log']) {
    const text = prompt(kind, FIXTURE_ARGS[kind], { root: '.feynman' })
    assert.equal(text.match(/You are a research agent\./g)?.length, 1, kind)
  }
})

test('T-PROMPT-14: autoresearch session files are anchored under .feynman/experiments/', () => {
  const text = prompt('autoresearch', FIXTURE_ARGS.autoresearch, { root: '.feynman' })
  for (const name of ['md', 'jsonl', 'sh']) {
    assert.ok(text.includes(`.feynman/experiments/autoresearch.${name}`), name)
  }
  assert.ok(!/(?<![\w./-])autoresearch\.(?:md|jsonl|sh)/.test(text))
})

test('T-PROMPT-15: the log brief names the mapped directories for writing', () => {
  const text = prompt('log', '', { root: '.feynman' })
  for (const dir of ['outputs', 'papers', 'notes', 'experiments']) {
    assert.ok(text.includes(`.feynman/${dir}/`), dir)
  }
})

test('buildPrompt falls back to the upstream layout without a layout argument', () => {
  const text = buildPrompt('deepresearch', 'x')
  assert.ok(!text.includes('.feynman'))
  assert.ok(!text.includes('Artifact root:'))
})
