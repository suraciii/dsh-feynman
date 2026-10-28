import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createResearchTools } from '../lib/research-tools.js'
import { createNativeExecutor } from '../lib/upstream.js'
import { createResearchSkillProvider, createRoleTool, ROLES } from '../lib/resources.js'
import { storedWebResults, createSearchContentTool, createCodeSearchTool } from '../lib/web-results.js'
import { parseAlphaArgs, alphaCommand } from '../lib/alpha-command.js'
import { apply } from '../index.js'
import { createWorkflowTool } from '../lib/workflow-tool.js'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url))
await mkdir(scratch, { recursive: true })

const refs = () => ({ hfTokenEnv: 'TEST_HF_REF', alphaxivTokenEnv: 'TEST_ALPHA_REF' })
const execution = (cwd, signal = new AbortController().signal) => ({
  callId: 'fixture-call', rootCallId: 'fixture-call', token: Symbol('execution'), signal,
  agent: { session: { id: 'fixture', header: { cwd } } }, deferContext: () => {},
})

test('research catalog gates account tools, validates inputs, and keeps local annotations', async () => {
  const executor = createNativeExecutor()
  try {
    const publicTools = createResearchTools({ get: () => undefined }, refs, false, executor)
    const accountTools = createResearchTools({ get: () => undefined }, refs, true, executor)
    for (const name of ['feynman_science_database_search', 'hf_dataset_info', 'hf_repo_files', 'hf_repo_read_file', 'document_parse', 'document_search', 'document_screenshot', 'alpha_annotate_paper', 'alpha_list_annotations']) assert.ok(publicTools.some((tool) => tool.name === name), name)
    for (const name of ['alpha_search', 'alpha_get_paper', 'alpha_ask_paper', 'alpha_read_code']) {
      assert.ok(!publicTools.some((tool) => tool.name === name), name)
      assert.ok(accountTools.some((tool) => tool.name === name), name)
    }
    const science = publicTools.find((tool) => tool.name === 'feynman_science_database_search')
    await assert.rejects(science.execute({ source: 'invented', query: 'topic' }, execution()), /source/)
    const screenshot = publicTools.find((tool) => tool.name === 'document_screenshot')
    await assert.rejects(screenshot.execute({ path: 'file.pdf', dpi: 100000 }, execution()), /Invalid arguments/)
  } finally { await executor.dispose() }
})

test('HF credentials resolve per call, remain out of output, and cancellation reaches fetch', async () => {
  const original = globalThis.fetch
  const executor = createNativeExecutor()
  const seen = []
  let secret = 'hf_private_token_first'
  const tools = createResearchTools({ get: (name) => name === 'credentials' ? { resolve: async (ref) => ref === 'TEST_HF_REF' ? { value: secret } : undefined } : undefined }, refs, false, executor)
  const hf = tools.find((tool) => tool.name === 'hf_dataset_info')
  try {
    globalThis.fetch = async (url, init) => {
      seen.push(init.headers.get('Authorization'))
      return new Response(JSON.stringify({ id: 'lab/data', cardData: { dataset_info: { features: ['text'], splits: ['train'] }, note: secret } }), { headers: { 'content-type': 'application/json' } })
    }
    const first = await hf.execute({ dataset: 'lab/data' }, execution())
    assert.ok(!JSON.stringify(first).includes(secret))
    assert.deepEqual(first.details.datasetInfo.features, ['text'])
    secret = 'hf_private_token_second'
    await hf.execute({ dataset: 'lab/data' }, execution())
    assert.deepEqual(seen, ['Bearer hf_private_token_first', 'Bearer hf_private_token_second'])
    const controller = new AbortController()
    let started
    const ready = new Promise((resolve) => { started = resolve })
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      started()
    })
    const pending = hf.execute({ dataset: 'lab/data' }, execution(undefined, controller.signal))
    await ready
    controller.abort(new Error('fixture cancellation'))
    await assert.rejects(pending, /fixture cancellation/)
  } finally { globalThis.fetch = original; await executor.dispose() }
})

test('managed OpenAlex key is request-only and optional model nulls are normalized', async () => {
  const original = globalThis.fetch
  const executor = createNativeExecutor()
  const secret = 'openalex_private_token'
  const tool = createResearchTools({ get: (name) => name === 'credentials' ? { resolve: async (ref) => ref === 'OPENALEX_API_KEY' ? { value: secret } : undefined } : undefined }, refs, false, executor).find((item) => item.name === 'feynman_science_database_search')
  try {
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).searchParams.get('api_key'), secret)
      return new Response(JSON.stringify({ meta: { count: 1 }, results: [{ id: 'https://openalex.org/W1', title: 'A study', publication_year: 2025, cited_by_count: 10, doi: 'https://doi.org/10.1000/example' }] }), { headers: { 'content-type': 'application/json' } })
    }
    const result = await tool.execute({ source: 'openalex', query: 'study', sort: 'null', limit: '1' }, execution())
    assert.match(JSON.stringify(result), /A study/)
    assert.ok(!JSON.stringify(result).includes(secret))
  } finally { globalThis.fetch = original; await executor.dispose() }
})

test('PubMed preserves inline scientific terms and every author/group affiliation', async () => {
  const original = globalThis.fetch
  const executor = createNativeExecutor()
  const tool = createResearchTools({ get: () => undefined }, refs, false, executor).find((item) => item.name === 'feynman_science_database_search')
  try {
    globalThis.fetch = async () => new Response('<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345</PMID><Article><ArticleTitle>Study of <i>BRCA1</i></ArticleTitle><Abstract><AbstractText>Response of <i>BRCA1</i> cells.</AbstractText></Abstract><Journal><Title>Journal</Title><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>Smith</LastName><ForeName>Alice</ForeName><AffiliationInfo><Affiliation>First Institute</Affiliation></AffiliationInfo><AffiliationInfo><Affiliation>Second Institute</Affiliation></AffiliationInfo></Author><Author><CollectiveName>Study Consortium</CollectiveName><AffiliationInfo><Affiliation>Group Institute</Affiliation></AffiliationInfo></Author></AuthorList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>', { headers: { 'content-type': 'text/xml' } })
    const result = await tool.execute({ source: 'pubmed', query: 'pmid:12345' }, execution())
    const json = JSON.stringify(result)
    for (const value of ['BRCA1', 'First Institute', 'Second Institute', 'Study Consortium', 'Group Institute']) assert.ok(json.includes(value), value)
  } finally { globalThis.fetch = original; await executor.dispose() }
})

function pdfFixture() {
  const stream = 'BT /F1 16 Tf 40 100 Td (Research evidence BRCA1) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i += 1) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return pdf
}

test('real document worker parses, searches, screenshots, and rejects workspace escapes', async () => {
  const root = await mkdtemp(join(scratch, 'feynman-doc-test-'))
  const outside = await mkdtemp(join(scratch, 'feynman-outside-'))
  const executor = createNativeExecutor()
  const saved = []
  const tools = createResearchTools({ get: (name) => name === 'attachments' ? { saveImage: async (image) => { saved.push(image); return { hash: 'fixture-png', mediaType: 'image/png', width: 300, height: 150 } } } : undefined }, refs, false, executor)
  const tool = (name) => tools.find((item) => item.name === name)
  try {
    await writeFile(join(root, 'paper.pdf'), pdfFixture())
    await writeFile(join(outside, 'private.pdf'), pdfFixture())
    const parsed = await tool('document_parse').execute({ path: 'paper.pdf', ocr: 'off' }, execution(root))
    assert.match(JSON.stringify(parsed), /Research evidence BRCA1/)
    const searched = await tool('document_search').execute({ path: 'paper.pdf', phrase: 'BRCA1', ocr: 'off' }, execution(root))
    assert.match(JSON.stringify(searched), /BRCA1/)
    const screenshot = await tool('document_screenshot').execute({ path: 'paper.pdf', pages: '1', dpi: 72 }, execution(root))
    assert.ok(saved.length > 0, 'native screenshot was not delivered through the attachment service')
    assert.equal(saved[0].data.subarray(1, 4).toString(), 'PNG')
    assert.ok(screenshot.content.some((part) => part.type === 'image' && part.attachment.hash === 'fixture-png'))
    await symlink(join(outside, 'private.pdf'), join(root, 'escape.pdf'))
    await assert.rejects(tool('document_parse').execute({ path: 'escape.pdf' }, execution(root)), /outside the session workspace/)
    const aborted = new AbortController(); aborted.abort(new Error('stop document'))
    await assert.rejects(tool('document_parse').execute({ path: 'paper.pdf' }, execution(root, aborted.signal)), /stop document/)
  } finally { await executor.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('DOCX fallback handles thrown parser errors and preserves text beyond the preview', async () => {
  const root = await mkdtemp(join(scratch, 'feynman-docx-test-'))
  let outputPath
  try {
    const text = `${'Evidence '.repeat(8000)}final paragraph`
    const xml = Buffer.from(`<w:document><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:document>`)
    const name = Buffer.from('word/document.xml')
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(xml.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(xml.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28)
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + xml.length, 16)
    await writeFile(join(root, 'paper.docx'), Buffer.concat([local, name, xml, central, name, end]))
    const executor = { execute: async () => { throw new Error('LibreOffice is not installed') } }
    const tool = createResearchTools({ get: () => undefined }, refs, false, executor).find((item) => item.name === 'document_parse')
    const result = await tool.execute({ path: 'paper.docx' }, execution(root))
    outputPath = result.details.outputPath
    assert.equal(result.details.fallback, true)
    assert.equal(result.details.truncated, true)
    assert.ok(!result.content[0].text.includes('final paragraph'))
    assert.equal(await readFile(outputPath, 'utf8'), text)
  } finally {
    await rm(root, { recursive: true, force: true })
    if (outputPath) await rm(dirname(outputPath), { recursive: true, force: true })
  }
})

test('all research skills load with bounded locators and all four roles have evidence contracts', async () => {
  const provider = createResearchSkillProvider()
  const candidates = await provider.list()
  assert.ok(candidates.length >= 16)
  for (const candidate of candidates) {
    const skill = await provider.get(candidate)
    assert.ok(skill.content.length > 50, candidate.name)
    assert.ok(candidate.name.startsWith('feynman-'))
  }
  assert.equal(await provider.get({ name: candidates[0].name, locator: '../../etc/passwd' }), undefined)
  const controller = new AbortController(); controller.abort()
  assert.deepEqual(await provider.list({ signal: controller.signal }), [])
  for (const role of ['researcher', 'writer', 'verifier', 'reviewer']) assert.ok((await createRoleTool().execute({ role }, execution())).content.length > 100)
  assert.equal(Object.keys(ROLES).length, 4)
})

const webEvents = [
  { type: 'tool/call', data: { callId: 'search-id', name: 'web_search', arguments: '{"query":"BRCA1"}' } },
  { type: 'tool/result', data: { message: { toolCallId: 'search-id', content: [{ type: 'text', text: 'BRCA1 primary source https://example.org/paper' }], isError: false } } },
]

test('stored web browsing is current-session evidence, and code search preserves parent cancellation/context', async () => {
  const session = { snapshotEvents: () => webEvents }
  assert.equal(storedWebResults(session, 'brca1').length, 1)
  assert.equal(storedWebResults(session, 'missing').length, 0)
  const result = await createSearchContentTool().execute({ id: 'search-id', maxChars: 5 }, { ...execution(), agent: { session } })
  assert.equal(result.text, 'BRCA1'); assert.equal(result.truncated, true)
  let called
  const context = { role: 'user', content: [] }
  const code = createCodeSearchTool({ schemas: () => [{ name: 'web_search', parameters: { properties: { queries: {} } } }], execute: async (call) => { called = call; return { isError: false, content: [{ type: 'text', text: 'code result' }], value: { source: 'host' }, additionalContexts: [context] } } })
  const exec = execution(); const deferred = []; exec.deferContext = (item) => deferred.push(item)
  await code.execute({ query: 'transformer implementation' }, exec)
  assert.equal(called.signal, exec.signal); assert.equal(called.parent, exec.token)
  assert.match(called.arguments.queries[0], /github.com/)
  assert.deepEqual(deferred, [context])
})

test('alpha command grammar rejects malformed flags and dispatches through DSH policy pipeline', async () => {
  assert.deepEqual(parseAlphaArgs('search "scaling laws" --mode keyword').args, { query: 'scaling laws', mode: 'keyword' })
  assert.deepEqual(parseAlphaArgs('get arxiv:2401.12345 --full-text').args, { paper: 'arxiv:2401.12345', fullText: true })
  assert.throws(() => parseAlphaArgs('search x --mode invented'), /Usage/)
  let call
  const state = { research: { tools: [{ name: 'alpha_search' }] }, toolRuntime: { execute: async (args) => { call = args; return { isError: false, value: { content: [{ type: 'text', text: 'paper result' }] } } } } }
  const text = await alphaCommand({ rawInput: 'search "scaling laws"', agent: execution().agent }, state, () => {})
  assert.equal(text, 'paper result'); assert.equal(call.name, 'alpha_search'); assert.equal(call.arguments.query, 'scaling laws')
})

test('source curator changes the next search decision and web browsing never queries old sessions', async () => {
  let handler
  const hooks = new Map()
  const agent = { session: { id: 'web-session', snapshotEvents: () => webEvents }, followup: () => {}, inject: () => {} }
  apply({ effect: (fn) => fn(), commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: (name, listener) => { hooks.set(name, listener); return () => {} }, get: () => undefined }, {})
  const run = (rawInput) => handler({ rawInput, agent, attachments: [] })
  assert.match((await run('search BRCA1')).text, /search-id/)
  assert.equal((await run('curator on')).kind, 'success')
  const post = hooks.get('tools/post-execute')
  const accepted = await post({ name: 'web_search', agent, signal: new AbortController().signal }, { isError: false }, async () => ({ kind: 'accept' }))
  assert.match(accepted.additionalContexts[0].content[0].text, /wait for the user to choose/)
  await run('curator off')
  assert.deepEqual(await post({ name: 'web_search', agent }, { isError: false }, async () => ({ kind: 'accept' })), { kind: 'accept' })
})

test('model workflow loading supplies complete protocols and validates summarize controls', async () => {
  const tool = createWorkflowTool(refs)
  const review = await tool.execute({ workflow: 'review', input: 'arxiv:2401.12345' }, execution())
  assert.match(review.instructions, /outputs\/.drafts\/2401-12345-review-evidence\.md/)
  assert.match(review.instructions, /Reproducibility and Verification/)
  await assert.rejects(tool.execute({ workflow: 'summarize', input: 'paper.pdf --overlap 7000' }, execution()), /window-size/)
  await assert.rejects(tool.execute({ workflow: 'review', input: '' }, execution()), /target/)
  const log = await tool.execute({ workflow: 'log', input: '' }, execution())
  assert.match(log.instructions, /Write a session log for the current research work/)
  assert.match(log.instructions, /notes\/` as markdown with a date-oriented filename/)
})

test('research tools mount, execute, and unload through the real DSH tool runtime', async () => {
  const ctx = new Context()
  const sections = new Set()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: (section) => { sections.add(section.name); return () => sections.delete(section.name) } })
  const runtime = new ToolRuntime(ctx)
  const registered = []
  ctx.provide('commands', { register: (definition) => { registered.push(definition); return () => registered.splice(registered.indexOf(definition), 1) } })
  ctx.provide('agents', { get: () => undefined })
  let provider
  ctx.provide('skills', { registerProvider: (create) => { provider = create(); return () => { provider = undefined } } })
  const original = globalThis.fetch
  const fiber = await ctx.plugin({ name: 'feynman', inject: ['commands', 'agents'], apply }, {})
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(runtime.schemas().some((tool) => tool.name === 'document_parse'))
    assert.ok(runtime.schemas().some((tool) => tool.name === 'feynman_workflow'))
    assert.ok((await provider.list()).length >= 16)
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'lab/data', tags: ['fixture'] }), { headers: { 'content-type': 'application/json' } })
    const result = await runtime.execute({ name: 'hf_dataset_info', arguments: { dataset: 'lab/data' }, callId: 'real-runtime-call', signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.details.id, 'lab/data')
    assert.match(result.content[0].text, /lab\/data/)
  } finally { globalThis.fetch = original; await fiber.dispose() }
  assert.deepEqual(runtime.schemas(), [])
  assert.equal(provider, undefined)
  assert.equal(registered.length, 0)
  assert.ok(!sections.has('feynman-research'))
})

test('research-key commands store exact refs without echoing values or admitting prototype names', async () => {
  let handler
  const written = []
  apply({ effect: (fn) => fn(), commands: { register: (definition) => { handler = definition.handler; return () => {} } }, on: () => () => {}, get: (name) => name === 'credentials' ? { set: async (ref, value) => written.push([ref, value]) } : undefined }, {})
  const agent = execution().agent
  for (const [name, ref] of [['hf', 'HF_TOKEN'], ['openalex', 'OPENALEX_API_KEY'], ['semanticscholar', 'SEMANTIC_SCHOLAR_API_KEY']]) {
    const result = await handler({ rawInput: `keys set ${name} private-fixture-value`, agent, attachments: [] })
    assert.equal(result.kind, 'success')
    assert.equal(written.at(-1)[0], ref)
    assert.ok(!result.text.includes('private-fixture-value'))
  }
  for (const input of ['keys set constructor value', 'keys set __proto__ value', 'constructor sample', '__proto__ sample']) assert.equal((await handler({ rawInput: input, agent, attachments: [] })).kind, 'error')
  assert.equal(written.length, 3)
})

test('fetch routing classifies papers, repositories, issues, and blobs', async () => {
  const { classifyUrl } = await import('../lib/fetch-content.js')
  assert.equal(classifyUrl('https://arxiv.org/pdf/2401.12345').kind, 'pdf')
  assert.equal(classifyUrl('https://example.org/paper.PDF').kind, 'pdf')
  assert.equal(classifyUrl('https://arxiv.org/abs/2401.12345').kind, 'web')
  assert.equal(classifyUrl('https://example.com/blog').kind, 'web')
  assert.deepEqual(
    (({ kind, owner, repo }) => ({ kind, owner, repo }))(classifyUrl('https://github.com/Companion-Inc/feynman')),
    { kind: 'github-repo', owner: 'Companion-Inc', repo: 'feynman' },
  )
  assert.equal(classifyUrl('https://github.com/o/r/issues/12').kind, 'github-issue')
  assert.equal(classifyUrl('https://github.com/o/r/pull/12').kind, 'github-pull')
  assert.equal(classifyUrl('https://github.com/o/r/blob/main/src/a.ts').path, 'src/a.ts')
  assert.throws(() => classifyUrl('file:///etc/passwd'), /http/)
})

test('fetch reads GitHub sources, stores full text, and search_content pages and finds in it', async () => {
  const original = globalThis.fetch
  try {
    const body = Array.from({ length: 40 }, (_, i) => `paragraph ${i} about scaling laws`).join('\n')
    globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/markdown' } })
    const { createFetchContentTool } = await import('../lib/fetch-content.js')
    const { createContentStore } = await import('../lib/content-store.js')
    const store = createContentStore()
    const root = await mkdtemp(join(scratch, 'fetch-'))
    try {
      const tool = createFetchContentTool({ schemas: () => [], execute: async () => { throw new Error('host tools are not needed here') } }, { store })
      const result = await tool.execute({ urls: ['https://github.com/o/r', 'https://github.com/o/r/issues/7'] }, execution(root))
      assert.equal(result.ok, 1)
      assert.equal(result.failed, 1, JSON.stringify(result.items))
      assert.equal(result.items[0].kind, 'github-repo')
      assert.match(result.items[0].text, /scaling laws/)
      assert.ok(result.items[0].savedPath.startsWith(join(root, '.feynman', 'fetch')))
      assert.equal(await readFile(result.items[0].savedPath, 'utf8'), body)

      const search = createSearchContentTool({ store })
      const page = await search.execute({ id: result.items[0].id, offset: 10, limit: 25 }, execution(root))
      assert.equal(page.text, body.slice(10, 35))
      assert.equal(page.totalChars, body.length)
      assert.equal(page.nextOffset, 35)
      await assert.rejects(search.execute({ id: result.items[0].id, findText: '([', findMode: 'regex' }, execution(root)), /not a valid regular expression/)
      const found = await search.execute({ id: result.items[0].id, findText: 'PARAGRAPH 12' }, execution(root))
      assert.equal(found.matchCount, 1)
      assert.match(found.matches[0].context, /paragraph 12 about scaling laws/)
      const latest = await search.execute({ limit: 20 }, execution(root))
      assert.equal(latest.id, result.items[0].id)
      assert.equal(latest.text, body.slice(0, 20))
    } finally { await rm(root, { recursive: true, force: true }) }
  } finally { globalThis.fetch = original }
})

test('fetch parses PDFs through document_parse and falls back to the host reader for HTML', async () => {
  const original = globalThis.fetch
  const parseDir = await mkdtemp(join(scratch, 'parse-'))
  const fullTextPath = join(parseDir, 'parsed.txt')
  await writeFile(fullTextPath, 'Parsed PDF page 1\nParsed PDF page 2\n')
  try {
    const calls = []
    const runtime = {
      schemas: () => [
        { name: 'web_fetch', parameters: { properties: { url: {} } } },
        { name: 'document_parse', parameters: { properties: { path: {} } } },
      ],
      execute: async (call) => {
        calls.push(call)
        if (call.name === 'web_fetch') return { isError: false, content: [{ type: 'text', text: 'host page' }], value: { url: 'https://example.com/a', statusCode: 200, body: { kind: 'html', content: '<html><body><h1>Title</h1><p>Host readable text</p></body></html>' } } }
        // document_parse returns a preview plus the full-text path; the fetch tool must store the full text.
        return { isError: false, content: [{ type: 'text', text: 'Parsed document: preview only' }], value: { details: { outputPath: fullTextPath } } }
      },
    }
    globalThis.fetch = async () => new Response(Buffer.from('%PDF-1.4 fixture'), { headers: { 'content-type': 'application/pdf' } })
    const { createFetchContentTool } = await import('../lib/fetch-content.js')
    const { createContentStore } = await import('../lib/content-store.js')
    const store = createContentStore()
    const root = await mkdtemp(join(scratch, 'fetch-pdf-'))
    try {
      const result = await createFetchContentTool(runtime, { store }).execute({ urls: ['https://arxiv.org/pdf/2401.00001', 'https://example.com/a'] }, execution(root))
      assert.equal(result.failed, 0, JSON.stringify(result.items))
      const [pdf, web] = result.items
      assert.equal(pdf.kind, 'pdf')
      assert.match(pdf.text, /Parsed PDF page 1/)
      const parseCall = calls.find((call) => call.name === 'document_parse')
      assert.ok(parseCall.arguments.path.endsWith('.pdf'))
      assert.equal(web.text, 'Title\nHost readable text')
      assert.equal(calls.find((call) => call.name === 'web_fetch').arguments.url, 'https://example.com/a')
      assert.equal(await readFile(pdf.savedPath, 'utf8'), 'Parsed PDF page 1\nParsed PDF page 2')
      assert.equal(store.get(pdf.id).text, 'Parsed PDF page 1\nParsed PDF page 2')
    } finally { await rm(root, { recursive: true, force: true }) }
  } finally { globalThis.fetch = original }
})
