/**
 * Unit tests for the git plumbing used by `/feynman init`.
 *
 * Git cases create their own repository in a temporary directory outside the
 * workspace; no commit or identity configuration is needed.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkIgnore,
  isWorkTree,
  listTracked,
  MANAGED_END,
  MANAGED_START,
  readManagedBlock,
  removeManagedBlock,
  writeManagedBlock,
} from '../lib/project-git.js'

const roots = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-feynman-git-'))
  roots.push(root)
  return root
}
function gitRepo() {
  const root = fixture()
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  return root
}
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

test('isWorkTree recognizes a repository, a non-repository, and a subdirectory', () => {
  const repo = gitRepo()
  assert.deepEqual(isWorkTree(repo), { ok: true })
  mkdirSync(join(repo, 'nested'), { recursive: true })
  assert.deepEqual(isWorkTree(join(repo, 'nested')), { ok: true })
  assert.equal(isWorkTree(fixture()).ok, false)
})

test('isWorkTree reports a missing git binary without throwing', () => {
  const root = fixture()
  // An empty PATH directory guarantees execvp cannot resolve `git`; an empty
  // PATH value can fall back to the platform's default search path.
  const emptyPath = fixture()
  const moduleUrl = new URL('../lib/project-git.js', import.meta.url).href
  const script = `import { isWorkTree } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(isWorkTree(${JSON.stringify(root)})))`
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyPath, Path: emptyPath },
  })
  assert.deepEqual(JSON.parse(stdout), { ok: false, reason: 'git-not-found' })
})

test('checkIgnore follows the effective rules, including negations', () => {
  const repo = gitRepo()
  writeFileSync(join(repo, '.gitignore'), 'outputs/*\n!outputs/keep.txt\n')
  assert.equal(checkIgnore(repo, 'outputs/other.txt').ignored, true)
  // `git check-ignore -v` exits 0 for a negated path too; the pattern decides.
  const kept = checkIgnore(repo, 'outputs/keep.txt', { verbose: true })
  assert.equal(kept.ignored, false)
  assert.match(kept.raw, /!outputs\/keep\.txt/)
  assert.equal(checkIgnore(repo, '.feynman/outputs/.probing').ignored, false)
})

test('checkIgnore answers for paths that do not exist yet', () => {
  const repo = gitRepo()
  writeFileSync(join(repo, '.gitignore'), '.feynman/\n')
  assert.equal(checkIgnore(repo, '.feynman/outputs/not-created.log').ignored, true)
})

test('checkIgnore outside a repository is not ignored, with a reason', () => {
  const root = fixture()
  const result = checkIgnore(root, 'outputs/x')
  assert.equal(result.ignored, false)
  assert.ok(result.reason === 'git-not-found' || result.reason === 'git-error')
})

test('listTracked returns staged files under a path and [] outside a repository', () => {
  const repo = gitRepo()
  mkdirSync(join(repo, 'outputs'), { recursive: true })
  writeFileSync(join(repo, 'outputs', 'kept.md'), '#')
  execFileSync('git', ['add', 'outputs/kept.md'], { cwd: repo })
  assert.deepEqual(listTracked(repo, 'outputs'), ['outputs/kept.md'])
  assert.deepEqual(listTracked(repo, 'papers'), [])
  assert.deepEqual(listTracked(fixture(), 'outputs'), [])
})

test('readManagedBlock locates the block with 0-based line numbers', () => {
  assert.equal(readManagedBlock('node_modules/\n'), null)
  const text = `a\n${MANAGED_START}\n.feynman/\n${MANAGED_END}\nb\n`
  assert.deepEqual(readManagedBlock(text), { startLine: 1, endLine: 3, lines: ['.feynman/'] })
  assert.deepEqual(readManagedBlock(`${MANAGED_START}\n.feynman/\n`), { truncated: true, startLine: 0 })
})

test('writeManagedBlock creates, updates, and stays unchanged', () => {
  const root = fixture()
  const file = join(root, '.gitignore')

  const created = writeManagedBlock(file, ['.feynman/'])
  assert.deepEqual(created, { changed: true, action: 'created' })
  assert.equal(readFileSync(file, 'utf8'), `${MANAGED_START}\n.feynman/\n${MANAGED_END}\n`)

  const unchanged = writeManagedBlock(file, ['.feynman/'])
  assert.deepEqual(unchanged, { changed: false, action: 'unchanged' })

  const updated = writeManagedBlock(file, ['outputs/', 'papers/'])
  assert.deepEqual(updated, { changed: true, action: 'updated' })
  assert.equal(readFileSync(file, 'utf8'), `${MANAGED_START}\noutputs/\npapers/\n${MANAGED_END}\n`)
})

test('writeManagedBlock appends after existing content with one separator line', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, 'node_modules/')
  assert.deepEqual(writeManagedBlock(file, ['.feynman/']), { changed: true, action: 'updated' })
  assert.equal(readFileSync(file, 'utf8'), `node_modules/\n\n${MANAGED_START}\n.feynman/\n${MANAGED_END}\n`)
})

test('writeManagedBlock collapses extra trailing blank lines before appending', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, 'node_modules/\n\n\n')
  writeManagedBlock(file, ['.feynman/'])
  assert.equal(readFileSync(file, 'utf8'), `node_modules/\n\n${MANAGED_START}\n.feynman/\n${MANAGED_END}\n`)
})

test('writeManagedBlock preserves content outside the block and keeps CRLF files CRLF', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, 'node_modules\r\n')
  writeManagedBlock(file, ['.feynman/'])
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^node_modules\r\n\r\n/)
  assert.ok(text.includes(`${MANAGED_START}\r\n.feynman/\r\n${MANAGED_END}\r\n`))
  writeManagedBlock(file, ['outputs/'])
  assert.match(readFileSync(file, 'utf8'), /^node_modules\r\n/)
})

test('writeManagedBlock refuses a truncated block instead of guessing', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, `node_modules/\n${MANAGED_START}\n.feynman/\n`)
  const result = writeManagedBlock(file, ['.feynman/'])
  assert.deepEqual(result, { changed: false, action: 'none', error: 'truncated' })
  assert.equal(readFileSync(file, 'utf8'), `node_modules/\n${MANAGED_START}\n.feynman/\n`)
})

test('writeManagedBlock on an empty file writes only the block', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, '')
  assert.deepEqual(writeManagedBlock(file, ['.feynman/']), { changed: true, action: 'created' })
  assert.equal(readFileSync(file, 'utf8'), `${MANAGED_START}\n.feynman/\n${MANAGED_END}\n`)
})

test('writeManagedBlock updates a block with content before and after it', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, `before\n${MANAGED_START}\n.feynman/\n${MANAGED_END}\nafter\n`)
  assert.deepEqual(writeManagedBlock(file, ['papers/']), { changed: true, action: 'updated' })
  assert.equal(readFileSync(file, 'utf8'), `before\n${MANAGED_START}\npapers/\n${MANAGED_END}\nafter\n`)
})

test('the inserted block follows the first line EOL of a mixed file', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, 'first\nsecond\r\n')
  writeManagedBlock(file, ['.feynman/'])
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('first\nsecond\r\n\n'))
  assert.ok(text.includes(`${MANAGED_START}\n.feynman/\n${MANAGED_END}\n`))
})

test('removeManagedBlock deletes only the block and repairs the seam', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, `a\n${MANAGED_START}\n.feynman/\n${MANAGED_END}\n\nb\n`)
  assert.deepEqual(removeManagedBlock(file), { changed: true, action: 'removed' })
  assert.equal(readFileSync(file, 'utf8'), 'a\n\nb\n')
})

test('removeManagedBlock drops the separator when the block was last', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, `node_modules/\n\n${MANAGED_START}\n.feynman/\n${MANAGED_END}\n`)
  assert.deepEqual(removeManagedBlock(file), { changed: true, action: 'removed' })
  assert.equal(readFileSync(file, 'utf8'), 'node_modules/\n')
})

test('removeManagedBlock is a no-op without a block', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeFileSync(file, 'node_modules/\n')
  assert.deepEqual(removeManagedBlock(file), { changed: false, action: 'unchanged' })
  assert.deepEqual(removeManagedBlock(join(root, 'missing')), { changed: false, action: 'unchanged' })
})

test('writeManagedBlock with an empty line list removes the block', () => {
  const root = fixture()
  const file = join(root, '.gitignore')
  writeManagedBlock(file, ['.feynman/'])
  writeManagedBlock(file, [])
  assert.equal(readFileSync(file, 'utf8'), '')
})
