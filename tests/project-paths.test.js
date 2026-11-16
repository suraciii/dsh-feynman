/**
 * Unit tests for the project artifact layout authority.
 *
 * Every case runs in its own temporary directory outside the repository so a
 * parent `.gitignore` can never change the outcome.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  artifactDir,
  artifactPath,
  DEFAULT_ARTIFACT_ROOT,
  detectLegacyLayout,
  hasArtifacts,
  layoutLabel,
  legacyArtifacts,
  mapArtifactPaths,
  markerPath,
  normalizeRoot,
  readMarker,
  resolveLayout,
  symlinkTargetOutside,
  workspaceRoot,
} from '../lib/project-paths.js'

const roots = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-feynman-paths-'))
  roots.push(root)
  return root
}
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

test('normalizeRoot accepts the two layouts and rejects everything else', () => {
  assert.equal(normalizeRoot(''), '')
  for (const value of ['.', './']) assert.equal(normalizeRoot(value), '')
  for (const value of ['.feynman', '.feynman/']) assert.equal(normalizeRoot(value), '.feynman')
  for (const value of ['..', '.git', '/abs', 'C:\\x', 'cache', ' .feynman ', '.feynman//']) {
    assert.equal(normalizeRoot(value), null, `${JSON.stringify(value)} must be rejected`)
  }
  assert.equal(normalizeRoot(undefined), null)
  assert.equal(normalizeRoot(42), null)
})

test('readMarker reports missing, present, and invalid markers', () => {
  const root = fixture()
  assert.equal(readMarker(root).status, 'missing')
  mkdirSync(join(root, '.feynman'), { recursive: true })
  writeFileSync(join(root, '.feynman', 'project.json'), '{"version":1,"artifactRoot":"."}')
  const present = readMarker(root)
  assert.equal(present.status, 'present')
  assert.equal(present.root, '')
  writeFileSync(join(root, '.feynman', 'project.json'), '{"artifactRoot":"cache"}')
  assert.equal(readMarker(root).status, 'invalid')
  writeFileSync(join(root, '.feynman', 'project.json'), 'not json')
  assert.equal(readMarker(root).status, 'invalid')
  writeFileSync(join(root, '.feynman', 'project.json'), '[]')
  assert.equal(readMarker(root).status, 'invalid')
})

test('detectLegacyLayout only trusts Feynman-specific evidence', () => {
  const root = fixture()
  assert.equal(detectLegacyLayout(root).legacy, false)
  mkdirSync(join(root, 'outputs'), { recursive: true })
  writeFileSync(join(root, 'outputs', 'build.js'), '// ordinary build output')
  mkdirSync(join(root, 'experiments'), { recursive: true })
  writeFileSync(join(root, 'experiments', 'foo.py'), 'print(1)')
  assert.equal(detectLegacyLayout(root).legacy, false, 'generic names are not evidence')

  mkdirSync(join(root, 'outputs', '.plans'), { recursive: true })
  const plans = detectLegacyLayout(root)
  assert.equal(plans.legacy, true)
  assert.deepEqual(plans.evidence, ['outputs/.plans'])
})

test('detectLegacyLayout recognizes drafts, provenance sidecars, and session logs', () => {
  for (const seed of [
    (root) => mkdirSync(join(root, 'outputs', '.drafts'), { recursive: true }),
    (root) => { mkdirSync(join(root, 'papers'), { recursive: true }); writeFileSync(join(root, 'papers', 'x.provenance.md'), '#') },
    (root) => { mkdirSync(join(root, 'notes', 'session-logs'), { recursive: true }); writeFileSync(join(root, 'notes', 'session-logs', 'README.md'), '#') },
  ]) {
    const root = fixture()
    seed(root)
    assert.equal(detectLegacyLayout(root).legacy, true, seed.toString())
  }
})

test('a repository-owned experiments/ directory is never legacy evidence', () => {
  const root = fixture()
  mkdirSync(join(root, 'experiments', 'notebooks'), { recursive: true })
  writeFileSync(join(root, 'experiments', 'notebooks', 'run.ipynb'), '{}')
  assert.equal(detectLegacyLayout(root).legacy, false)
  assert.deepEqual(legacyArtifacts(root).present, [])
})

test('resolveLayout prefers a marker, then legacy evidence, then the default', () => {
  const root = fixture()
  assert.deepEqual(resolveLayout(root), { root: DEFAULT_ARTIFACT_ROOT, source: 'default', marker: 'missing' })

  mkdirSync(join(root, 'outputs', '.plans'), { recursive: true })
  const legacy = resolveLayout(root)
  assert.equal(legacy.root, '')
  assert.equal(legacy.source, 'legacy')
  assert.match(legacy.detail, /legacy layout: outputs\/\.plans/)

  mkdirSync(join(root, '.feynman'), { recursive: true })
  writeFileSync(join(root, '.feynman', 'project.json'), '{"artifactRoot":".feynman"}')
  const marked = resolveLayout(root)
  assert.equal(marked.root, '.feynman')
  assert.equal(marked.source, 'marker')
  assert.equal(marked.marker, 'present')
})

test('an invalid marker falls through and keeps its error in detail', () => {
  const root = fixture()
  mkdirSync(join(root, '.feynman'), { recursive: true })
  writeFileSync(join(root, '.feynman', 'project.json'), '{')
  const layout = resolveLayout(root)
  assert.equal(layout.root, '.feynman')
  assert.equal(layout.source, 'default')
  assert.equal(layout.marker, 'invalid')
  assert.match(layout.detail, /not valid JSON/)
})

test('mapArtifactPaths prefixes the four moved directories only', () => {
  const text = 'outputs/a.md papers/b.md notes/c.md experiments/d.py myoutputs/e.md docs/outputs/f.md .feynman/outputs/g.md'
  assert.equal(
    mapArtifactPaths(text, '.feynman'),
    '.feynman/outputs/a.md .feynman/papers/b.md .feynman/notes/c.md .feynman/experiments/d.py myoutputs/e.md docs/outputs/f.md .feynman/outputs/g.md',
  )
  assert.equal(mapArtifactPaths(text, ''), text)
  assert.equal(mapArtifactPaths(text, '.feynman'), mapArtifactPaths(mapArtifactPaths(text, '.feynman'), '.feynman'))
})

test('mapArtifactPaths maps a bare backticked directory name', () => {
  assert.equal(mapArtifactPaths('Create `.plans`, `.drafts`, and `outputs`.', '.feynman'), 'Create `.plans`, `.drafts`, and `.feynman/outputs`.')
  assert.equal(mapArtifactPaths('the outputs are fine', '.feynman'), 'the outputs are fine')
  assert.equal(mapArtifactPaths('`.feynman/outputs`', '.feynman'), '`.feynman/outputs`')
})

test('mapArtifactPaths leaves already-rooted paths and non-prefixes alone', () => {
  // Provenance is the caller's job: the prompt builder maps the static template
  // and only then inserts user input, so a user-supplied "papers/..." survives.
  assert.equal(mapArtifactPaths('papers/my study.pdf', '.feynman'), '.feynman/papers/my study.pdf')
  assert.equal(mapArtifactPaths('.feynman/papers/x.md', '.feynman'), '.feynman/papers/x.md')
  assert.equal(mapArtifactPaths('foo.output/outputs/x', '.feynman'), 'foo.output/outputs/x')
})

test('artifactDir and artifactPath build POSIX prompt paths and absolute write paths', () => {
  assert.equal(artifactDir('', 'outputs', '.plans'), 'outputs/.plans')
  assert.equal(artifactDir('.feynman', 'outputs', '.notes'), '.feynman/outputs/.notes')
  assert.equal(artifactDir('.feynman', 'papers'), '.feynman/papers')
  assert.equal(artifactDir('.feynman', '', undefined, 'notes'), '.feynman/notes')
  const root = fixture()
  assert.equal(artifactPath(root, '.feynman', 'outputs'), join(root, '.feynman', 'outputs'))
  assert.equal(artifactPath(root, '', 'papers'), join(root, 'papers'))
  assert.equal(artifactPath('.', '.feynman', 'outputs'), join(process.cwd(), '.feynman', 'outputs'))
})

test('layoutLabel renders the two layouts for user-facing text', () => {
  assert.equal(layoutLabel(''), '.')
  assert.equal(layoutLabel('.feynman'), '.feynman/')
})

test('legacyArtifacts counts recursive files in the three upstream directories', () => {
  const root = fixture()
  mkdirSync(join(root, 'outputs', '.plans'), { recursive: true })
  writeFileSync(join(root, 'outputs', 'one.md'), '#')
  writeFileSync(join(root, 'outputs', '.plans', 'two.md'), '#')
  mkdirSync(join(root, 'papers'), { recursive: true })
  writeFileSync(join(root, 'papers', 'three.md'), '#')
  const found = legacyArtifacts(root)
  assert.deepEqual(found.dirs, { outputs: 2, papers: 1, notes: 0 })
  assert.deepEqual(found.present, ['outputs/', 'papers/'])
})

test('hasArtifacts sees files in every moved directory under the root', () => {
  const root = fixture()
  assert.equal(hasArtifacts(root, '.feynman'), false)
  mkdirSync(join(root, '.feynman', 'experiments'), { recursive: true })
  writeFileSync(join(root, '.feynman', 'experiments', 'run.sh'), '#!/bin/sh')
  assert.equal(hasArtifacts(root, '.feynman'), true)
  assert.equal(hasArtifacts(root, ''), false)
})

test('workspaceRoot prefers the workingDirectory service and falls back to the session header', () => {
  const root = fixture()
  const session = { header: { cwd: root } }
  assert.equal(workspaceRoot({ get: () => ({ get: () => join(root, 'live') }) }, session), join(root, 'live'))
  assert.equal(workspaceRoot({ get: () => undefined }, session), root)
  assert.equal(workspaceRoot({ get: () => { throw new Error('no service') } }, session), root)
  assert.equal(workspaceRoot({}, { header: { cwd: 'relative-dir' } }), join(process.cwd(), 'relative-dir'))
  assert.equal(workspaceRoot(undefined, undefined), undefined)
})

test('symlinkTargetOutside detects symlinks that escape the workspace', () => {
  const root = fixture()
  const outside = fixture()
  mkdirSync(join(root, 'inside'), { recursive: true })
  mkdirSync(join(outside, 'target'), { recursive: true })
  try {
    symlinkSync(join(root, 'inside'), join(root, 'internal-link'), 'dir')
    symlinkSync(join(outside, 'target'), join(root, 'external-link'), 'dir')
  } catch {
    return // symlinks unavailable (unprivileged Windows): the guard degrades to false
  }
  assert.equal(symlinkTargetOutside(root, join(root, 'internal-link')), false)
  assert.equal(symlinkTargetOutside(root, join(root, 'external-link')), true)
  assert.equal(symlinkTargetOutside(root, join(root, 'missing')), false)
})

test('markerPath points at the plugin namespace regardless of the chosen root', () => {
  const root = fixture()
  assert.equal(markerPath(root), join(root, '.feynman', 'project.json'))
  assert.equal(dirname(markerPath(root)), join(root, '.feynman'))
})
