/**
 * Live end-to-end check for `feynman_source_check`.
 *
 * Search is stubbed with two real public URLs (the host `web_search` provider is
 * only available inside a mounted DSH session); fetching, passage ranking,
 * artifact writing, and store registration run for real over the network.
 *
 * Run: node experiments/source-check-e2e.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createFetchContentTool } from '../lib/fetch-content.js'
import { createSourceCheckTool } from '../lib/source-check.js'
import { createContentStore } from '../lib/content-store.js'

const root = await mkdtemp(join(process.cwd(), 'outputs', '.work', 'source-check-'))
const store = createContentStore()

const fetchTool = createFetchContentTool({ schemas: () => [], execute: async () => { throw new Error('no host tools') } }, { store })

const sources = [
  { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need', snippet: 'The Transformer uses self-attention.' },
  { url: 'https://github.com/Companion-Inc/feynman', title: 'Companion-Inc/feynman', snippet: 'A research agent.' },
]

const runtime = {
  schemas: () => [{ name: 'web_search', parameters: { properties: { queries: { type: 'array' } } } }],
  execute: async (request) => {
    if (request.name === 'web_search') {
      return { isError: false, content: [{ type: 'text', text: 'stub search' }], additionalContexts: [], value: { sources } }
    }
    if (request.name === 'feynman_fetch_content') {
      const value = await fetchTool.execute(request.arguments, {
        callId: request.callId, rootCallId: request.rootCallId, token: request.token, signal: request.signal,
        agent: request.agent, deferContext: () => {},
      })
      return { isError: false, content: [{ type: 'text', text: 'fetched' }], additionalContexts: [], value }
    }
    throw new Error(`unexpected tool ${request.name}`)
  },
}

const tool = createSourceCheckTool(runtime, { store })
const exec = {
  callId: 'e2e', rootCallId: 'e2e', token: Symbol('e2e'), signal: AbortSignal.timeout(120000),
  agent: { session: { header: { cwd: root } } }, deferContext: () => {},
}

const report = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`)
try {
  const result = await tool.execute({ claim: 'The Transformer replaces recurrence with self-attention', fetchContent: true }, exec)
  report('status', result.status)
  report('sources', result.sourceCount)
  report('fetched', result.fetchedCount)
  report('artifact', result.artifact)
  report('passages', result.sources.map((source) => ({ url: source.url, statusCode: source.fetch?.statusCode, chars: source.fetch?.chars, passages: source.passages.length, top: source.passages[0]?.score })))
  report('notes', result.notes)
  const markdown = await readFile(result.artifact, 'utf8')
  console.log('--- artifact head ---')
  console.log(markdown.split('\n').slice(0, 18).join('\n'))
  console.log('--- checks ---')
  report('unclassified', /Status: \*\*unclassified\*\*/.test(markdown))
  report('hasPassage', /self-attention/i.test(markdown))
  report('storeMatches', store.get(result.id)?.text === markdown)
} finally {
  await rm(root, { recursive: true, force: true })
}
