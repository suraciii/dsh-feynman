/**
 * `/feynman init`: create the research project files deterministically.
 *
 * Upstream Feynman writes `AGENTS.md` and `notes/session-logs/README.md` from
 * fixed templates and never overwrites either file. The port used to route this
 * through a model turn, which could skip directories or rewrite an existing
 * AGENTS.md; this module keeps the upstream contract in code.
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

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

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Create `notes/`, `notes/session-logs/`, `AGENTS.md` and the log README.
 * Existing files are reported as kept, never rewritten.
 */
export async function scaffoldProject(root) {
  if (!root) throw new Error('init needs a workspace directory')
  const notes = join(root, 'notes')
  const logs = join(notes, 'session-logs')
  await mkdir(logs, { recursive: true })
  const created = []
  const kept = []
  const agentsPath = join(root, 'AGENTS.md')
  if (await exists(agentsPath)) kept.push('AGENTS.md')
  else {
    await writeFile(agentsPath, PROJECT_AGENTS_TEMPLATE)
    created.push('AGENTS.md')
  }
  const readmePath = join(logs, 'README.md')
  if (await exists(readmePath)) kept.push('notes/session-logs/README.md')
  else {
    await writeFile(readmePath, SESSION_LOGS_README)
    created.push('notes/session-logs/README.md')
  }
  return { created, kept, agentsPath, readmePath }
}

/** `init` results are reported the way upstream does: created vs kept. */
export function describeScaffold({ created, kept }) {
  const createdText = created.length ? `created: ${created.join(', ')}` : 'created: nothing'
  const keptText = kept.length ? `; kept existing: ${kept.join(', ')}` : ''
  return `${createdText}${keptText}. Fill in AGENTS.md before the next long run.`
}
