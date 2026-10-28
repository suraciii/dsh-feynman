import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'

/** Upstream defaults: 5 results per query, 1–20 accepted. */
export const DEFAULT_RESULTS = 5
export const MAX_RESULTS = 20
export const MAX_QUERIES = 4
const MAX_FETCH_PAGES = 5
const FETCH_TIMEOUT_MS = 10_000
const EXCERPT_CHARS = 1200

const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 365 }

/** Strip a URL down to a comparable hostname; invalid URLs yield ''. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** True when `host` is `pattern` or a subdomain of it; a leading `*.` is accepted. */
export function matchesDomain(host, pattern) {
  const normalized = String(pattern).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
  if (!normalized || !host) return false
  return host === normalized || host.endsWith(`.${normalized}`)
}

/** Apply include/exclude domain rules; a non-empty include list requires a match. */
export function domainAllowed(url, filters = []) {
  const host = hostOf(url)
  const include = filters.filter((entry) => !String(entry).trim().startsWith('-'))
  const exclude = filters.filter((entry) => String(entry).trim().startsWith('-')).map((entry) => String(entry).trim().slice(1))
  if (exclude.some((pattern) => matchesDomain(host, pattern))) return false
  if (include.length && !include.some((pattern) => matchesDomain(host, pattern))) return false
  return true
}

/** Keep undated sources: the seam cannot prove them stale, so they are marked, not dropped. */
export function withinRecency(source, filter, now = Date.now()) {
  if (!filter || !RECENCY_DAYS[filter]) return true
  if (!source.publishedAt) return true
  const published = Date.parse(source.publishedAt)
  if (Number.isNaN(published)) return true
  return published >= now - RECENCY_DAYS[filter] * 86_400_000
}

/** Apply every filter and dedupe by URL, preserving first-seen order. */
export function filterSources(sources, { recencyFilter, domainFilter = [], numResults = DEFAULT_RESULTS, now = Date.now() } = {}) {
  const seen = new Set()
  const kept = []
  for (const source of sources) {
    if (!source?.url || seen.has(source.url)) continue
    if (!withinRecency(source, recencyFilter, now)) continue
    if (!domainAllowed(source.url, domainFilter)) continue
    seen.add(source.url)
    kept.push(source)
    if (kept.length >= numResults) break
  }
  return kept
}

function cleanText(text) {
  return String(text ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function renderSource(source, index, includeContent) {
  const lines = [`${index}. ${source.title || hostOf(source.url) || source.url} — ${source.url}`]
  if (source.publishedAt) lines.push(`   Published: ${source.publishedAt}`)
  if (source.snippet) lines.push(`   Snippet: ${source.snippet}`)
  if (includeContent) {
    if (source.contentId) lines.push(`   Content: id=${source.contentId}; page it with feynman_search_content id="${source.contentId}"`)
    if (source.excerpt) lines.push(`   Excerpt: ${source.excerpt}`)
    else if (source.summary) lines.push(`   Summary: ${source.summary}`)
  } else if (source.summary) {
    lines.push(`   Summary: ${source.summary}`)
  }
  return lines.join('\n')
}

export function createWebSearchTool({ getWeb, store } = {}) {
  return defineTool({
    name: 'feynman_web_search',
    description: 'Search the web with upstream Feynman controls: multiple queries, 1–20 results per query, recency window (day/week/month/year), domain include/exclude filters, and optional page content. Uses the DSH web seam; filters that the provider cannot apply are enforced on the returned sources.',
    parameters: {
      query: { type: 'string', description: 'Single search query. Use queries for multiple angles.' },
      queries: { type: 'array', items: { type: 'string' }, description: `Multiple queries searched separately (max ${MAX_QUERIES}).` },
      numResults: { type: 'integer', description: `Results per query (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}).` },
      recencyFilter: { type: 'string', enum: Object.keys(RECENCY_DAYS), description: 'Keep sources published within this window (undated sources are kept and marked).' },
      domainFilter: { type: 'array', items: { type: 'string' }, description: 'Limit to domains; prefix with - to exclude. Example: ["nature.com", "-example.com"].' },
      includeContent: { type: 'boolean', description: 'Fetch and store page text for up to five results; page it with feynman_search_content.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.summary }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const web = getWeb?.()
      if (!web?.search) throw new Error('The DSH web service is not mounted; feynman_web_search cannot search')
      const queries = [...new Set([
        ...(Array.isArray(args.queries) ? args.queries : []),
        ...(args.query ? [args.query] : []),
      ].map((query) => String(query).trim()).filter(Boolean))].slice(0, MAX_QUERIES)
      if (!queries.length) throw new Error('feynman_web_search needs a query or queries')
      const numResults = Math.min(Math.max(1, Number(args.numResults) || DEFAULT_RESULTS), MAX_RESULTS)
      const recencyFilter = Object.hasOwn(RECENCY_DAYS, args.recencyFilter ?? '') ? args.recencyFilter : undefined
      const domainFilter = (Array.isArray(args.domainFilter) ? args.domainFilter : []).map(String).filter(Boolean)
      const includeContent = args.includeContent === true
      const overFetch = recencyFilter || domainFilter.length ? Math.min(MAX_RESULTS, Math.max(numResults * 3, numResults)) : numResults
      const notes = []
      const sources = []

      for (const query of queries) {
        let result
        try {
          result = await web.search({ query, maxResults: overFetch }, exec.signal)
        } catch (error) {
          if (exec.signal.aborted) throw error
          notes.push(`Search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        const kept = filterSources(result.sources ?? [], { recencyFilter, domainFilter, numResults })
        if (result.truncated) notes.push(`Provider truncated results for "${query}" before post-filtering.`)
        if (kept.length < numResults) notes.push(`"${query}" returned ${kept.length}/${numResults} after filtering.`)
        for (const source of kept) {
          if (!sources.some((entry) => entry.url === source.url)) sources.push({ ...source, query })
        }
      }

      if (includeContent && sources.length) {
        for (const source of sources.slice(0, MAX_FETCH_PAGES)) {
          try {
            const fetched = await web.fetch({ url: source.url }, AbortSignal.any([exec.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]))
            const text = cleanText(fetched.body?.content ?? '')
            if (!text) { notes.push(`No readable text for ${source.url}`); continue }
            source.excerpt = text.slice(0, EXCERPT_CHARS)
            if (store?.put) {
              const id = randomUUID()
              store.put({ id, text, url: source.url, title: source.title, fetchedAt: new Date().toISOString() })
              source.contentId = id
            }
          } catch (error) {
            if (exec.signal.aborted) throw error
            notes.push(`Content fetch failed for ${source.url}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }

      const header = `Web search: ${queries.map((query) => `"${query}"`).join(', ')}; ${sources.length} source(s), ${numResults} per query` +
        `${recencyFilter ? `, recency=${recencyFilter}` : ''}${domainFilter.length ? `, domains=${domainFilter.join(', ')}` : ''}.`
      const summary = [
        header,
        ...sources.map((source, index) => renderSource(source, index + 1, includeContent)),
        notes.length ? `Notes:\n${notes.map((note) => `- ${note}`).join('\n')}` : '',
        'Cite the URL, not the snippet. Use feynman_fetch_content for full text when no content id is shown.',
      ].filter(Boolean).join('\n\n')

      return {
        queries,
        filters: { numResults, recencyFilter: recencyFilter ?? null, domainFilter, includeContent },
        sources,
        notes,
        summary,
      }
    },
  })
}
