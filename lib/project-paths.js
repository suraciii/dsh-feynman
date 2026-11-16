/**
 * Project artifact layout: the single authority for where research artifacts
 * live, how prompts name them, and how the project records the choice.
 *
 * A project keeps its research state under one artifact root:
 *   - `''` (empty string) means the upstream layout: artifacts at the project root.
 *   - `'.feynman'` (the default) keeps `outputs/`, `papers/`, `notes/`, and
 *     `experiments/` under that hidden directory.
 *
 * The choice is recorded in `<cwd>/.feynman/project.json` so it survives
 * sessions. Without a marker, a project that already has Feynman's old layout
 * keeps the root layout (never split an in-progress project), and everything
 * else defaults to `.feynman/`.
 *
 * This module is host-side and synchronous: command handlers build prompts
 * synchronously, and the marker is a tiny local read.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The default artifact root for projects without a marker or legacy layout. */
export const DEFAULT_ARTIFACT_ROOT = '.feynman'
/** Directory holding the layout marker; always points at the plugin namespace. */
export const MARKER_DIR = '.feynman'
/** Marker file name inside {@link MARKER_DIR}. */
export const MARKER_FILE = 'project.json'
/** Runtime cache line every `.feynman/.gitignore` carries. */
export const CACHE_IGNORE = 'fetch/'
/** Accepted `--root` / marker values. */
export const SUPPORTED_ROOTS = Object.freeze(['.', '.feynman'])
/** Directories moved under the artifact root (upstream keeps them at the root). */
export const MOVED_DIRS = Object.freeze(['outputs', 'papers', 'notes', 'experiments'])

/**
 * Normalize a user- or marker-provided root. `'.'`/`'./'` and the empty string
 * mean the project root; `'.feynman'`/`'.feynman/'` mean the hidden root.
 * Anything else (including values with whitespace) is rejected.
 * @param value - candidate root value.
 * @returns `''`, `'.feynman'`, or `null` when unsupported.
 */
export function normalizeRoot(value) {
  if (typeof value !== 'string') return null
  if (value === '' || value === '.' || value === './') return ''
  if (value === '.feynman' || value === '.feynman/') return '.feynman'
  return null
}

/** Absolute path of the layout marker for one workspace. */
export function markerPath(cwd) {
  return join(resolve(cwd), MARKER_DIR, MARKER_FILE)
}

/**
 * Read and validate the layout marker.
 * @returns `{ status: 'present', root, value, path }`,
 *          `{ status: 'missing', path }`, or `{ status: 'invalid', path, error }`.
 */
export function readMarker(cwd) {
  const path = markerPath(cwd)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // ENOTDIR means `.feynman` is a regular file: no usable marker, but the
    // caller still gets a diagnostic from init when it tries to create dirs.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'missing', path }
    return { status: 'invalid', path, error: `cannot read the marker: ${error.message}` }
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return { status: 'invalid', path, error: `not valid JSON: ${error.message}` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', path, error: 'expected a JSON object' }
  }
  const root = normalizeRoot(value.artifactRoot)
  if (root === null) {
    return { status: 'invalid', path, error: 'artifactRoot must be "." or ".feynman"' }
  }
  return { status: 'present', path, root, value }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Detect the pre-.feynman layout from Feynman-specific evidence only. Generic
 * names such as `outputs/build.js` or a repository's own `experiments/` must not
 * count, or every code repository would look like an old research project.
 * @returns `{ legacy: boolean, evidence: string[] }` with workspace-relative
 * display paths for the evidence found.
 */
export function detectLegacyLayout(cwd) {
  const root = resolve(cwd)
  const evidence = []
  if (isDirectory(join(root, 'outputs', '.plans'))) evidence.push('outputs/.plans')
  if (isDirectory(join(root, 'outputs', '.drafts'))) evidence.push('outputs/.drafts')
  try {
    const papers = readdirSync(join(root, 'papers'))
    if (papers.some((name) => name.endsWith('.provenance.md') && isFile(join(root, 'papers', name)))) {
      evidence.push('papers/*.provenance.md')
    }
  } catch { /* no papers directory */ }
  if (isFile(join(root, 'notes', 'session-logs', 'README.md'))) evidence.push('notes/session-logs/README.md')
  return { legacy: evidence.length > 0, evidence }
}

/**
 * Resolve the layout for one workspace.
 *
 * Precedence: a valid marker, then legacy-layout evidence, then the default.
 * Never throws; an invalid marker falls through to the later steps and keeps
 * its error in `detail` for the brief header and doctor.
 * @returns `{ root: '' | '.feynman', source: 'marker'|'legacy'|'default',
 *            marker: 'present'|'missing'|'invalid', detail?: string }`.
 */
export function resolveLayout(cwd) {
  const root = resolve(cwd)
  const marker = readMarker(root)
  const markerError = marker.status === 'invalid' ? marker.error : undefined
  if (marker.status === 'present') {
    return { root: marker.root, source: 'marker', marker: 'present' }
  }
  const legacy = detectLegacyLayout(root)
  if (legacy.legacy) {
    const detail = [markerError, `legacy layout: ${legacy.evidence.join(', ')}`].filter(Boolean).join('; ')
    return { root: '', source: 'legacy', marker: marker.status, ...(detail ? { detail } : {}) }
  }
  return {
    root: DEFAULT_ARTIFACT_ROOT,
    source: 'default',
    marker: marker.status,
    ...(markerError ? { detail: markerError } : {}),
  }
}

/** Display label for a root: `'.feynman/'` for the hidden layout, `'.'` for upstream. */
export function layoutLabel(root) {
  return root === '' ? '.' : `${root}/`
}

/**
 * Join artifact-relative parts under a root using POSIX separators for prompts.
 * @param root - `''` or `'.feynman'`.
 * @param parts - path segments (empty segments are ignored).
 * @returns e.g. `.feynman/outputs/.plans` or `outputs/.plans`.
 */
export function artifactDir(root, ...parts) {
  const clean = parts.filter((part) => part !== undefined && part !== null && part !== '').map(String)
  return root === '' ? clean.join('/') : [root, ...clean].join('/')
}

/** Absolute filesystem path for an artifact, resolving relative cwd. */
export function artifactPath(cwd, root, ...parts) {
  return resolve(cwd, artifactDir(root, ...parts))
}

/**
 * Rewrite artifact directory prefixes in a prompt template. Only the static
 * template text may be passed here: user-provided input is inserted after
 * mapping so it is never rewritten.
 *
 * The negative lookbehind keeps `.feynman/outputs/`, `myoutputs/`, and
 * `docs/outputs/` untouched, which also makes the function idempotent.
 * @param text - template text.
 * @param root - `''` (no-op) or `'.feynman'`.
 */
export function mapArtifactPaths(text, root) {
  if (root === '' || root === undefined || root === null) return text
  // `` `outputs` `` (a bare code span) names the directory itself; a prose word
  // like "outputs" stays untouched because only a closing backtick matches.
  return String(text)
    .replace(/(?<![\w./-])(outputs|papers|notes|experiments)\//g, `${root}/$1/`)
    .replace(/(?<![\w./-])(outputs|papers|notes|experiments)(?=`)/g, `${root}/$1`)
}

/** Count files recursively under one directory; ignores unreadable entries. */
function countFiles(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (total > 5000) return total
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += countFiles(path)
    else total += 1
  }
  return total
}

/** Whether the artifact root already holds research output (for doctor warnings). */
export function hasArtifacts(cwd, root) {
  const base = artifactPath(cwd, root)
  return MOVED_DIRS.some((dir) => countFiles(join(base, dir)) > 0)
}

/**
 * Snapshot of the upstream-layout directories for `status`/`doctor` and for
 * `--root .` decisions. Root `experiments/` is deliberately absent: it is a
 * common code-repository directory and carries no Feynman evidence.
 * @returns `{ dirs: { outputs, papers, notes }, present: string[] }`.
 */
export function legacyArtifacts(cwd) {
  const dirs = { outputs: 0, papers: 0, notes: 0 }
  const present = []
  for (const dir of Object.keys(dirs)) {
    const count = countFiles(join(resolve(cwd), dir))
    dirs[dir] = count
    if (count > 0) present.push(`${dir}/`)
  }
  return { dirs, present }
}

/**
 * Effective workspace directory for a session. The host's `workingDirectory`
 * service tracks the live directory; `session.header.cwd` is the fallback.
 * Never throws: a missing session or service simply returns `undefined`.
 */
export function workspaceRoot(ctx, session) {
  let effective
  try {
    effective = ctx?.get?.('workingDirectory')?.get?.(session)
  } catch { /* service unavailable or session-less caller */ }
  const cwd = effective ?? session?.header?.cwd
  return cwd ? resolve(cwd) : undefined
}

/**
 * Whether `target` is a symlink whose real target escapes the workspace. A
 * symlinked `.feynman` is allowed only when it resolves inside the workspace,
 * so I3 (never write outside the working directory) cannot be bypassed.
 */
export function symlinkTargetOutside(cwd, target) {
  try {
    if (!lstatSync(target).isSymbolicLink()) return false
    const rootReal = realpathSync(resolve(cwd))
    const targetReal = realpathSync(target)
    const rel = relative(rootReal, targetReal)
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  } catch {
    return false
  }
}
