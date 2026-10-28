/**
 * `feynman_source_check`: gather cited passages for one claim.
 *
 * Upstream Feynman ships `source_check` in `pi-web-access`: it searches, fetches
 * a few pages, and returns a bounded machine-readable artifact with exact
 * passage citations, leaving the support judgement to the reader. This port
 * keeps that contract on top of the host `web_search` and
 * `feynman_fetch_content` tools: no verdict field, no automatic downgrade of
 * the claim, and every passage keeps its source URL.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MAX_QUERIES = 8
const MAX_SOURCES = 20
const DEFAULT_SOURCES = 10
const MAX_FETCH_PAGES = 5
const PASSAGES_PER_SOURCE = 3
const PASSAGE_CHARS = 400
const INLINE_CHARS = 4000
const MIN_SENTENCE_CHARS = 24
const CJK_RUN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'there', 'their',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could',
  'may', 'might', 'must', 'should', 'would', 'will', 'shall', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'as', 'into', 'about', 'over', 'under', 'between', 'it', 'its', 'they', 'them', 'we', 'our',
  'you', 'your', 'he', 'she', 'his', 'her', 'not', 'no', 'nor', 'so', 'such', 'only', 'also', 'more', 'most',
  'some', 'any', 'all', 'each', 'every', 'both', 'either', 'neither', 'which', 'who', 'whom', 'whose', 'when',
  'where', 'why', 'how', 'what', 'while', 'because', 'during', 'before', 'after', 'above', 'below', 'up', 'down',
])

/** Content words of a claim: unique, lower-cased, numbers kept, stopwords dropped. */
export function claimTokens(claim) {
  const text = String(claim)
  const seen = new Set()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue
    if (STOPWORDS.has(raw)) continue
    seen.add(raw)
  }
  // CJK has no spaces: use character bigrams so Chinese/Japanese/Korean claims
  // still match sentences. Single-character runs stay as-is.
  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length === 1) seen.add(run)
    else for (let index = 0; index < run.length - 1; index += 1) seen.add(run.slice(index, index + 2))
  }
  return [...seen]
}

/** Sentence-ish spans; headings and list items stay separate so citations read cleanly. */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n{2,}|\n(?=[A-Z0-9#>*|-])/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function truncate(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  return `${boundary > limit * 0.6 ? cut.slice(0, boundary) : cut}…`
}

/**
 * Pick the passages that share the most content words with the claim.
 *
 * Score is claim coverage (share of unique claim tokens present; ASCII tokens
 * are word-bounded, CJK bigrams are substring matches);
 * density breaks ties so a short sentence that carries the claim beats a long
 * one that merely mentions it. Ordering is deterministic for equal scores.
 */
export function rankPassages(text, claim, { limit = PASSAGES_PER_SOURCE, minChars = MIN_SENTENCE_CHARS } = {}) {
  const tokens = claimTokens(claim)
  if (!tokens.length) return []
  const patterns = tokens.map((token) => /^[a-z0-9]+$/.test(token)
    ? new RegExp(`\\b${escape(token)}\\b`, 'i')
    : token)
  const passages = []
  for (const [index, sentence] of splitSentences(text).entries()) {
    if (sentence.length < minChars) continue
    const words = sentence.split(/\s+/)
    let matched = 0
    for (const pattern of patterns) if (typeof pattern === 'string' ? sentence.includes(pattern) : pattern.test(sentence)) matched += 1
    if (!matched) continue
    passages.push({
      index,
      score: Number((matched / tokens.length).toFixed(3)),
      density: Number((matched / Math.max(4, words.length)).toFixed(4)),
      text: truncate(sentence, PASSAGE_CHARS),
    })
  }
  passages.sort((a, b) => b.score - a.score || b.density - a.density || a.index - b.index)
  return passages.slice(0, limit).map(({ density, ...rest }) => rest)
}

/** `domainFilter` semantics: a leading `-` excludes, a bare suffix includes. */
export function filterSources(sources, domainFilter = []) {
  const include = []
  const exclude = []
  for (const raw of domainFilter) {
    const value = String(raw).trim().toLowerCase()
    if (!value) continue
    if (value.startsWith('-')) exclude.push(value.slice(1))
    else include.push(value)
  }
  return sources.filter((source) => {
    let host
    try { host = new URL(source.url).hostname.toLowerCase() } catch { return false }
    if (exclude.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false
    if (include.length && !include.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false
    return true
  })
}

/** Host `web_search` returns `{sources:[…]}`; fall back to URLs in its text. */
export function parseSearchSources(value, text = '') {
  const sources = []
  const push = (entry) => {
    if (!entry) return
    const url = typeof entry === 'string' ? entry : entry.url
    if (!url || !/^https?:\/\//i.test(url)) return
    sources.push({
      url,
      title: typeof entry === 'string' ? '' : (entry.title ?? ''),
      snippet: typeof entry === 'string' ? '' : (entry.snippet ?? entry.summary ?? ''),
    })
  }
  if (Array.isArray(value?.sources)) for (const entry of value.sources) push(entry)
  if (!sources.length) {
    for (const match of String(text).matchAll(/https?:\/\/[^\s)>\]]+/g)) push(match[0].replace(/[.,;:]+$/, ''))
  }
  const seen = new Set()
  return sources.filter((source) => {
    const key = source.url.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const slugFor = (claim) => {
  const words = String(claim).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 8).join('-')
  // Non-Latin claims have no readable slug; the hash keeps files distinct and
  // stable for the same claim.
  const hash = createHash('sha256').update(claim).digest('hex').slice(0, 6)
  return `${(words || 'claim').slice(0, 48)}-${hash}`
}

function renderArtifact({ claim, queries, searchedAt, sources, notes }) {
  const lines = [
    `# Source check: ${claim}`,
    '',
    `- Date: ${searchedAt}`,
    `- Claim: ${claim}`,
    `- Queries: ${queries.map((query) => `"${query}"`).join(', ')}`,
    `- Sources: ${sources.length} (fetched: ${sources.filter((source) => source.fetch).length})`,
    '- Status: **unclassified** — this artifact gathers passages. It does not decide whether the claim is supported.',
    '',
  ]
  sources.forEach((source, index) => {
    const heading = String(source.title || source.url).replace(/\s+/g, ' ').trim()
    lines.push(`## ${index + 1}. ${heading}`)
    lines.push('', `- URL: ${source.url}`)
    lines.push(source.fetch
      ? `- Fetched: HTTP ${source.fetch.statusCode ?? '?'} · ${source.fetch.chars ?? 0} chars${source.fetch.savedPath ? ` · saved \`${source.fetch.savedPath}\`` : ''}`
      : '- Fetched: no (search snippet only)')
    if (source.passages.length) {
      for (const passage of source.passages) lines.push('', `> ${passage.text}`, `> — score ${passage.score}`)
    } else {
      lines.push('', '- No passage shared a content word with the claim.')
    }
    lines.push('')
  })
  if (notes.length) {
    lines.push('## Notes', '')
    for (const note of notes) lines.push(`- ${note}`)
    lines.push('')
  }
  lines.push('## Review', '', '- Read each passage against the claim; cite the URL and passage, or state that the claim is unsupported.', '')
  return lines.join('\n')
}

function inlineSummary({ claim, artifact, sources }) {
  // Keep room for the closing notes so the joined text stays under the cap.
  const limit = INLINE_CHARS - 90
  const lines = [`Source check for: ${claim}`, `Artifact: ${artifact}`]
  let used = lines.join('\n').length
  let truncated = false
  outer: for (const [index, source] of sources.entries()) {
    const header = `[${index + 1}] ${String(source.title || source.url).replace(/\s+/g, ' ').trim()} — ${source.url}`
    if (used + header.length + 1 > limit) { truncated = true; break }
    lines.push(header)
    used += header.length + 1
    for (const passage of source.passages) {
      const line = `  · ${passage.text} (score ${passage.score})`
      if (used + line.length + 1 > limit) { truncated = true; break outer }
      lines.push(line)
      used += line.length + 1
    }
  }
  if (truncated) lines.push('… truncated; read the artifact for the rest.')
  lines.push('Passages only: judge support yourself and cite the URL with the quoted text.')
  return lines.join('\n')
}

export function createSourceCheckTool(runtime, { store } = {}) {
  return defineTool({
    name: 'feynman_source_check',
    description: 'Gather cited web passages for one claim into a reviewable artifact (outputs/<slug>-source-check.md plus .json). Searches with the host web_search tool, optionally fetches up to five pages with feynman_fetch_content, and ranks sentences by shared content words. It reports passages, not a verdict: decide support yourself and cite the URL with the quoted text.',
    parameters: {
      claim: { type: 'string', required: true, description: 'The assertion to gather evidence for.' },
      queries: { type: 'array', items: { type: 'string' }, description: `Search queries (default: the claim; max ${MAX_QUERIES}).` },
      numResults: { type: 'integer', description: `Sources to keep (default ${DEFAULT_SOURCES}, max ${MAX_SOURCES}).` },
      fetchContent: { type: 'boolean', description: `Fetch up to ${MAX_FETCH_PAGES} pages for exact passages (default true).` },
      domainFilter: { type: 'array', items: { type: 'string' }, description: 'Host suffixes to keep; prefix one with - to exclude it.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.summary }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const claim = String(args.claim ?? '').trim()
      if (!claim) throw new Error('feynman_source_check needs a claim')
      const queries = [...new Set([...(args.queries ?? []).map((query) => String(query).trim()).filter(Boolean), claim])].slice(0, MAX_QUERIES)
      const numResults = Math.min(Math.max(1, args.numResults ?? DEFAULT_SOURCES), MAX_SOURCES)
      const fetchContent = args.fetchContent !== false

      const searchSchema = runtime.schemas?.().find((tool) => tool.name === 'web_search')
      if (!searchSchema) throw new Error('The host web_search tool is not mounted; source_check cannot search')
      const properties = searchSchema.parameters?.properties ?? {}
      const searchArgs = Object.hasOwn(properties, 'queries') ? { queries } : Object.hasOwn(properties, 'query') ? { query: queries[0] } : undefined
      if (!searchArgs) throw new Error('The mounted web_search schema has no supported query field')

      const searched = await runtime.execute({ callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal, name: 'web_search', arguments: searchArgs })
      if (searched.isError) {
        throw new Error(`web_search failed: ${searched.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')}`)
      }
      for (const context of searched.additionalContexts ?? []) exec.deferContext?.(context)
      const searchText = searched.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      const found = filterSources(parseSearchSources(searched.value, searchText), args.domainFilter ?? []).slice(0, numResults)
      const notes = []
      if (!found.length) notes.push('The search returned no usable http(s) sources for this claim.')

      const fetched = new Map()
      if (fetchContent && found.length) {
        const targets = found.map((source) => source.url).slice(0, MAX_FETCH_PAGES)
        const result = await runtime.execute({
          callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal,
          name: 'feynman_fetch_content', arguments: { urls: targets },
        })
        if (result.isError) {
          notes.push(`feynman_fetch_content failed: ${result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')}`)
        } else {
          for (const item of result.value?.items ?? []) {
            if (item.error) { notes.push(`Fetch failed for ${item.url}: ${item.error}`); continue }
            const full = store?.get?.(item.id)?.text ?? item.text ?? ''
            fetched.set(item.url, { text: full, id: item.id, statusCode: item.statusCode, chars: full.length, savedPath: item.savedPath })
          }
        }
      }

      const sources = found.map((source) => {
        const page = fetched.get(source.url)
        const passages = page?.text
          ? rankPassages(page.text, claim)
          : source.snippet
            ? rankPassages(source.snippet, claim, { limit: 1, minChars: 12 })
            : []
        return { ...source, fetch: page ? { id: page.id, statusCode: page.statusCode, chars: page.chars, savedPath: page.savedPath } : null, passages }
      })
      if (sources.length && !sources.some((source) => source.passages.length)) notes.push('No sentence in the retrieved text shared a content word with the claim; treat it as unverified rather than refuted.')

      const searchedAt = new Date().toISOString().slice(0, 10)
      const slug = slugFor(claim)
      const root = exec.agent?.session?.header?.cwd
      const artifact = renderArtifact({ claim, queries, searchedAt, sources, notes })
      const structured = { claim, queries, searchedAt, status: 'unclassified', sources, notes }
      const paths = {}
      if (root) {
        const directory = join(resolve(root), 'outputs')
        await mkdir(directory, { recursive: true })
        const markdownPath = join(directory, `${slug}-source-check.md`)
        const jsonPath = join(directory, `${slug}-source-check.json`)
        await writeFile(markdownPath, artifact)
        await writeFile(jsonPath, `${JSON.stringify(structured, null, 2)}\n`)
        paths.artifact = markdownPath
        paths.json = jsonPath
      }
      const id = `source-check-${createHash('sha256').update(claim).digest('hex').slice(0, 12)}`
      if (store && paths.artifact) {
        store.put({ id, url: `source-check:${slug}`, text: artifact, savedPath: paths.artifact, kind: 'source-check', createdAt: Date.now() })
      }
      return {
        claim,
        id,
        status: 'unclassified',
        ...paths,
        sourceCount: sources.length,
        fetchedCount: sources.filter((source) => source.fetch).length,
        sources,
        notes,
        summary: inlineSummary({ claim, artifact: paths.artifact ?? '(no workspace; artifact not saved)', sources }),
      }
    },
  })
}
