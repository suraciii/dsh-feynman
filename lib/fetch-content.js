/**
 * `feynman_fetch_content`: remote source acquisition for the research workflows.
 *
 * Upstream Feynman ships a Pi web-access extension with `fetch_content`,
 * `get_search_content`, and `source_check`. The DSH host only exposes a single
 * URL `web_fetch` (HTML/text, no PDF), so this tool fills the gap: it routes
 * HTML through the host reader when mounted, reads PDFs by saving them into the
 * workspace and delegating to `document_parse`, and resolves GitHub repository,
 * issue, and blob URLs through the public API/raw endpoints.
 *
 * Every fetched text is also registered in a bounded in-memory store so
 * `feynman_search_content` can page or search the full document, not just the
 * inline window returned here.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

const MAX_URLS = 6
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
const TIMEOUT_MS = 45000
const INLINE_ITEM_CHARS = 30000
const INLINE_TOTAL_CHARS = 90000
const FETCH_DIR = join('.feynman', 'fetch')
const USER_AGENT = 'dsh-feynman (+https://github.com/maci0/dsh-feynman)'

const idFor = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16)

function workspaceRoot(exec) {
  return exec.agent?.session?.header?.cwd
}

function absoluteHttpUrl(value) {
  let url
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error(`Not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) URLs can be fetched: ${value}`)
  return url
}

/** GitHub URL shapes worth special-casing; everything else goes through the reader. */
export function classifyUrl(input) {
  const url = input instanceof URL ? input : absoluteHttpUrl(input)
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    const pdf = /\.pdf$/i.test(url.pathname) || (url.hostname.endsWith('arxiv.org') && /^\/pdf\//.test(url.pathname))
    return { kind: pdf ? 'pdf' : 'web', url }
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length >= 2 && !['features', 'topics', 'about', 'pricing', 'login', 'settings', 'orgs', 'sponsors', 'marketplace', 'explore', 'notifications'].includes(parts[0])) {
    const [owner, repo, marker, ref, ...rest] = parts
    if (!marker) return { kind: 'github-repo', url, owner, repo: repo.replace(/\.git$/, '') }
    if (marker === 'issues' || marker === 'pull') {
      const number = Number.parseInt(ref ?? '', 10)
      if (Number.isInteger(number) && number > 0) return { kind: marker === 'pull' ? 'github-pull' : 'github-issue', url, owner, repo, number }
    }
    if (marker === 'blob' && ref && rest.length) return { kind: 'github-blob', url, owner, repo, ref, path: rest.join('/') }
    if (marker === 'tree' && ref) return { kind: 'github-tree', url, owner, repo, ref, path: rest.join('/') }
    return { kind: 'github-repo', url, owner, repo: repo.replace(/\.git$/, '') }
  }
  return { kind: 'web', url }
}

async function request(url, { signal, accept } = {}) {
  const signals = [signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean)
  return globalThis.fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.any(signals),
    headers: { 'user-agent': USER_AGENT, ...(accept ? { accept } : {}) },
  })
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`Response is ${declared} bytes; the ${MAX_DOWNLOAD_BYTES} byte fetch limit was exceeded`)
  const chunks = []
  let total = 0
  if (!response.body) return Buffer.alloc(0)
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(`Response exceeded the ${MAX_DOWNLOAD_BYTES} byte fetch limit`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function decode(buffer, contentType = '') {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  try {
    return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function textOf(result) {
  return (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function hostTool(runtime, name) {
  const schemas = runtime?.schemas?.() ?? []
  return schemas.some((tool) => tool.name === name)
}

async function dispatch(exec, runtime, name, args) {
  const result = await runtime.execute({
    callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token,
    agent: exec.agent, signal: exec.signal, name, arguments: args,
  })
  if (result.isError) throw new Error(textOf(result) || `${name} failed`)
  return result
}

async function readWithHost(exec, runtime, url, mode) {
  if (!hostTool(runtime, 'web_fetch')) return undefined
  const result = await dispatch(exec, runtime, 'web_fetch', { url: String(url) })
  const value = result.value ?? {}
  const body = value.body ?? {}
  if (body.kind === 'text' && typeof body.content === 'string') return { text: body.content, finalUrl: value.url ?? String(url), statusCode: value.statusCode, contentType: 'text/plain', truncated: Boolean(value.truncated) }
  if (body.kind === 'html' && typeof body.content === 'string' && mode === 'raw') return { text: body.content, finalUrl: value.url ?? String(url), statusCode: value.statusCode, contentType: 'text/html', truncated: Boolean(value.truncated) }
  if (typeof body.content === 'string') return { text: htmlToText(body.content), finalUrl: value.url ?? String(url), statusCode: value.statusCode, contentType: body.kind === 'html' ? 'text/html' : 'text/plain', truncated: Boolean(value.truncated) }
  return { text: textOf(result), finalUrl: value.url ?? String(url), statusCode: value.statusCode, contentType: 'text/plain', truncated: Boolean(value.truncated) }
}

async function readPdf(exec, runtime, url, save) {
  exec.signal.throwIfAborted()
  const response = await request(url, { signal: exec.signal, accept: 'application/pdf' })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  const bytes = await readBounded(response)
  const savedPath = await save(bytes, '.pdf')
  exec.signal.throwIfAborted()
  if (!hostTool(runtime, 'document_parse')) {
    return { text: `PDF saved to ${savedPath}. The host document_parse tool is not mounted, so the text was not extracted.`, finalUrl: response.url || String(url), statusCode: response.status, contentType: 'application/pdf', savedPath, kind: 'pdf', parseSkipped: true }
  }
  const parsed = await dispatch(exec, runtime, 'document_parse', { path: savedPath, format: 'text' })
  // document_parse returns a bounded preview and writes the full text to a temp
  // file; read that file so the stored copy is the whole document, not a preview.
  const fullPath = parsed.value?.details?.outputPath
  let text
  if (fullPath) text = await readFile(fullPath, 'utf8')
  if (!text?.trim()) text = textOf(parsed) || JSON.stringify(parsed.value ?? {})
  if (text.endsWith('\n')) text = text.replace(/\n+$/, '')
  const textPath = await save(text, '.txt')
  return { text, finalUrl: response.url || String(url), statusCode: response.status, contentType: 'application/pdf', savedPath: textPath, binaryPath: savedPath, kind: 'pdf' }
}

async function readGithub(exec, _runtime, classified, save) {
  const { kind, owner, repo } = classified
  const apiHeaders = { accept: 'application/vnd.github+json' }
  if (kind === 'github-repo') {
    const response = await request(`https://api.github.com/repos/${owner}/${repo}/readme`, { signal: exec.signal, accept: 'application/vnd.github.raw' })
    if (response.status === 404) throw new Error(`${owner}/${repo} or its README is not public (HTTP 404)`)
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} for ${owner}/${repo} (unauthenticated requests are rate-limited; retry later or fetch the raw URL)`)
    const text = decode(await readBounded(response), response.headers.get('content-type') ?? '')
    return { text, finalUrl: `https://github.com/${owner}/${repo}`, statusCode: response.status, contentType: 'text/markdown', kind: 'github-repo' }
  }
  if (kind === 'github-issue' || kind === 'github-pull') {
    const response = await request(`https://api.github.com/repos/${owner}/${repo}/issues/${classified.number}`, { signal: exec.signal, ...{ accept: apiHeaders.accept } })
    if (response.status === 404) throw new Error(`${owner}/${repo}#${classified.number} is not public (HTTP 404)`)
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} for ${owner}/${repo}#${classified.number}`)
    const issue = await response.json()
    const text = [
      `# ${issue.title} (#${issue.number})`,
      `state: ${issue.state} | author: ${issue.user?.login ?? 'unknown'} | created: ${issue.created_at ?? 'unknown'} | comments: ${issue.comments ?? 0}`,
      issue.pull_request ? `pull request: ${issue.pull_request.html_url}` : '',
      (issue.labels ?? []).length ? `labels: ${issue.labels.map((label) => label.name).join(', ')}` : '',
      '',
      issue.body ?? '(no body)',
    ].filter((line) => line !== '').join('\n')
    return { text, finalUrl: issue.html_url ?? String(classified.url), statusCode: response.status, contentType: 'text/markdown', kind }
  }
  if (kind === 'github-blob') {
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${classified.ref}/${classified.path}`
    const response = await request(raw, { signal: exec.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${raw}`)
    const contentType = response.headers.get('content-type') ?? ''
    const buffer = await readBounded(response)
    if (contentType.startsWith('image/') || contentType.startsWith('application/octet')) {
      const savedPath = await save(buffer, extname(classified.path) || '.bin')
      return { text: `Binary file saved to ${savedPath} (${contentType}, ${buffer.length} bytes).`, finalUrl: raw, statusCode: response.status, contentType, savedPath, kind }
    }
    return { text: decode(buffer, contentType), finalUrl: raw, statusCode: response.status, contentType, kind }
  }
  if (kind === 'github-tree') {
    const response = await request(`https://api.github.com/repos/${owner}/${repo}/contents/${classified.path}?ref=${encodeURIComponent(classified.ref)}`, { signal: exec.signal, accept: apiHeaders.accept })
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} for ${owner}/${repo}/${classified.path}`)
    const entries = await response.json()
    if (!Array.isArray(entries)) throw new Error(`${classified.path} is a file, not a directory; fetch its blob URL instead`)
    const text = entries.map((entry) => `${entry.type === 'dir' ? 'd' : '-'} ${entry.path}${entry.size ? ` (${entry.size} bytes)` : ''}`).join('\n')
    return { text, finalUrl: String(classified.url), statusCode: response.status, contentType: 'text/plain', kind }
  }
  throw new Error(`Unsupported GitHub URL: ${classified.url}`)
}

async function readWeb(exec, runtime, url, mode, save) {
  const viaHost = await readWithHost(exec, runtime, url, mode).catch((error) => {
    if (exec.signal.aborted) throw error
    return { hostError: error.message }
  })
  if (viaHost && !viaHost.hostError) return { ...viaHost, kind: 'web' }
  const response = await request(url, { signal: exec.signal })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.startsWith('application/pdf')) {
    // Some hosts serve a PDF without a .pdf path; reuse the PDF branch on the final URL.
    return readPdf(exec, runtime, response.url || url, save)
  }
  const buffer = await readBounded(response)
  const raw = decode(buffer, contentType)
  const text = mode === 'raw' || !/html/i.test(contentType) ? raw : htmlToText(raw)
  return { text, finalUrl: response.url || String(url), statusCode: response.status, contentType, kind: 'web', hostFallback: viaHost ? `host web_fetch failed: ${viaHost.hostError}` : undefined }
}

export function createFetchContentTool(runtime, { store, fetchDir = FETCH_DIR } = {}) {
  return defineTool({
    name: 'feynman_fetch_content',
    description: 'Fetch remote sources as readable text. Handles HTML/Markdown pages, PDFs (saved into the workspace and parsed to text), and GitHub repositories, issues, pull requests, blobs, and trees. Returns an id that feynman_search_content can page with offset/limit or search with findText. Prefer this over web_fetch for papers and code repositories.',
    parameters: {
      url: { type: 'string', description: 'One http(s) URL.' },
      urls: { type: 'array', items: { type: 'string' }, description: `Up to ${MAX_URLS} URLs fetched in order.` },
      mode: { type: 'string', enum: ['readable', 'raw'], description: 'readable (default) extracts page text; raw returns the response body unchanged.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const requested = [...(args.urls ?? []), ...(args.url ? [args.url] : [])]
      if (!requested.length) throw new Error('feynman_fetch_content needs `url` or `urls`')
      if (requested.length > MAX_URLS) throw new Error(`At most ${MAX_URLS} URLs per call; split the batch`)
      // The workspace may arrive relative; document_parse resolves its path
      // against the same root, so an unresolved root would double the prefix.
      const root = workspaceRoot(exec)
      const directory = root ? join(resolve(root), fetchDir) : undefined
      const save = async (data, extension) => {
        if (!directory) throw new Error('No workspace is available to save the fetched file')
        await mkdir(directory, { recursive: true })
        const path = join(directory, `${randomUUID().slice(0, 8)}${extension}`)
        await writeFile(path, data)
        return path
      }

      const items = []
      for (const raw of requested) {
        exec.signal.throwIfAborted()
        const id = idFor(raw)
        try {
          const classified = classifyUrl(raw)
          const mode = args.mode === 'raw' ? 'raw' : 'readable'
          const read = classified.kind === 'pdf'
            ? await readPdf(exec, runtime, classified.url, save)
            : classified.kind === 'web'
              ? await readWeb(exec, runtime, classified.url, mode, save)
              : await readGithub(exec, runtime, classified, save)
          const text = read.text ?? ''
          if (!text.trim()) throw new Error('The source returned no readable text')
          const savedPath = read.savedPath ?? await save(text, '.txt')
          const entry = store?.put({ id, url: String(classified.url), finalUrl: read.finalUrl, text, savedPath, kind: read.kind, createdAt: Date.now() })
          items.push({
            id, url: String(classified.url), finalUrl: read.finalUrl, kind: read.kind,
            statusCode: read.statusCode, contentType: read.contentType, chars: text.length,
            savedPath: entry?.savedPath ?? savedPath,
            ...(read.binaryPath ? { binaryPath: read.binaryPath } : {}),
            ...(read.truncated ? { truncatedByHost: true } : {}),
            ...(read.hostFallback ? { hostFallback: read.hostFallback } : {}),
            ...(read.parseSkipped ? { parseSkipped: true } : {}),
            text: text.slice(0, INLINE_ITEM_CHARS),
            truncated: text.length > INLINE_ITEM_CHARS,
          })
        } catch (error) {
          if (exec.signal.aborted) throw exec.signal.reason
          items.push({ id, url: String(raw), error: error instanceof Error ? error.message : String(error) })
        }
      }

      let budget = INLINE_TOTAL_CHARS
      for (const item of items) {
        if (item.error) continue
        if (budget <= 0) {
          item.text = ''
          item.truncated = true
          item.elided = true
          continue
        }
        if (item.text.length > budget) {
          item.text = item.text.slice(0, budget)
          item.truncated = true
        }
        budget -= item.text.length
      }
      return {
        items,
        ok: items.filter((item) => !item.error).length,
        failed: items.filter((item) => item.error).length,
        note: 'Full text is stored under the returned id: page it with feynman_search_content (offset/limit) or search it with findText. Saved copies live under .feynman/fetch/.',
      }
    },
  })
}
