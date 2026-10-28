import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWebSearchTool, domainAllowed, filterSources, matchesDomain, withinRecency } from '../lib/web-search.js'

const signal = new AbortController().signal
const exec = { signal }

function toolWith(web, store) {
  return createWebSearchTool({ getWeb: () => web, store })
}

function fakeWeb(results, fetchImpl) {
  const calls = []
  return {
    calls,
    async search(request) {
      calls.push(request)
      const value = typeof results === 'function' ? results(request) : results
      if (value instanceof Error) throw value
      return { sources: value, truncated: false }
    },
    async fetch(request) {
      return fetchImpl ? fetchImpl(request) : { url: request.url, statusCode: 200, body: { kind: 'text', content: '<p>Fetched body</p>' }, truncated: false }
    },
  }
}

test('domain filters include subdomains and honour exclusions', () => {
  assert.equal(matchesDomain('nature.com', 'nature.com'), true)
  assert.equal(matchesDomain('www.nature.com', 'nature.com'), true)
  assert.equal(matchesDomain('sub.nature.com', 'nature.com'), true)
  assert.equal(matchesDomain('example.com', 'nature.com'), false)
  assert.equal(domainAllowed('https://sub.nature.com/x', ['nature.com']), true)
  assert.equal(domainAllowed('https://example.com/x', ['nature.com']), false)
  assert.equal(domainAllowed('https://sub.example.com/x', ['-example.com']), false)
  assert.equal(domainAllowed('https://example.com/x', ['-example.com']), false)
  assert.equal(domainAllowed('https://other.org/x', ['-example.com']), true)
})

test('recency keeps recent and undated sources, drops known-old ones', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  assert.equal(withinRecency({ publishedAt: '2026-10-27T00:00:00Z' }, 'week', now), true)
  assert.equal(withinRecency({ publishedAt: '2020-01-01T00:00:00Z' }, 'week', now), false)
  assert.equal(withinRecency({}, 'week', now), true)
  assert.equal(withinRecency({ publishedAt: 'not-a-date' }, 'week', now), true)
})

test('filterSources dedupes, filters, and truncates', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  const sources = [
    { url: 'https://nature.com/a' },
    { url: 'https://nature.com/a' },
    { url: 'https://example.com/b' },
    { url: 'https://nature.com/c' },
  ]
  assert.deepEqual(filterSources(sources, { numResults: 2, domainFilter: ['nature.com'], now }), [
    { url: 'https://nature.com/a' },
    { url: 'https://nature.com/c' },
  ])
})

test('feynman_web_search exposes upstream controls and post-filters sources', async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
  const fresh = new Date(Date.now() - 86_400_000).toISOString()
  const web = fakeWeb([
    { url: 'https://www.nature.com/articles/fresh', title: 'Fresh', publishedAt: fresh, snippet: 'new' },
    { url: 'https://example.com/old', title: 'Old', publishedAt: old, snippet: 'old' },
    { url: 'https://sub.nature.com/undated', title: 'Undated' },
  ])
  const result = await toolWith(web).execute({ query: 'topic', numResults: 2, recencyFilter: 'week', domainFilter: ['nature.com'] }, exec)
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].url, 'https://www.nature.com/articles/fresh')
  assert.equal(result.sources[1].url, 'https://sub.nature.com/undated')
  assert.equal(web.calls.length, 1)
  assert.equal(web.calls[0].maxResults, 6)
  assert.match(result.summary, /recency=week/)
  assert.match(result.summary, /nature\.com/)
})

test('feynman_web_search searches multiple queries and dedupes across them', async () => {
  const web = fakeWeb((request) => request.query === 'one'
    ? [{ url: 'https://a.example/x', title: 'A' }, { url: 'https://shared.example/s', title: 'S' }]
    : [{ url: 'https://shared.example/s', title: 'S' }, { url: 'https://b.example/y', title: 'B' }])
  const result = await toolWith(web).execute({ queries: ['one', 'two'], numResults: 2 }, exec)
  assert.deepEqual(result.queries, ['one', 'two'])
  assert.deepEqual(result.sources.map((source) => source.url), ['https://a.example/x', 'https://shared.example/s', 'https://b.example/y'])
  assert.equal(web.calls.length, 2)
})

test('includeContent fetches and stores page text for paging', async () => {
  const store = { entries: [], put(entry) { this.entries.push(entry) } }
  const web = fakeWeb([{ url: 'https://example.com/page', title: 'Page' }])
  const result = await toolWith(web, store).execute({ query: 'page', includeContent: true }, exec)
  assert.equal(result.sources[0].contentId, store.entries[0].id)
  assert.match(result.sources[0].excerpt, /Fetched body/)
  assert.equal(store.entries[0].text, 'Fetched body')
  assert.match(result.summary, /feynman_search_content/)
})

test('one failed query does not discard the others', async () => {
  const web = fakeWeb((request) => request.query === 'bad' ? new Error('rate limited') : [{ url: 'https://ok.example/x' }])
  const result = await toolWith(web).execute({ queries: ['bad', 'good'] }, exec)
  assert.equal(result.sources.length, 1)
  assert.ok(result.notes.some((note) => note.includes('rate limited')))
})

test('feynman_web_search requires the web seam and a query', async () => {
  await assert.rejects(() => createWebSearchTool({ getWeb: () => undefined }).execute({ query: 'x' }, exec), /web service is not mounted/)
  const web = fakeWeb([])
  await assert.rejects(() => toolWith(web).execute({}, exec), /needs a query/)
})
