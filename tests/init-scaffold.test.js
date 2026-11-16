/**
 * `/feynman init` behavior for both artifact layouts.
 *
 * Fixtures live in `os.tmpdir()`: a parent repository's `.gitignore` would
 * otherwise decide the ignore outcome (and the workspace itself ignores
 * `.scratch/`).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import { describeScaffold, looksLikeOldFeynmanGuide, PROJECT_AGENTS_TEMPLATE, scaffoldProject } from '../lib/init-scaffold.js'
import { mapArtifactPaths } from '../lib/project-paths.js'
import { checkIgnore } from '../lib/project-git.js'
import { readMarker } from '../lib/project-paths.js'

const roots = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-feynman-init-'))
  roots.push(root)
  return root
}
function gitFixture() {
  const root = fixture()
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  return root
}
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

const read = (root, ...parts) => readFileSync(join(root, ...parts), 'utf8')
const exists = (root, ...parts) => existsSync(join(root, ...parts))

test('default layout creates the hidden artifact root and the upstream project files', async () => {
  const root = fixture()
  const result = await scaffoldProject(root)
  assert.equal(result.root, '.feynman')
  assert.equal(result.source, 'default')
  assert.deepEqual(result.git, { status: 'not-a-repo', action: 'none' })
  for (const path of [
    '.feynman/project.json',
    '.feynman/.gitignore',
    '.feynman/AGENTS.template.md',
    '.feynman/outputs/.plans',
    '.feynman/outputs/.drafts',
    '.feynman/outputs/.notes',
    '.feynman/papers',
    '.feynman/notes/session-logs/README.md',
    'AGENTS.md',
  ]) {
    assert.ok(exists(root, path), path)
  }
  assert.equal(exists(root, 'experiments'), false, 'the repository experiments/ is never pre-created')
  assert.equal(exists(root, '.feynman/experiments'), false, 'autoresearch creates its session files on demand')
  assert.match(read(root, '.feynman/.gitignore'), /^fetch\/$/m)
  assert.deepEqual(JSON.parse(read(root, '.feynman/project.json')), { version: 1, artifactRoot: '.feynman' })
  assert.ok(result.created.includes('.feynman/notes/session-logs/README.md'))
  assert.ok(result.created.includes('AGENTS.md'))
})

test('a second run with the same arguments creates nothing', async () => {
  const root = fixture()
  await scaffoldProject(root)
  const second = await scaffoldProject(root)
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.changed, [])
  assert.equal(second.git.status, 'not-a-repo')
  assert.deepEqual(second.warnings, [], 'a rendered AGENTS.md is not an old guide')
})

test('the rendered AGENTS.md names the hidden root, never a bare prefix', async () => {
  const root = fixture()
  await scaffoldProject(root)
  const text = read(root, 'AGENTS.md')
  for (const dir of ['outputs', 'papers', 'notes', 'experiments']) {
    assert.ok(text.includes(`.feynman/${dir}/`), dir)
  }
  assert.deepEqual(text.match(/(?<![\w./-])(outputs|papers|notes|experiments)\//g) ?? [], [])
})

test('switching to the root layout warns when AGENTS.md still names the hidden root', async () => {
  const root = fixture()
  await scaffoldProject(root)
  const switched = await scaffoldProject(root, { root: '.' })
  assert.ok(switched.warnings.some((line) => line.includes('AGENTS.md still names .feynman/ paths')))
})

test('an existing AGENTS.md is kept, and the template is still written', async () => {
  const root = fixture()
  writeFileSync(join(root, 'AGENTS.md'), '# Project rules\n')
  const result = await scaffoldProject(root)
  assert.equal(read(root, 'AGENTS.md'), '# Project rules\n')
  assert.ok(result.kept.includes('AGENTS.md'))
  assert.ok(exists(root, '.feynman/AGENTS.template.md'))
  const second = await scaffoldProject(root)
  assert.deepEqual(second.created, [])
})

test('an old Feynman guide warns without rewriting the file', async () => {
  const root = fixture()
  const old = '# Feynman Project Guide\n\nResearch artifacts go to `notes/`, `outputs/`, `experiments/`, and `papers/`.\n'
  writeFileSync(join(root, 'AGENTS.md'), old)
  const result = await scaffoldProject(root)
  assert.ok(result.warnings.some((line) => line.includes('still describes the project-root layout')))
  assert.equal(read(root, 'AGENTS.md'), old)
})

test('looksLikeOldFeynmanGuide is narrow', () => {
  assert.equal(looksLikeOldFeynmanGuide('# Feynman Project Guide\n`notes/`, `outputs/`, `experiments/`, and `papers/`'), true)
  assert.equal(looksLikeOldFeynmanGuide('# Feynman Project Guide\nnothing here'), false)
  assert.equal(looksLikeOldFeynmanGuide('# Something else\n`notes/`, `outputs/`, `experiments/`, and `papers/`'), false)
  // Our own rendered guide names the hidden root and must not warn on every re-run.
  const rendered = mapArtifactPaths(PROJECT_AGENTS_TEMPLATE, '.feynman')
  assert.equal(looksLikeOldFeynmanGuide(rendered), false)
  assert.equal(looksLikeOldFeynmanGuide(PROJECT_AGENTS_TEMPLATE), true)
})

test('an existing session-log README is kept', async () => {
  const root = fixture()
  mkdirSync(join(root, '.feynman/notes/session-logs'), { recursive: true })
  writeFileSync(join(root, '.feynman/notes/session-logs/README.md'), 'mine\n')
  const result = await scaffoldProject(root)
  assert.equal(read(root, '.feynman/notes/session-logs/README.md'), 'mine\n')
  assert.ok(result.kept.some((path) => path.endsWith('notes/session-logs/README.md')))
})

test('a git repository gets the managed block and a second run is unchanged', async () => {
  const root = gitFixture()
  const first = await scaffoldProject(root)
  assert.equal(first.git.action, 'created')
  assert.ok(first.changed.includes('.gitignore'))
  assert.match(read(root, '.gitignore'), /# >>> dsh-feynman/)
  assert.match(read(root, '.gitignore'), /^\.feynman\/$/m)
  assert.equal(checkIgnore(root, '.feynman/outputs/.probe').ignored, true)
  const second = await scaffoldProject(root)
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.changed, [])
  assert.equal(second.git.action, 'unchanged')
  assert.deepEqual(second.warnings, [])
})

test('--track removes the block but keeps the fetch cache ignored', async () => {
  const root = gitFixture()
  await scaffoldProject(root)
  const result = await scaffoldProject(root, { tracking: 'track' })
  assert.equal(result.git.action, 'removed')
  assert.doesNotMatch(read(root, '.gitignore'), /dsh-feynman/)
  assert.equal(checkIgnore(root, '.feynman/outputs/.probe').ignored, false)
  assert.equal(checkIgnore(root, '.feynman/fetch/x').ignored, true)
})

test('switching back to --no-track restores the block idempotently', async () => {
  const root = gitFixture()
  await scaffoldProject(root)
  await scaffoldProject(root, { tracking: 'track' })
  const restored = await scaffoldProject(root, { tracking: 'no-track' })
  assert.ok(['created', 'updated'].includes(restored.git.action), restored.git.action)
  assert.match(read(root, '.gitignore'), /^\.feynman\/$/m)
  const again = await scaffoldProject(root)
  assert.equal(again.git.action, 'unchanged')
})

test('--root . keeps the upstream layout and ignores the five root paths', async () => {
  const root = gitFixture()
  const result = await scaffoldProject(root, { root: '.' })
  assert.equal(result.root, '')
  assert.equal(result.source, 'flag')
  for (const path of ['outputs/.plans', 'outputs/.drafts', 'outputs/.notes', 'papers', 'notes/session-logs']) {
    assert.ok(exists(root, path), path)
  }
  const marker = JSON.parse(read(root, '.feynman/project.json'))
  assert.equal(marker.artifactRoot, '.')
  assert.deepEqual(marker.ownedDirs, ['notes', 'outputs', 'papers'])
  const block = read(root, '.gitignore')
  for (const line of ['outputs/', 'papers/', 'notes/', 'experiments/', '.feynman/']) {
    assert.match(block, new RegExp(`^${line}$`, 'm'), line)
  }
  assert.equal(checkIgnore(root, 'outputs/.probe').ignored, true)
})

test('a marker pins the layout, and a second run respects it', async () => {
  const root = fixture()
  mkdirSync(join(root, '.feynman'), { recursive: true })
  writeFileSync(join(root, '.feynman/project.json'), '{"version":1,"artifactRoot":"."}')
  const result = await scaffoldProject(root)
  assert.equal(result.root, '')
  assert.equal(result.source, 'marker')
  assert.ok(exists(root, 'outputs/.plans'))
  assert.equal(readMarker(root).root, '')
})

test('legacy evidence selects the root layout without an explicit flag', async () => {
  const root = fixture()
  mkdirSync(join(root, 'outputs', '.plans'), { recursive: true })
  const result = await scaffoldProject(root)
  assert.equal(result.root, '')
  assert.equal(result.source, 'legacy')
  const agents = read(root, 'AGENTS.md')
  assert.ok(agents.includes('outputs/'))
  assert.ok(!agents.includes('.feynman/outputs/'))
})

test('an invalid marker stops init before any write', async () => {
  const root = fixture()
  mkdirSync(join(root, '.feynman'), { recursive: true })
  writeFileSync(join(root, '.feynman/project.json'), '{')
  const result = await scaffoldProject(root)
  assert.match(result.error, /not valid/)
  assert.equal(exists(root, 'AGENTS.md'), false)
  assert.equal(read(root, '.feynman/project.json'), '{')
})

test('a .feynman regular file is a user-fixable error, not a crash', async () => {
  const root = fixture()
  writeFileSync(join(root, '.feynman'), 'not a directory')
  const result = await scaffoldProject(root)
  assert.match(result.error, /not a directory/)
})

test('a .gitignore directory is reported as a warning and does not fail init', async () => {
  const root = gitFixture()
  mkdirSync(join(root, '.gitignore'))
  const result = await scaffoldProject(root)
  assert.equal(result.git.status, 'error')
  assert.ok(result.warnings.some((line) => line.includes('could not update .gitignore')))
  assert.ok(exists(root, 'AGENTS.md'), 'the rest of the scaffold completed')
})

test('the safety valve skips a tracked directory and warns', async () => {
  const root = gitFixture()
  mkdirSync(join(root, 'outputs'), { recursive: true })
  writeFileSync(join(root, 'outputs', 'notes.md'), '# user notes')
  execFileSync('git', ['add', 'outputs/notes.md'], { cwd: root })
  const result = await scaffoldProject(root, { root: '.' })
  assert.ok(result.warnings.some((line) => line === 'outputs/ already has content; not ignoring it'))
  assert.doesNotMatch(read(root, '.gitignore'), /^outputs\/$/m)
  for (const line of ['papers/', 'notes/', 'experiments/', '.feynman/']) {
    assert.match(read(root, '.gitignore'), new RegExp(`^${line}$`, 'm'), line)
  }
})

test('an untracked non-empty experiments/ is not hidden', async () => {
  const root = gitFixture()
  mkdirSync(join(root, 'experiments'), { recursive: true })
  writeFileSync(join(root, 'experiments', 'wip.py'), 'print(1)')
  const result = await scaffoldProject(root, { root: '.' })
  assert.ok(result.warnings.some((line) => line === 'experiments/ already has content; not ignoring it'))
  assert.doesNotMatch(read(root, '.gitignore'), /^experiments\/$/m)
})

test('a skipped user directory stays skipped on later runs', async () => {
  const root = gitFixture()
  mkdirSync(join(root, 'outputs'), { recursive: true })
  writeFileSync(join(root, 'outputs', 'build.js'), '// user build output')
  const first = await scaffoldProject(root, { root: '.' })
  assert.ok(first.warnings.some((line) => line === 'outputs/ already has content; not ignoring it'))
  assert.equal(JSON.parse(read(root, '.feynman/project.json')).skippedDirs.join(','), 'outputs')
  const second = await scaffoldProject(root, { root: '.' })
  assert.ok(second.warnings.some((line) => line === 'outputs/ already has content; not ignoring it'))
  assert.doesNotMatch(read(root, '.gitignore'), /^outputs\/$/m)
  assert.equal(checkIgnore(root, 'outputs/build.js').ignored, false)
})

test('Feynman evidence inside outputs/ still allows ignoring it', async () => {
  const root = gitFixture()
  mkdirSync(join(root, 'outputs', '.plans'), { recursive: true })
  writeFileSync(join(root, 'outputs', '.plans', 'p.md'), '# plan')
  const result = await scaffoldProject(root, { root: '.' })
  assert.ok(!result.warnings.some((line) => line.startsWith('outputs/')))
  assert.match(read(root, '.gitignore'), /^outputs\/$/m)
})

test('a root layout where every directory is the user\'s creates no block', async () => {
  const root = gitFixture()
  for (const [dir, file] of [['outputs', 'o.md'], ['papers', 'p.md'], ['notes', 'n.md'], ['experiments', 'e.py']]) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, file), 'x')
  }
  const result = await scaffoldProject(root, { root: '.' })
  assert.equal(result.git.action, 'none')
  assert.equal(result.git.artifactIgnored, false)
  assert.match(describeScaffold(result), /git: not ignored/)
  assert.ok(result.warnings.some((line) => line.includes('no artifact directory was safe to ignore')))
  assert.equal(exists(root, '.gitignore'), false)
})

test('the root layout stays idempotent when we created the directories ourselves', async () => {
  const root = gitFixture()
  await scaffoldProject(root, { root: '.' })
  const block = read(root, '.gitignore')
  const second = await scaffoldProject(root, { root: '.' })
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.changed, [])
  assert.equal(second.git.action, 'unchanged')
  assert.equal(read(root, '.gitignore'), block)
  assert.equal(block.match(/^(outputs|papers|notes|experiments|\.feynman)\/$/gm).length, 5)
})

test('an existing external ignore rule is respected instead of duplicated', async () => {
  const root = gitFixture()
  writeFileSync(join(root, '.gitignore'), '.feynman/\n')
  const result = await scaffoldProject(root)
  assert.equal(result.git.action, 'none')
  assert.doesNotMatch(read(root, '.gitignore'), /dsh-feynman/)
  const tracked = await scaffoldProject(root, { tracking: 'track' })
  assert.ok(tracked.warnings.some((line) => line.includes('still ignored')))
})

test('a symlinked .feynman inside the workspace warns; one outside fails', async () => {
  const root = fixture()
  mkdirSync(join(root, 'real'))
  try {
    symlinkSync(join(root, 'real'), join(root, '.feynman'), 'dir')
  } catch {
    return // symlinks unavailable
  }
  const inside = await scaffoldProject(root)
  assert.equal(inside.warnings.length > 0, true)
  assert.ok(inside.warnings.some((line) => line.includes('symlink')))

  const outsideRoot = fixture()
  const outside = fixture()
  try {
    symlinkSync(outside, join(outsideRoot, '.feynman'), 'dir')
  } catch {
    return
  }
  const escaped = await scaffoldProject(outsideRoot)
  assert.match(escaped.error, /outside the workspace/)
})

test('a failure after some writes reports the completed items', async () => {
  const root = fixture()
  mkdirSync(join(root, 'AGENTS.md'))
  const result = await scaffoldProject(root)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.created.includes('.feynman/'))
  assert.ok(result.created.some((path) => path.startsWith('.feynman/outputs')))
  const text = describeScaffold(result)
  assert.match(text, /created before the error: .*\.feynman\//)
})

test('the default layout checks .feynman/... symlinks, not project-root ones', async () => {
  const root = fixture()
  const outside = fixture()
  mkdirSync(join(root, '.feynman', 'outputs'), { recursive: true })
  mkdirSync(join(root, 'real-outputs'), { recursive: true })
  try {
    symlinkSync(outside, join(root, '.feynman', 'outputs', 'escape'), 'dir')
    symlinkSync(outside, join(root, 'outputs'), 'dir')
  } catch {
    return
  }
  // A project-root outputs symlink is not written by the default layout.
  const result = await scaffoldProject(root)
  assert.equal(result.error, undefined, result.error)
  assert.ok(exists(root, '.feynman/outputs/.plans'))

  const escaped = fixture()
  const elsewhere = fixture()
  mkdirSync(join(escaped, '.feynman'), { recursive: true })
  try { symlinkSync(elsewhere, join(escaped, '.feynman', 'outputs'), 'dir') } catch { return }
  const refused = await scaffoldProject(escaped)
  assert.match(refused.error, /outputs\/ is a symlink outside the workspace/)
})

test('a draft in papers/ does not make the second init drop papers/', async () => {
  const root = gitFixture()
  await scaffoldProject(root, { root: '.' })
  writeFileSync(join(root, 'papers', 'draft.md'), '# draft')
  const second = await scaffoldProject(root, { root: '.' })
  assert.ok(!second.warnings.some((line) => line.startsWith('papers/')))
  assert.match(read(root, '.gitignore'), /^papers\/$/m)
  assert.deepEqual(second.changed, [])
})

test('--track without a managed block reports action none', async () => {
  const root = gitFixture()
  const result = await scaffoldProject(root, { tracking: 'track' })
  assert.equal(result.git.action, 'none')
})

test('legacy layout offers the conversion flag', async () => {
  const root = fixture()
  mkdirSync(join(root, 'outputs', '.plans'), { recursive: true })
  const result = await scaffoldProject(root)
  assert.equal(result.source, 'legacy')
  assert.ok(result.warnings.includes('Pass --root .feynman to convert this project.'))
})

test('a moved directory that is a symlink outside the workspace is refused', async () => {
  const root = fixture()
  const outside = fixture()
  try {
    symlinkSync(outside, join(root, 'outputs'), 'dir')
  } catch {
    return
  }
  const result = await scaffoldProject(root, { root: '.' })
  assert.match(result.error, /outputs\/ is a symlink outside the workspace/)
})

test('an unreadable AGENTS.md is kept without failing init', async (t) => {
  if (process.getuid?.() === 0) { t.skip('root ignores file modes'); return }
  const root = fixture()
  const agents = join(root, 'AGENTS.md')
  writeFileSync(agents, '# private\n')
  chmodSync(agents, 0o000)
  try {
    const result = await scaffoldProject(root)
    assert.equal(result.error, undefined)
    assert.ok(result.kept.includes('AGENTS.md'))
  } finally {
    chmodSync(agents, 0o644)
  }
})

test('describeScaffold renders the layout, git state, and lists', () => {
  const text = describeScaffold({
    root: '.feynman',
    source: 'default',
    tracking: 'no-track',
    created: ['AGENTS.md'],
    kept: [],
    changed: [],
    warnings: [],
    git: { status: 'ok', action: 'created' },
  })
  assert.match(text, /artifact root \.feynman\/ \(source: default\)/)
  assert.match(text, /git: ignored \(\.gitignore managed block created\)/)
  assert.match(text, /created: AGENTS\.md/)
})

test('relative working directories are resolved before scaffolding', async () => {
  const root = fixture()
  const previous = process.cwd()
  process.chdir(tmpdir())
  try {
    const result = await scaffoldProject(relative(tmpdir(), root))
    assert.ok(!result.created.some((path) => path.startsWith('..')))
    assert.ok(exists(root, '.feynman/project.json'))
  } finally {
    process.chdir(previous)
  }
})
