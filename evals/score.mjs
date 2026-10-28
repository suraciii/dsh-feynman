/**
 * Deterministic scoring for research-quality evals.
 *
 * A row answers "did this run leave the artifacts the workflow promises, and are
 * they shaped like evidence rather than prose?" — no model judge, no network.
 * Citation *validity* (arXiv/Crossref resolution) is a later stage; this module
 * only counts identifiers and checks the local contract.
 *
 * @module dsh-feynman/evals/score
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Provenance labels the deepresearch/lit prompts require. Order is display order. */
export const PROVENANCE_FIELDS = [
  'Date',
  'Rounds',
  'Sources consulted',
  'Sources accepted',
  'Sources rejected',
  'Verification',
  'Plan',
  'Research files',
]

/** Final-artifact names by workflow, most specific first, then the upstream fallback. */
const FINAL_CANDIDATES = {
  lit: slug => [`outputs/${slug}-lit-review.md`, `outputs/${slug}.md`],
  deepresearch: slug => [`outputs/${slug}-brief.md`, `outputs/${slug}.md`],
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function listMarkdown(dir) {
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.md') && isFile(join(dir, name)))
      .sort()
  } catch {
    return []
  }
}

/**
 * Locate the final research artifact for a run.
 * Tries the workflow's declared names, then a slug-prefixed scan under
 * `outputs/` and `papers/`, skipping provenance/source-check sidecars.
 * @param workdir - the run's workspace.
 * @param slug - the run slug.
 * @param workflow - `lit` or `deepresearch`.
 * @returns the path relative to `workdir`, or undefined.
 */
export function findFinal(workdir, slug, workflow) {
  const declared = (FINAL_CANDIDATES[workflow] ?? FINAL_CANDIDATES.lit)(slug)
  for (const candidate of [...declared, `papers/${slug}.md`]) {
    if (isFile(join(workdir, candidate))) return candidate
  }
  for (const dir of ['outputs', 'papers']) {
    for (const name of listMarkdown(join(workdir, dir))) {
      if (name.endsWith('.provenance.md') || name.endsWith('-source-check.md')) continue
      const stem = name.slice(0, -3)
      if (stem === slug || stem.startsWith(`${slug}-`) || stem.startsWith(slug)) return `${dir}/${name}`
    }
  }
  return undefined
}

/**
 * Locate the provenance sidecar for a final artifact.
 * @param workdir - the run's workspace.
 * @param finalPath - result of {@link findFinal}.
 * @param slug - the run slug.
 * @returns the path relative to `workdir`, or undefined.
 */
export function findProvenance(workdir, finalPath, slug) {
  const candidates = []
  if (finalPath !== undefined) candidates.push(finalPath.replace(/\.md$/, '.provenance.md'))
  candidates.push(
    `outputs/${slug}.provenance.md`,
    `outputs/${slug}-brief.provenance.md`,
    `outputs/${slug}-lit-review.provenance.md`,
    `papers/${slug}.provenance.md`,
  )
  for (const candidate of candidates) {
    if (isFile(join(workdir, candidate))) return candidate
  }
  for (const dir of ['outputs', 'papers']) {
    for (const name of listMarkdown(join(workdir, dir))) {
      if (!name.endsWith('.provenance.md')) continue
      const stem = name.slice(0, -'.provenance.md'.length)
      if (stem === slug || stem.startsWith(`${slug}-`) || stem.startsWith(slug)) return `${dir}/${name}`
    }
  }
  return undefined
}

/**
 * Count how many required provenance labels appear as `- **Label:**` items.
 * @param text - provenance file contents.
 * @returns the number of labels present (0-8).
 */
export function countProvenanceFields(text) {
  return PROVENANCE_FIELDS.filter(label => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`-\\s*\\*\\*${escaped}:\\*\\*`, 'i').test(text)
  }).length
}

/**
 * Extract unique URLs, preferring the document's Sources section when present.
 * @param text - final artifact contents.
 * @returns `{ count, section, urls }`.
 */
export function extractSources(text) {
  const heading = /^#{1,3}\s*(?:sources|references|bibliography)\b.*$/im
  const match = heading.exec(text)
  const section = match !== null
  const body = section ? text.slice(match.index + match[0].length) : text
  const urls = new Set()
  for (const found of body.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    urls.add(found[0].replace(/[.,;:]+$/, ''))
  }
  return { count: urls.size, section, urls: [...urls] }
}

/**
 * Extract cited identifiers the way the resolver sees them.
 * arXiv needs a URL/`arXiv:`/`10.48550/arxiv.` prefix so version numbers and
 * dates are not mistaken for papers; DOIs are deduplicated case-insensitively
 * and arXiv's own DOI prefix is skipped (it is resolved as an arXiv id).
 * @param text - final artifact contents.
 * @returns `{ kind, id }[]`, de-duplicated and in first-seen order.
 */
export function extractIds(text) {
  const ids = new Map()
  for (const found of text.matchAll(/(?:arxiv\.org\/(?:abs|pdf|html)\/|alphaxiv\.org\/(?:abs|overview)\/|arxiv:\s*|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})/gi)) {
    ids.set(`arxiv:${found[1]}`, { kind: 'arxiv', id: found[1] })
  }
  for (const found of text.matchAll(/\b10\.\d{4,9}\/[^\s"'<>()[\]{}|,;`]+/g)) {
    const doi = found[0].replace(/[.*_:]+$/, '')
    if (/^10\.48550\//i.test(doi)) continue
    ids.set(`doi:${doi.toLowerCase()}`, { kind: 'doi', id: doi })
  }
  return [...ids.values()]
}

/**
 * Count distinct arXiv IDs and DOIs mentioned in the artifact.
 * @param text - final artifact contents.
 * @returns `{ arxiv, doi, distinct }` where each set is a sorted array.
 */
export function countIdentifiers(text) {
  const ids = extractIds(text)
  const arxiv = [...new Set(ids.filter(entry => entry.kind === 'arxiv').map(entry => entry.id))].sort()
  const doi = [...new Set(ids.filter(entry => entry.kind === 'doi').map(entry => entry.id))].sort()
  return { arxiv, doi, distinct: arxiv.length + doi.length }
}

/**
 * Count TODO markers: an explicit "not verified" is allowed, an invented result is not.
 * @param text - final artifact contents.
 * @returns the number of `TODO` occurrences.
 */
export function countTodos(text) {
  return (text.match(/\bTODO\b/g) ?? []).length
}

/**
 * Whether the artifact records a blocked verification instead of claiming success.
 * @param text - final artifact contents.
 * @returns true when `Verification: BLOCKED` appears.
 */
export function isBlocked(text) {
  return /Verification:\s*BLOCKED/i.test(text)
}

/**
 * Score one workdir.
 * @param options - `{ workdir, slug, workflow }`.
 * @returns a flat row suitable for JSONL.
 */
export function scoreWorkdir({ workdir, slug, workflow }) {
  const final = findFinal(workdir, slug, workflow)
  const provenance = final === undefined ? findProvenance(workdir, undefined, slug) : findProvenance(workdir, final, slug)
  const finalText = final === undefined ? '' : readFileSync(join(workdir, final), 'utf8')
  const provenanceText = provenance === undefined ? '' : readFileSync(join(workdir, provenance), 'utf8')
  const sources = extractSources(finalText)
  const ids = countIdentifiers(finalText)
  const drafts = (() => {
    try {
      return readdirSync(join(workdir, 'outputs/.drafts')).filter(name => name.startsWith(`${slug}-`)).length
    } catch {
      return 0
    }
  })()
  return {
    slug,
    final: final ?? null,
    provenance: provenance ?? null,
    done: final !== undefined && provenance !== undefined ? 1 : 0,
    plan: isFile(join(workdir, `outputs/.plans/${slug}.md`)) ? 1 : 0,
    drafts,
    provenance_fields: countProvenanceFields(provenanceText),
    sources: sources.count,
    sources_section: sources.section ? 1 : 0,
    cites: ids.distinct,
    arxiv: ids.arxiv,
    doi: ids.doi,
    todos: countTodos(finalText),
    blocked: isBlocked(finalText) ? 1 : 0,
    words: finalText.split(/\s+/).filter(Boolean).length,
  }
}
