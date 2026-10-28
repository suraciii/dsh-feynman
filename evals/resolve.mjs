/**
 * Citation resolution and key-paper recall for research-quality evals.
 *
 * Network lookups stay out of `score.mjs` so the artifact-contract checks stay
 * offline and deterministic. Here we resolve the identifiers a finished
 * artifact cites, check that the resolved title (or first author) actually
 * appears next to the identifier, and measure how many expected key papers the
 * artifact found.
 *
 * Lookup failures are `undefined` and excluded from the validity denominator:
 * an arXiv or Crossref outage must not be scored as a bad citation.
 *
 * @module dsh-feynman/evals/resolve
 */
import { extractIds } from './score.mjs'

const UA = { 'user-agent': 'dsh-feynman-evals/0.1 (research-eval citation checker)' }
const STOP = new Set('a an and are as at be by can for from in into is of on or the to via with without'.split(' '))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Normalize text to content tokens: lowercase, strip XML tags and punctuation,
 * drop one-letter words and common stop words.
 * @param text - raw text.
 * @returns the token list.
 */
export function tokens(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(token => token.length > 1 && !STOP.has(token))
}

/**
 * Normalize text to a space-joined token string.
 * @param text - raw text.
 * @returns the normalized string.
 */
export function norm(text) {
  return tokens(text).join(' ')
}

/**
 * Parse an arXiv Atom feed into `id -> { title, author }`.
 * @param xml - `export.arxiv.org/api/query` response body.
 * @returns a Map of bare arXiv ids to metadata.
 */
export function parseArxivAtom(xml) {
  const titles = new Map()
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(v\d+)?<\/id>/)?.[1]
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1].replace(/\s+/g, ' ').trim()
    const author = entry.match(/<author>\s*<name>([^<]+)<\/name>/)?.[1].trim().split(/\s+/).pop()
    if (id && title && title !== 'Error') titles.set(id, { title, author })
  }
  return titles
}

/**
 * Resolve arXiv ids in batches of 50. The API asks for one request per ~3s.
 * @param idList - bare arXiv ids.
 * @param options - `{ fetchImpl, gateMs, attempts }`.
 * @returns `id -> { title, author } | undefined`; a missing key means the id
 * did not resolve, `undefined` means the lookup itself failed.
 */
export async function resolveArxiv(idList, { fetchImpl = fetch, gateMs = 3100, attempts = 3, retryMs = 5_000 } = {}) {
  const titles = new Map()
  for (let index = 0; index < idList.length; index += 50) {
    if (index > 0 && gateMs > 0) await sleep(gateMs)
    const batch = idList.slice(index, index + 50)
    const url = `https://export.arxiv.org/api/query?id_list=${batch.join(',')}&max_results=${batch.length}`
    let xml = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(20_000) }).catch(() => null)
      if (response?.ok) { xml = await response.text(); break }
      if (retryMs > 0) await sleep(retryMs)
    }
    if (xml === null) {
      for (const id of batch) titles.set(id, undefined)
      continue
    }
    for (const [id, metadata] of parseArxivAtom(xml)) titles.set(id, metadata)
  }
  return titles
}

/**
 * Resolve a DOI through Crossref, falling back to the DOI handle system for
 * DataCite/mEDRA registrations Crossref does not know.
 * @param doi - the DOI.
 * @param options - `{ fetchImpl }`.
 * @returns `{ resolves: boolean | undefined, title?, author? }`.
 */
export async function resolveDoi(doi, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: UA, signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (response?.ok) {
    const message = (await response.json()).message
    return { resolves: true, title: message?.title?.[0]?.replace(/\s+/g, ' ').trim(), author: message?.author?.[0]?.family }
  }
  const handle = await fetchImpl(`https://doi.org/api/handles/${encodeURIComponent(doi)}`, { headers: UA, signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (handle === null) return { resolves: undefined }
  const body = await handle.json().catch(() => ({}))
  return { resolves: body.responseCode === 1, title: undefined }
}

/**
 * The cited title is whatever text surrounds the identifier: each markdown
 * line that mentions it, plus the previous line when the identifier sits on a
 * short line (a bare footnote or link).
 * @param text - final artifact contents.
 * @param id - identifier text as it appears in the artifact.
 * @returns the context strings.
 */
export function citedContexts(text, id) {
  const lines = text.split('\n')
  const needle = id.toLowerCase()
  return lines.flatMap((line, index) => {
    if (!line.toLowerCase().includes(needle)) return []
    return [line.length < 80 && index > 0 ? `${lines[index - 1]} ${line}` : line]
  })
}

/**
 * Share of the resolved title's content tokens present in the citation context.
 * @param title - resolved title.
 * @param context - text around the identifier.
 * @returns overlap in `[0, 1]`, or null when the title has no content tokens.
 */
export function titleOverlap(title, context) {
  const want = new Set(tokens(title))
  if (want.size === 0) return null
  const have = new Set(tokens(context))
  return [...want].filter(token => have.has(token)).length / want.size
}

/**
 * Resolve every identifier in the artifact and score validity/title match.
 * @param text - final artifact contents.
 * @param options - `{ fetchImpl, arxivGateMs, crossrefGateMs }`.
 * @returns `{ citations, checked, valid, title, unresolved, title_mismatch, rows }`.
 */
export async function scoreCitations(text, { fetchImpl = fetch, arxivGateMs = 3100, crossrefGateMs = 1100, arxivAttempts = 3, retryMs = 5_000 } = {}) {
  const ids = extractIds(text)
  const arxiv = await resolveArxiv(ids.filter(entry => entry.kind === 'arxiv').map(entry => entry.id), { fetchImpl, gateMs: arxivGateMs, attempts: arxivAttempts, retryMs })
  const rows = []
  let doiCalls = 0
  for (const entry of ids) {
    let resolves
    let title
    let author
    if (entry.kind === 'arxiv') {
      resolves = arxiv.has(entry.id) ? (arxiv.get(entry.id) === undefined ? undefined : true) : false
      ;({ title, author } = arxiv.get(entry.id) ?? {})
    } else {
      if (doiCalls > 0 && crossrefGateMs > 0) await sleep(crossrefGateMs)
      doiCalls += 1
      ;({ resolves, title, author } = await resolveDoi(entry.id, { fetchImpl }))
    }
    const contexts = citedContexts(text, entry.id)
    const overlap = title ? Math.max(0, ...contexts.map(context => titleOverlap(title, context))) : null
    // Author-year citations ("Komor et al. 2016, DOI ...") carry no title;
    // accept the resolved first author's surname instead.
    const authorSeen = Boolean(author) && tokens(author).every(token => contexts.some(context => tokens(context).includes(token)))
    rows.push({ ...entry, resolves, title, overlap, matched: overlap !== null && (overlap >= 0.6 || authorSeen) })
  }
  const checked = rows.filter(row => row.resolves !== undefined)
  const titled = rows.filter(row => row.resolves && row.overlap !== null)
  return {
    citations: rows.length,
    checked: checked.length,
    valid: checked.length === 0 ? null : checked.filter(row => row.resolves).length / checked.length,
    title: titled.length === 0 ? null : titled.filter(row => row.matched).length / titled.length,
    unresolved: rows.filter(row => row.resolves === false).map(row => `${row.kind}:${row.id}`),
    title_mismatch: titled.filter(row => !row.matched).map(row => ({ id: `${row.kind}:${row.id}`, resolved_title: row.title, overlap: Number(row.overlap.toFixed(2)) })),
    rows,
  }
}

/**
 * Share of the question's expected key papers that appear in the artifact,
 * matched by any listed identifier or by the exact normalized title.
 * @param question - `{ key_papers: [{ title, ids, ref }] }`.
 * @param text - final artifact contents.
 * @returns `{ recall, key_missing }` with recall null when the question has no keys.
 */
export function recallFor(question, text) {
  const keys = question.key_papers ?? []
  const lower = text.toLowerCase()
  const normalized = norm(text)
  const hits = keys.filter(key =>
    key.ids.some(id => lower.includes(id.toLowerCase())) || normalized.includes(norm(key.title)),
  )
  return {
    recall: keys.length === 0 ? null : hits.length / keys.length,
    key_missing: keys.filter(key => !hits.includes(key)).map(key => key.ref),
  }
}
