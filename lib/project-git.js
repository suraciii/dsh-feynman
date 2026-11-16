/**
 * Git plumbing for `/feynman init`: repository detection, effective ignore
 * state, tracked files, and the `dsh-feynman` managed block in `.gitignore`.
 *
 * Nothing here throws for expected non-repository / not-ignored outcomes:
 * `execFileSync` throws on every non-zero exit (1 = not ignored, 128 = not a
 * repository), so every call inspects the exit status instead of relying on
 * exceptions for control flow.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** Opening line of the block this plugin owns. */
export const MANAGED_START = '# >>> dsh-feynman (managed by /feynman init)'
/** Closing line of the block this plugin owns. */
export const MANAGED_END = '# <<< dsh-feynman'

/**
 * Run one git command.
 * @returns `{ ok: true, stdout }` or `{ ok: false, status, stdout, stderr, reason }`.
 *          `reason` is `'git-not-found'` when the binary is missing, otherwise `'exit'`.
 */
function runGit(cwd, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    return { ok: true, status: 0, stdout }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, status: null, stdout: '', stderr: '', reason: 'git-not-found' }
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : null,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      reason: 'exit',
    }
  }
}

/**
 * Whether `cwd` is inside a git work tree. Works for worktrees and submodules,
 * where `.git` is a file rather than a directory.
 * @returns `{ ok: true }` or `{ ok: false, reason: 'not-a-repo'|'git-not-found'|'error' }`.
 */
export function isWorkTree(cwd) {
  const result = runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!result.ok) {
    if (result.reason === 'git-not-found') return { ok: false, reason: 'git-not-found' }
    return { ok: false, reason: 'not-a-repo' }
  }
  return { ok: result.stdout.trim() === 'true' }
}

/**
 * Effective ignore state for one path, via `git check-ignore -v`.
 *
 * The exit status alone is not enough: a path excluded by a `!` rule also exits
 * 0 and prints the negated pattern, so the pattern decides. The output is
 * `<source>:<lineno>:<pattern>\t<pathname>`; parse the meta from the left
 * (non-greedy source) so a Windows drive-letter colon stays intact.
 * @returns `{ ignored, source?, raw?, reason? }`.
 */
export function checkIgnore(cwd, relPath, { verbose = false } = {}) {
  const result = runGit(cwd, ['check-ignore', '-v', '--', relPath])
  if (!result.ok) {
    if (result.status === 1) return { ignored: false }
    return { ignored: false, reason: result.reason === 'git-not-found' ? 'git-not-found' : 'git-error' }
  }
  const line = result.stdout.split('\n').find((entry) => entry.length > 0)
  if (!line) return { ignored: false }
  const tab = line.indexOf('\t')
  const meta = tab === -1 ? line : line.slice(0, tab)
  const match = /^(.*?):(\d+):([\s\S]*)$/.exec(meta)
  const source = match ? match[1] : meta
  const pattern = match ? match[3] : meta
  return {
    ignored: !pattern.startsWith('!'),
    source,
    ...(verbose ? { raw: line } : {}),
  }
}

/** Files git knows about under `relPath` (staged or committed); `[]` on any failure. */
export function listTracked(cwd, relPath) {
  const result = runGit(cwd, ['ls-files', '--', relPath])
  if (!result.ok) return []
  return result.stdout.split('\n').filter((line) => line.length > 0)
}

/** Split text into lines while preserving each line's own ending. */
function rawLines(text) {
  if (text === '') return []
  const lines = []
  const pattern = /[^\n]*\n|[^\n]+$/g
  let match
  while ((match = pattern.exec(text)) !== null) lines.push(match[0])
  return lines
}

function stripEnding(line) {
  return line.replace(/\r?\n$/, '')
}

/**
 * Locate the managed block. Line numbers are 0-based indices into the
 * newline-preserving line list.
 * @returns `{ startLine, endLine, lines }`, `{ truncated: true, startLine }`, or `null`.
 */
export function readManagedBlock(text) {
  const lines = rawLines(text)
  const start = lines.findIndex((line) => stripEnding(line).trim() === MANAGED_START)
  if (start < 0) return null
  const end = lines.findIndex((line, index) => index > start && stripEnding(line).trim() === MANAGED_END)
  if (end < 0) return { truncated: true, startLine: start }
  return {
    startLine: start,
    endLine: end,
    lines: lines.slice(start + 1, end).map(stripEnding),
  }
}

function detectEol(text) {
  const firstBreak = text.indexOf('\n')
  return firstBreak > 0 && text[firstBreak - 1] === '\r' ? '\r\n' : '\n'
}

function blockLines(lines, eol, lastEnding) {
  const values = [MANAGED_START, ...lines, MANAGED_END]
  return values.map((value, index) => (index === values.length - 1 ? `${value}${lastEnding}` : `${value}${eol}`))
}

/**
 * Write (or update) the managed block in a `.gitignore` file.
 *
 * Content outside the block is preserved byte-for-byte; only trailing blank
 * lines at the append point are normalized to one separator. An empty `lines`
 * array removes the block.
 * @returns `{ changed, action: 'created'|'updated'|'unchanged'|'none', error? }`.
 */
export function writeManagedBlock(file, lines = []) {
  if (lines.length === 0) return removeManagedBlock(file)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') return { changed: false, action: 'none', error: `cannot read ${file}: ${error.message}` }
  }
  const existing = readManagedBlock(text)
  if (existing?.truncated) return { changed: false, action: 'none', error: 'truncated' }
  if (existing && existing.lines.length === lines.length && existing.lines.every((line, index) => line === lines[index])) {
    return { changed: false, action: 'unchanged' }
  }
  const eol = detectEol(text)
  const rows = rawLines(text)
  if (existing) {
    const endRow = rows[existing.endLine] ?? ''
    const lastEnding = /\r?\n$/.exec(endRow)?.[0] ?? ''
    rows.splice(existing.startLine, existing.endLine - existing.startLine + 1, ...blockLines(lines, eol, lastEnding))
    writeFileSync(file, rows.join(''))
    return { changed: true, action: 'updated' }
  }
  // Append: keep the existing text, ensure exactly one blank separator line.
  if (rows.length > 0) {
    if (!rows.at(-1).endsWith('\n')) rows[rows.length - 1] = `${rows.at(-1)}${eol}`
    while (rows.length > 1 && stripEnding(rows.at(-1)) === '' && stripEnding(rows.at(-2)) === '') rows.pop()
    if (rows.length > 0 && stripEnding(rows.at(-1)) !== '') rows.push(eol)
  }
  const created = text === ''
  rows.push(...blockLines(lines, eol, eol))
  writeFileSync(file, rows.join(''))
  return { changed: true, action: created ? 'created' : 'updated' }
}

/**
 * Remove this plugin's block, collapsing the blank lines it leaves behind.
 * @returns `{ changed, action: 'removed'|'unchanged', error? }`.
 */
export function removeManagedBlock(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { changed: false, action: 'unchanged' }
    return { changed: false, action: 'none', error: `cannot read ${file}: ${error.message}` }
  }
  const existing = readManagedBlock(text)
  if (!existing) return { changed: false, action: 'unchanged' }
  if (existing.truncated) return { changed: false, action: 'none', error: 'truncated' }
  const rows = rawLines(text)
  const atEnd = existing.endLine === rows.length - 1
  rows.splice(existing.startLine, existing.endLine - existing.startLine + 1)
  if (atEnd) {
    // The separator we appended before the block is now trailing whitespace.
    while (rows.length > 0 && stripEnding(rows.at(-1)) === '') rows.pop()
  } else {
    // Collapse a double blank at the seam only; content elsewhere is untouched.
    while (existing.startLine > 0 && existing.startLine < rows.length
      && stripEnding(rows[existing.startLine - 1]) === '' && stripEnding(rows[existing.startLine]) === '') {
      rows.splice(existing.startLine, 1)
    }
  }
  const next = rows.join('')
  writeFileSync(file, next)
  return { changed: true, action: 'removed' }
}
