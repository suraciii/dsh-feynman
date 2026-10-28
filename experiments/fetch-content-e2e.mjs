/**
 * End-to-end check for feynman_fetch_content against live sources.
 *
 * Run: node experiments/fetch-content-e2e.mjs
 *
 * Uses the real network and the vendored document parser (LiteParse) behind a
 * minimal runtime adapter, so the code path is the same one the plugin uses
 * when the host mounts `document_parse`. `web_fetch` is intentionally absent to
 * exercise the direct-fetch HTML fallback.
 */
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createFetchContentTool } from '../lib/fetch-content.js'
import { createContentStore } from '../lib/content-store.js'
import { createSearchContentTool } from '../lib/web-results.js'
import { createResearchTools } from '../lib/research-tools.js'
import { createNativeExecutor } from '../lib/upstream.js'

const executor = createNativeExecutor()
const refs = () => ({ hfTokenEnv: 'HF_TOKEN', alphaxivTokenEnv: 'ALPHAXIV_API_KEY' })
const documentTools = createResearchTools({ get: () => undefined }, refs, false, executor)
const documentParse = documentTools.find((tool) => tool.name === 'document_parse')

const runtime = {
  schemas: () => documentParse ? [{ name: 'document_parse', parameters: { properties: { path: {} } } }] : [],
  execute: async ({ name, arguments: args, signal, agent }) => {
    if (name !== 'document_parse') throw new Error(`unexpected host tool ${name}`)
    const value = await documentParse.execute(args, { callId: 'e2e', rootCallId: 'e2e', token: Symbol('e2e'), signal, agent, deferContext: () => {} })
    const text = (value.content ?? []).map((part) => part.text ?? '').join('\n')
    return { isError: false, content: value.content ?? [{ type: 'text', text }], value }
  },
}

const store = createContentStore()
const fetchTool = createFetchContentTool(runtime, { store })
const searchTool = createSearchContentTool({ store })

// Inside the repo so the saved artifacts survive the process (sandboxed /tmp
// writes are per-call and disappear before a later command can inspect them).
await mkdir('outputs/.work', { recursive: true })
const workspace = await mkdtemp('outputs/.work/e2e-fetch-')
const exec = (id) => ({
  callId: id, rootCallId: id, token: Symbol(id), signal: new AbortController().signal,
  agent: { session: { id, header: { cwd: workspace } } }, deferContext: () => {},
})

const report = []
const record = (name, value) => {
  report.push({ name, ...value })
  console.log(`\n## ${name}`)
  console.log(JSON.stringify(value, null, 2).slice(0, 1200))
}

try {
  const pdf = await fetchTool.execute({ urls: ['https://arxiv.org/pdf/1706.03762'] }, exec('pdf'))
  const pdfItem = pdf.items[0]
  record('arxiv-pdf', {
    ok: pdf.ok, failed: pdf.failed, kind: pdfItem.kind, statusCode: pdfItem.statusCode, error: pdfItem.error,
    chars: pdfItem.chars, savedPath: pdfItem.savedPath,
    savedBytes: pdfItem.savedPath ? (await stat(pdfItem.savedPath)).size : 0,
    head: pdfItem.text?.slice(0, 200),
    hasAttentionTitle: /attention/i.test(pdfItem.text ?? ''),
  })
  const repo = await fetchTool.execute({ urls: ['https://github.com/Companion-Inc/feynman'] }, exec('repo'))
  const repoItem = repo.items[0]
  record('github-readme', {
    ok: repo.ok, failed: repo.failed, kind: repoItem.kind, statusCode: repoItem.statusCode,
    chars: repoItem.chars, head: repoItem.text?.slice(0, 200), error: repoItem.error,
  })

  const issue = await fetchTool.execute({ urls: ['https://github.com/nodejs/node/pull/1', 'https://github.com/Companion-Inc/feynman/issues/999999'] }, exec('issue'))
  record('github-pull-and-404', issue.items.map((item) => ({ kind: item.kind, statusCode: item.statusCode, chars: item.chars, head: item.text?.slice(0, 120), error: item.error })))

  const html = await fetchTool.execute({ urls: ['https://arxiv.org/abs/1706.03762'] }, exec('html'))
  const htmlItem = html.items[0]
  record('html-direct-fallback', {
    ok: html.ok, kind: htmlItem.kind, statusCode: htmlItem.statusCode, chars: htmlItem.chars,
    hostFallback: htmlItem.hostFallback, head: htmlItem.text?.slice(0, 160), error: htmlItem.error,
  })

  if (pdfItem?.id) {
    const page = await searchTool.execute({ id: pdfItem.id, offset: 1000, limit: 300 }, exec('page'))
    const found = await searchTool.execute({ id: pdfItem.id, findText: 'self-attention', maxMatches: 3, contextChars: 80 }, exec('find'))
    record('search-content', {
      totalChars: page.totalChars, nextOffset: page.nextOffset, windowChars: page.text.length,
      matchCount: found.matchCount, firstMatchIndex: found.matches?.[0]?.index,
      firstContext: found.matches?.[0]?.context,
    })
    const savedText = await readFile(pdfItem.savedPath, 'utf8')
    record('saved-text-matches-store', { equal: savedText === store.get(pdfItem.id).text, bytes: savedText.length })
  }
} finally {
  await executor.dispose()
  // Keep the artifacts: they are the audit trail for this run.
  console.log(`\nworkspace: ${workspace}`)
}

console.log('\n## summary')
console.log(JSON.stringify(report.map(({ name, ok, failed, kind, chars, matchCount, error }) => ({ name, ok, failed, kind, chars, matchCount, error })), null, 2))
