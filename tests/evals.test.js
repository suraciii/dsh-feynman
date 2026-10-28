import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { countIdentifiers, countProvenanceFields, countTodos, extractSources, findFinal, findProvenance, isBlocked, scoreWorkdir } from '../evals/score.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const roots = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-feynman-evals-'))
  roots.push(root)
  mkdirSync(join(root, 'outputs/.plans'), { recursive: true })
  mkdirSync(join(root, 'outputs/.drafts'), { recursive: true })
  mkdirSync(join(root, 'papers'), { recursive: true })
  return root
}
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

const PROVENANCE = `# Provenance: test

- **Date:** 2026-10-28
- **Rounds:** 2
- **Sources consulted:** 9
- **Sources accepted:** 6
- **Sources rejected:** 3 (dead)
- **Verification:** PASS WITH NOTES
- **Plan:** outputs/.plans/test-topic.md
- **Research files:** outputs/.drafts/test-topic-research-direct.md
`

const FINAL = `# Test topic

A claim with evidence [1]. Another claim, see arXiv:2408.03314 and doi:10.1038/s41586-020-2649-2 [2].

## Sources

1. https://arxiv.org/abs/2408.03314
2. https://www.nature.com/articles/s41586-020-2649-2
`

describe('score helpers', () => {
  it('counts provenance fields and ignores missing labels', () => {
    assert.equal(countProvenanceFields(PROVENANCE), 8)
    assert.equal(countProvenanceFields('- **Date:** 2026\n- **Rounds:** 1'), 2)
  })

  it('extracts only the Sources section when present', () => {
    const result = extractSources(`See also https://example.com/not-a-source\n\n${FINAL}`)
    assert.equal(result.section, true)
    assert.equal(result.count, 2)
    assert.ok(result.urls.includes('https://arxiv.org/abs/2408.03314'))
    assert.ok(!result.urls.includes('https://example.com/not-a-source'))
  })

  it('counts distinct arXiv ids and DOIs, de-duplicated', () => {
    const ids = countIdentifiers('arXiv:2408.03314v2 and 2408.03314 again; doi:10.1038/s41586-020-2649-2')
    assert.deepEqual(ids.arxiv, ['2408.03314'])
    assert.deepEqual(ids.doi, ['10.1038/s41586-020-2649-2'])
    assert.equal(ids.distinct, 2)
  })

  it('counts TODO markers and recognises blocked verification', () => {
    assert.equal(countTodos('TODO: run experiment. Another TODO here.'), 2)
    assert.equal(isBlocked('Verification: BLOCKED — network down'), true)
    assert.equal(isBlocked('Verification: PASS'), false)
  })
})

describe('scoreWorkdir', () => {
  it('scores the lit naming convention as done with all provenance fields', () => {
    const root = fixture()
    writeFileSync(join(root, 'outputs/test-topic-lit-review.md'), FINAL)
    writeFileSync(join(root, 'outputs/test-topic-lit-review.provenance.md'), PROVENANCE)
    writeFileSync(join(root, 'outputs/.plans/test-topic.md'), '# Plan\n')
    writeFileSync(join(root, 'outputs/.drafts/test-topic-research-direct.md'), '# Notes\n')
    const row = scoreWorkdir({ workdir: root, slug: 'test-topic', workflow: 'lit' })
    assert.equal(row.final, 'outputs/test-topic-lit-review.md')
    assert.equal(row.provenance, 'outputs/test-topic-lit-review.provenance.md')
    assert.equal(row.done, 1)
    assert.equal(row.plan, 1)
    assert.equal(row.drafts, 1)
    assert.equal(row.provenance_fields, 8)
    assert.equal(row.sources, 2)
    assert.equal(row.sources_section, 1)
    assert.equal(row.cites, 2)
    assert.equal(row.todos, 0)
    assert.equal(row.blocked, 0)
    assert.ok(row.words > 10)
  })

  it('scores the deepresearch naming convention and upstream fallback', () => {
    const root = fixture()
    writeFileSync(join(root, 'outputs/test-topic-brief.md'), FINAL)
    writeFileSync(join(root, 'outputs/test-topic-brief.provenance.md'), PROVENANCE)
    const row = scoreWorkdir({ workdir: root, slug: 'test-topic', workflow: 'deepresearch' })
    assert.equal(row.final, 'outputs/test-topic-brief.md')
    assert.equal(row.done, 1)

    const upstream = fixture()
    writeFileSync(join(upstream, 'papers/test-topic.md'), FINAL)
    writeFileSync(join(upstream, 'papers/test-topic.provenance.md'), PROVENANCE)
    const fallback = scoreWorkdir({ workdir: upstream, slug: 'test-topic', workflow: 'lit' })
    assert.equal(fallback.final, 'papers/test-topic.md')
    assert.equal(fallback.done, 1)
  })

  it('reports done=0 when the provenance sidecar is missing', () => {
    const root = fixture()
    writeFileSync(join(root, 'outputs/test-topic-lit-review.md'), FINAL)
    const row = scoreWorkdir({ workdir: root, slug: 'test-topic', workflow: 'lit' })
    assert.equal(row.done, 0)
    assert.equal(row.provenance, null)
    assert.equal(row.provenance_fields, 0)
  })

  it('does not mistake a source-check sidecar for the final artifact', () => {
    const root = fixture()
    writeFileSync(join(root, 'outputs/test-topic-abc123-source-check.md'), 'passages only')
    writeFileSync(join(root, 'outputs/test-topic-lit-review.md'), FINAL)
    assert.equal(findFinal(root, 'test-topic', 'lit'), 'outputs/test-topic-lit-review.md')
    assert.equal(findProvenance(root, 'outputs/test-topic-lit-review.md', 'test-topic'), undefined)
  })

  it('keeps blocked and TODO runs scorable', () => {
    const root = fixture()
    writeFileSync(join(root, 'outputs/test-topic-lit-review.md'), `${FINAL}\nTODO: verify the third source.\nVerification: BLOCKED\n`)
    writeFileSync(join(root, 'outputs/test-topic-lit-review.provenance.md'), PROVENANCE.replace('PASS WITH NOTES', 'BLOCKED'))
    const row = scoreWorkdir({ workdir: root, slug: 'test-topic', workflow: 'lit' })
    assert.equal(row.done, 1)
    assert.equal(row.todos, 1)
    assert.equal(row.blocked, 1)
  })
})

describe('run.mjs harness', () => {
  it('runs one stub question end to end and writes a scored row', async () => {
    const { execFileSync } = await import('node:child_process')
    const { chmodSync } = await import('node:fs')
    const root = fixture()
    const bin = join(root, 'fake-dsh.mjs')
    writeFileSync(bin, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
process.stdin.resume()
process.stdin.on('end', () => {
  const slug = 'demo-topic'
  mkdirSync(join(process.cwd(), 'outputs/.plans'), { recursive: true })
  writeFileSync(join(process.cwd(), 'outputs/.plans', slug + '.md'), '# Plan\\n')
  writeFileSync(join(process.cwd(), 'outputs', slug + '-lit-review.md'), '# demo\\n\\narXiv:2408.03314\\n\\n## Sources\\n\\n1. https://arxiv.org/abs/2408.03314\\n')
  writeFileSync(join(process.cwd(), 'outputs', slug + '-lit-review.provenance.md'), '# Provenance\\n\\n- **Date:** 2026-10-28\\n- **Rounds:** 1\\n- **Sources consulted:** 1\\n- **Sources accepted:** 1\\n- **Sources rejected:** 0\\n- **Verification:** PASS\\n- **Plan:** outputs/.plans/demo-topic.md\\n- **Research files:** none\\n')
  process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'stub' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'final', reason: { kind: 'stop' }, text: 'ok' }) + '\\n')
})
`)
    chmodSync(bin, 0o755)
    const questions = join(root, 'questions.jsonl')
    writeFileSync(questions, '{"id":"qx","field":"test","question":"demo topic","key_papers":[],"source":"fixture"}\n')
    execFileSync(process.execPath, [join(ROOT, 'evals/run.mjs'), '--questions', questions, '--model', 'stub', '--workflow', 'lit', '--work-root', join(root, 'run'), '--results-dir', join(root, 'results')], {
      env: { ...process.env, DSH_BIN: bin },
      stdio: 'pipe',
    })
    const files = readdirSync(join(root, 'results')).filter(name => name.endsWith('.jsonl'))
    assert.equal(files.length, 1)
    const row = JSON.parse(readFileSync(join(root, 'results', files[0]), 'utf8').trim())
    assert.equal(row.id, 'qx')
    assert.equal(row.done, 1)
    assert.equal(row.plan, 1)
    assert.equal(row.provenance_fields, 8)
    assert.equal(row.cites, 1)
    assert.equal(row.exit_code, 0)
  })
})
