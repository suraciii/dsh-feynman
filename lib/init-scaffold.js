/**
 * `/feynman init`: create the research project files deterministically.
 *
 * Upstream Feynman writes `AGENTS.md` and `notes/session-logs/README.md` from
 * fixed templates and never overwrites either file. This port keeps that
 * contract and adds the per-project artifact root: the layout is recorded in
 * the plugin's marker file, the four artifact directories live under it, and
 * whether git tracks them is expressed through a managed `.gitignore` block.
 *
 * The exported templates stay byte-identical to upstream; the chosen root is
 * applied at write time, so `--root .` still produces the upstream files.
 */
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import {
  artifactDir,
  artifactPath,
  CACHE_IGNORE,
  DEFAULT_ARTIFACT_ROOT,
  detectLegacyLayout,
  MARKER_DIR,
  MARKER_FILE,
  mapArtifactPaths,
  normalizeRoot,
  readMarker,
  symlinkTargetOutside,
} from './project-paths.js'
import {
  checkIgnore,
  isWorkTree,
  listTracked,
  readManagedBlock,
  removeManagedBlock,
  writeManagedBlock,
} from './project-git.js'

export const PROJECT_AGENTS_TEMPLATE = `# Feynman Project Guide

This file is read automatically at startup. It is the durable project memory for Feynman.

## Project Overview
- State the research question, target artifact, target venue, and key datasets or benchmarks here.

## AI Research Context
- Problem statement:
- Core hypothesis:
- Closest prior work:
- Required baselines:
- Required ablations:
- Primary metrics:
- Datasets / benchmarks:

## Ground Rules
- Do not modify raw data in \`Data/Raw/\` or equivalent raw-data folders.
- Read first, act second: inspect project structure and existing notes before making changes.
- Prefer durable artifacts in \`notes/\`, \`outputs/\`, \`experiments/\`, and \`papers/\`.
- Keep strong claims source-grounded. Include direct URLs in final writeups.

## Current Status
- Replace this section with the latest project status, known issues, and next steps.

## Task Ledger
- Track concrete tasks with IDs, owner, status, and output path.
- Mark tasks as \`todo\`, \`in_progress\`, \`done\`, \`blocked\`, or \`superseded\`.
- Do not silently merge or skip tasks; record the decision here.

## Verification Gates
- List the checks that must pass before delivery.
- For each critical claim, figure, or metric, record how it will be verified and where the raw artifact lives.
- Do not use words like \`verified\`, \`confirmed\`, or \`reproduced\` unless the underlying check actually ran.

## Honesty Contract
- Separate direct observations from inferences.
- If something is uncertain, say so explicitly.
- If a result looks cleaner than expected, assume it needs another check before it goes into the final artifact.

## Session Logging
- Use \`/log\` at the end of meaningful sessions to write a durable session note into \`notes/session-logs/\`.

## Review Readiness
- Known reviewer concerns:
- Missing experiments:
- Missing writing or framing work:
`

export const SESSION_LOGS_README = `# Session Logs

Use \`/log\` to write one durable note per meaningful Feynman session.

Recommended contents:
- what was done
- strongest findings
- artifacts written
- unresolved questions
- next steps
`

/** Files/directories this run actually created, for the command reply. */
function displayPath(cwd, path) {
  return relative(cwd, path).split(sep).join('/') || '.'
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** File contents only; an empty directory tree does not make a directory "owned". */
async function hasAnyFile(path) {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return true
    for (const entry of await readdir(path)) {
      if (await hasAnyFile(join(path, entry))) return true
    }
  } catch { /* absent or unreadable */ }
  return false
}

/** Feynman-specific evidence inside a moved directory. */
async function hasFeynmanMarkers(path, dir) {
  try {
    if (dir === 'outputs') return (await exists(join(path, '.plans'))) || (await exists(join(path, '.drafts')))
    if (dir === 'papers') return (await readdir(path)).some((name) => name.endsWith('.provenance.md'))
    if (dir === 'notes') return await exists(join(path, 'session-logs', 'README.md'))
    if (dir === 'experiments') return (await readdir(path)).some((name) => name.startsWith('autoresearch.'))
  } catch { /* absent */ }
  return false
}

async function writeFileIfMissing(path, content, { cwd, created, kept }) {
  const display = displayPath(cwd, path)
  if (await exists(path)) {
    kept.push(display)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  created.push(display)
}

const OLD_AGENTS_MESSAGE = (root) =>
  `AGENTS.md exists and still describes the project-root layout. Merge ${MARKER_DIR}/AGENTS.template.md into it, or delete the outdated artifact section.`
const MISMATCH_AGENTS_MESSAGE = () =>
  `AGENTS.md still names ${MARKER_DIR}/ paths but the project uses the root layout; run /feynman init --root ${MARKER_DIR} or update AGENTS.md.`

/**
 * Whether a file is a previous port template that names project-root paths.
 * Only used to warn, never to rewrite a user file.
 */
export function looksLikeOldFeynmanGuide(text) {
  if (!text.includes('# Feynman Project Guide')) return false
  // A rendered template mentions the marker dir (`${MARKER_DIR}/notes/...`); only
  // the upstream root layout lacks that prefix, so the prefix is decisive.
  if (text.includes(`${MARKER_DIR}/`)) return false
  return text.includes('`notes/`, `outputs/`, `experiments/`, and `papers/`')
    || text.includes('notes/session-logs/')
}

/**
 * Create the project layout and report what changed.
 *
 * @param cwd - workspace directory.
 * @param options - `{ root?: '.' | hidden root, tracking?: 'track'|'no-track' }`.
 * @returns the result consumed by {@link describeScaffold}; `{ error }` for a
 *          user-fixable precondition (invalid marker, escaping symlink).
 */
export async function scaffoldProject(cwd, options = {}) {
  const rootDir = resolve(cwd)
  if (!rootDir) return { error: 'init needs a workspace directory' }

  const marker = readMarker(rootDir)
  if (marker.status === 'invalid') {
    return { error: `The ${MARKER_DIR}/${MARKER_FILE} file is not valid; fix or delete it before running init.` }
  }
  if (symlinkTargetOutside(rootDir, join(rootDir, MARKER_DIR))) {
    return { error: `The ${MARKER_DIR} directory is a symlink outside the workspace; refusing to write there.` }
  }
  const markerDirInfo = await statIfExists(join(rootDir, MARKER_DIR))
  if (markerDirInfo && !markerDirInfo.isDirectory()) {
    return { error: `${MARKER_DIR} exists but is not a directory; move it aside before running init.` }
  }
  const warnings = []
  try {
    if ((await lstat(join(rootDir, MARKER_DIR))).isSymbolicLink()) warnings.push(`${MARKER_DIR} is a symlink; artifacts are written through it`)
  } catch { /* absent */ }

  const explicitRoot = options.root === undefined ? undefined : normalizeRoot(options.root)
  if (options.root !== undefined && explicitRoot === null) {
    return { error: `Only \`.\` and \`${DEFAULT_ARTIFACT_ROOT}\` are supported for --root.` }
  }
  let root
  let source
  if (explicitRoot !== undefined) {
    root = explicitRoot
    source = 'flag'
  } else if (marker.status === 'present') {
    root = marker.root
    source = 'marker'
  } else if (detectLegacyLayout(rootDir).legacy) {
    root = ''
    source = 'legacy'
  } else {
    root = DEFAULT_ARTIFACT_ROOT
    source = 'default'
  }

  for (const dir of ['outputs', 'papers', 'notes', 'experiments']) {
    const path = artifactPath(rootDir, root, dir)
    if (symlinkTargetOutside(rootDir, path)) {
      return { error: `${dir}/ is a symlink outside the workspace; refusing to write there.` }
    }
  }
  const knownDirs = ['outputs', 'papers', 'notes', 'experiments']
  if (source === 'legacy') warnings.push(`Pass --root ${DEFAULT_ARTIFACT_ROOT} to convert this project.`)
  const persistedList = (field) => (marker.status === 'present' && marker.root === root && Array.isArray(marker.value[field])
    ? marker.value[field].filter((dir) => knownDirs.includes(dir))
    : [])
  const persistedSkips = persistedList('skippedDirs')
  const persistedOwned = persistedList('ownedDirs')

  const git = isWorkTree(rootDir)
  const blockFile = join(rootDir, '.gitignore')
  let blockText = ''
  try { blockText = await readFile(blockFile, 'utf8') } catch { /* absent: treated as no block */ }
  const managed = readManagedBlock(blockText)
  const probe = `${artifactDir(root, 'outputs')}/.probing`
  const alreadyIgnored = git.ok ? checkIgnore(rootDir, probe).ignored : false
  const tracking = options.tracking === 'track' || options.tracking === 'no-track'
    ? options.tracking
    : managed
      ? 'no-track'
      : alreadyIgnored
        ? 'no-track'
        : marker.status === 'present'
          ? 'track'
          : 'no-track'

  // Safety valve: never hide a directory the project already owned. Evaluate on
  // the pre-creation state; empty subdirectories do not make a directory owned.
  const skipped = []
  const createdRootDirs = new Set(persistedOwned)
  if (git.ok && root === '' && tracking === 'no-track') {
    for (const dir of knownDirs) {
      const path = join(rootDir, dir)
      if (persistedOwned.includes(dir)) continue
      // Skips are remembered: a directory we created plugin state in must not
      // flip to "ours" on the next run and hide the user's files.
      const foreign = persistedSkips.includes(dir)
        || listTracked(rootDir, dir).length > 0
        || await hasAnyFile(path)
      if (foreign && (persistedSkips.includes(dir) || !(await hasFeynmanMarkers(path, dir)))) {
        skipped.push(dir)
        warnings.push(`${dir}/ already has content; not ignoring it`)
      }
    }
  }

  const created = []
  const kept = []
  const changed = []
  const createdDir = async (path, rootDirName) => {
    if (await exists(path)) return
    await mkdir(path, { recursive: true })
    created.push(`${displayPath(rootDir, path)}/`)
    if (rootDirName) createdRootDirs.add(rootDirName)
  }

  let gitResult = { status: 'ok', action: 'none' }
  try {
    await createdDir(join(rootDir, MARKER_DIR))
    await createdDir(artifactPath(rootDir, root, 'outputs'), 'outputs')
    await createdDir(artifactPath(rootDir, root, 'papers'), 'papers')
    await createdDir(artifactPath(rootDir, root, 'notes'), 'notes')
    for (const dir of ['.plans', '.drafts', '.notes']) await createdDir(artifactPath(rootDir, root, 'outputs', dir))
    await createdDir(artifactPath(rootDir, root, 'notes', 'session-logs'))

    // Marker: merge, never clobber unrelated fields.
    const nextSkips = [...new Set([...persistedSkips, ...skipped])].sort()
    const nextOwned = root === '' ? [...createdRootDirs].sort() : []
    const markerValue = {
      ...(marker.status === 'present' ? marker.value : {}),
      version: 1,
      artifactRoot: root === '' ? '.' : root,
    }
    if (nextSkips.length > 0) markerValue.skippedDirs = nextSkips
    else delete markerValue.skippedDirs
    if (nextOwned.length > 0) markerValue.ownedDirs = nextOwned
    else delete markerValue.ownedDirs
    const markerText = `${JSON.stringify(markerValue, null, 2)}\n`
    if (marker.status === 'present' && `${JSON.stringify(marker.value, null, 2)}\n` === markerText) {
      kept.push(`${MARKER_DIR}/${MARKER_FILE}`)
    } else {
      await writeFile(marker.path, markerText)
      if (marker.status === 'present') changed.push(`${MARKER_DIR}/${MARKER_FILE}`)
      else created.push(`${MARKER_DIR}/${MARKER_FILE}`)
    }

    // Runtime cache ignore stays local to the plugin namespace and always exists.
    const cacheIgnore = join(rootDir, MARKER_DIR, '.gitignore')
    if (!(await exists(cacheIgnore))) {
      await writeFile(cacheIgnore, `${CACHE_IGNORE}\n`)
      created.push(`${MARKER_DIR}/.gitignore`)
    } else {
      const current = await readFile(cacheIgnore, 'utf8')
      if (current.split(/\r?\n/).map((line) => line.trim()).includes(CACHE_IGNORE)) kept.push(`${MARKER_DIR}/.gitignore`)
      else {
        await writeFile(cacheIgnore, `${current}${current.endsWith('\n') ? '' : '\n'}${CACHE_IGNORE}\n`)
        changed.push(`${MARKER_DIR}/.gitignore`)
      }
    }

    await writeFileIfMissing(artifactPath(rootDir, root, 'notes', 'session-logs', 'README.md'), SESSION_LOGS_README, { cwd: rootDir, created, kept })

    const renderedAgents = mapArtifactPaths(PROJECT_AGENTS_TEMPLATE, root)
    const agentsPath = join(rootDir, 'AGENTS.md')
    if (await exists(agentsPath)) {
      kept.push('AGENTS.md')
      let agentsText
      try {
        agentsText = await readFile(agentsPath, 'utf8')
      } catch (error) {
        if (error?.code === 'EISDIR') throw new Error('AGENTS.md is a directory; move it aside before running init.')
        /* unreadable for another reason: kept, not inspected */
      }
      if (agentsText !== undefined) {
        if (root !== '' && looksLikeOldFeynmanGuide(agentsText)) warnings.push(OLD_AGENTS_MESSAGE(root))
        else if (root === '' && agentsText.includes('# Feynman Project Guide') && agentsText.includes(`${MARKER_DIR}/`)) warnings.push(MISMATCH_AGENTS_MESSAGE())
      }
    } else {
      await writeFile(agentsPath, renderedAgents)
      created.push('AGENTS.md')
    }
    await writeFileIfMissing(join(rootDir, MARKER_DIR, 'AGENTS.template.md'), renderedAgents, { cwd: rootDir, created, kept })

    if (!git.ok) {
      gitResult = { status: git.reason === 'git-not-found' ? 'unavailable' : 'not-a-repo', action: 'none' }
    } else if (symlinkTargetOutside(rootDir, blockFile)) {
      gitResult = { status: 'error', action: 'none', detail: '.gitignore is a symlink outside the workspace' }
      warnings.push('git ignore not updated: .gitignore is a symlink outside the workspace')
    } else if (tracking === 'track') {
      const result = removeManagedBlock(blockFile)
      const action = result.action === 'unchanged' && managed === null ? 'none' : result.action
      gitResult = { status: result.error ? 'error' : 'ok', action, artifactIgnored: false, ...(result.error ? { detail: result.error } : {}) }
      if (result.error) warnings.push(`could not update .gitignore: ${result.error}`)
      else if (checkIgnore(rootDir, probe).ignored) {
        warnings.push(`track requested but ${artifactDir(root, 'outputs')}/ is still ignored by an existing rule`)
      }
    } else {
      const ignoredDirs = root === ''
        ? ['outputs', 'papers', 'notes', 'experiments'].filter((dir) => !skipped.includes(dir))
        : []
      const lines = [...ignoredDirs.map((dir) => `${dir}/`), `${MARKER_DIR}/`]
      if (managed === null && alreadyIgnored) {
        gitResult = { status: 'ok', action: 'none', artifactIgnored: true, detail: 'already ignored by an existing rule' }
      } else if (root === '' && ignoredDirs.length === 0) {
        gitResult = { status: 'ok', action: 'none', artifactIgnored: false }
        warnings.push('no artifact directory was safe to ignore; .gitignore left unchanged')
      } else {
        const result = writeManagedBlock(blockFile, lines)
        gitResult = { status: result.error ? 'error' : 'ok', action: result.action, ...(result.error ? { detail: result.error } : { artifactIgnored: true }) }
        if (result.error) warnings.push(`could not update .gitignore: ${result.error}`)
        else {
          for (const line of lines) {
            const dir = line.replace(/\/$/, '')
            if (!checkIgnore(rootDir, `${dir}/.probing`).ignored) {
              warnings.push(`git ignore did not take effect for ${line} (see git check-ignore -v)`)
            }
          }
        }
      }
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      root,
      source,
      tracking,
      markerPath: marker.path,
      created,
      kept,
      changed,
      warnings,
      git: gitResult,
    }
  }

  if (['created', 'updated', 'removed'].includes(gitResult.action)) changed.push('.gitignore')

  return {
    root,
    source,
    tracking,
    markerPath: marker.path,
    created,
    kept,
    changed,
    warnings,
    git: gitResult,
  }
}

async function statIfExists(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** Render the `init` outcome for the command reply. */
export function describeScaffold(result) {
  if (result?.error) {
    const parts = [result.error]
    if (result.created?.length) parts.push(`created before the error: ${result.created.join(', ')}`)
    if (result.kept?.length) parts.push(`kept before the error: ${result.kept.join(', ')}`)
    if (result.changed?.length) parts.push(`changed before the error: ${result.changed.join(', ')}`)
    return parts.join('\n')
  }
  const label = result.root === '' ? '.' : `${result.root}/`
  const state = result.tracking === 'track'
    ? 'tracked'
    : result.git?.artifactIgnored === false ? 'not ignored' : 'ignored'
  const git = result.git?.status === 'ok'
    ? `${state}${result.git.detail ? ` (${result.git.detail})` : result.git.action !== 'none' && result.git.action !== 'unchanged' ? ` (.gitignore managed block ${result.git.action})` : ''}`
    : result.git?.status === 'not-a-repo'
      ? 'not a repository (ignore rules unchanged)'
      : result.git?.status === 'unavailable'
        ? 'git unavailable (ignore rules unchanged)'
        : `error (${result.git?.detail ?? 'ignore rules not updated'})`
  const parts = [`Feynman project: artifact root ${label} (source: ${result.source}); git: ${git}.`]
  parts.push(`created: ${result.created.length ? result.created.join(', ') : 'nothing'}`)
  if (result.kept.length) parts.push(`kept: ${result.kept.join(', ')}`)
  if (result.changed.length) parts.push(`changed: ${result.changed.join(', ')}`)
  if (result.warnings.length) parts.push(`warnings: ${result.warnings.join('; ')}`)
  return parts.join('\n')
}
