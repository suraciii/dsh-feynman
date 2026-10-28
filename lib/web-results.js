import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { DEFAULT_WINDOW_CHARS, MAX_WINDOW_CHARS } from './content-store.js'

const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'fetch_content', 'code_search', 'feynman_fetch_content'])

export function storedWebResults(session, query = '') {
  const calls = new Map()
  const results = []
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data)
    if (event.type !== 'tool/result') continue
    const message = event.data.message
    const call = calls.get(message.toolCallId)
    if (!call || !WEB_TOOLS.has(call.name)) continue
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    if (query && !`${call.arguments}\n${text}`.toLowerCase().includes(query.toLowerCase())) continue
    results.push({ id: call.callId, tool: call.name, query: call.arguments, isError: message.isError, text })
  }
  return results
}

const clampLimit = (value) => Math.max(1, Math.min(value ?? DEFAULT_WINDOW_CHARS, MAX_WINDOW_CHARS))

function findMatches(text, needle, { mode, contextChars, maxMatches }) {
  const matches = []
  if (mode === 'regex') {
    let expression
    try {
      expression = new RegExp(needle, 'gi')
    } catch (error) {
      throw new Error(`findText is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const match of text.matchAll(expression)) {
      const index = match.index ?? 0
      matches.push({
        index,
        length: match[0].length,
        context: text.slice(Math.max(0, index - contextChars), Math.min(text.length, index + match[0].length + contextChars)),
      })
      if (matches.length >= maxMatches) break
    }
    return matches
  }
  const haystack = text.toLowerCase()
  const lowered = needle.toLowerCase()
  let from = 0
  while (matches.length < maxMatches) {
    const index = haystack.indexOf(lowered, from)
    if (index < 0) break
    matches.push({
      index,
      length: needle.length,
      context: text.slice(Math.max(0, index - contextChars), Math.min(text.length, index + needle.length + contextChars)),
    })
    from = index + needle.length
  }
  return matches
}

/**
 * Read a stored web/fetch result, by id or the latest one.
 *
 * Without `findText` this returns a character window (`offset`/`limit`), so a
 * long PDF or page can be read page by page instead of being truncated at the
 * head. With `findText` it returns match locations plus surrounding context and
 * does not consume the window.
 */
export function createSearchContentTool({ store } = {}) {
  return defineTool({
    name: 'feynman_search_content',
    description: 'Read or search content already stored in this DSH session or by feynman_fetch_content. Page a long document with offset/limit, or locate passages with findText (literal by default; findMode=regex for a pattern). Use /feynman search to browse result IDs; omit id for the latest result.',
    parameters: {
      id: { type: 'string', description: 'Stored result or fetch id. Omit for the latest stored content.' },
      offset: { type: 'integer', description: 'Character offset of the window (default 0).' },
      limit: { type: 'integer', description: `Window size in characters (default ${DEFAULT_WINDOW_CHARS}, max ${MAX_WINDOW_CHARS}).` },
      maxChars: { type: 'integer', description: 'Deprecated alias for limit.' },
      findText: { type: 'string', description: 'Search the full stored text instead of returning a window.' },
      findMode: { type: 'string', enum: ['literal', 'regex'], description: 'findText matching mode (default literal, case-insensitive).' },
      contextChars: { type: 'integer', description: 'Characters of context around each match (default 200).' },
      maxMatches: { type: 'integer', description: 'Match cap (default 20, max 50).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const fetched = args.id ? store?.get(args.id) : store?.latest()
      const results = fetched ? [] : storedWebResults(exec.agent?.session ?? {})
      const result = fetched
        ? { id: fetched.id, source: fetched.kind ?? 'feynman_fetch_content', url: fetched.finalUrl ?? fetched.url, savedPath: fetched.savedPath, text: fetched.text }
        : args.id ? results.find((item) => item.id === args.id) : results.at(-1)
      if (!result) throw new Error('No matching stored content in this session; run feynman_fetch_content or web_search first')

      const text = result.text ?? ''
      if (args.findText) {
        const matches = findMatches(text, args.findText, {
          mode: args.findMode === 'regex' ? 'regex' : 'literal',
          contextChars: Math.max(0, Math.min(args.contextChars ?? 200, 5000)),
          maxMatches: Math.max(1, Math.min(args.maxMatches ?? 20, 50)),
        })
        return { ...result, totalChars: text.length, findText: args.findText, findMode: args.findMode === 'regex' ? 'regex' : 'literal', matchCount: matches.length, matches }
      }

      const limit = clampLimit(args.limit ?? args.maxChars)
      const offset = Math.max(0, Math.min(args.offset ?? 0, text.length))
      const window = text.slice(offset, offset + limit)
      return {
        ...result,
        totalChars: text.length,
        offset,
        limit,
        nextOffset: offset + window.length < text.length ? offset + window.length : undefined,
        truncated: offset + window.length < text.length,
        text: window,
      }
    },
  })
}

export function createCodeSearchTool(runtime) {
  return defineTool({
    name: 'code_search',
    description: 'Find public code examples and repository documentation through the host web_search provider. Inspect returned source files before treating a snippet as implementation evidence.',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => value.content },
    async execute({ query }, exec) {
      exec.signal.throwIfAborted()
      if (!query.trim()) throw new Error('Code search requires a query')
      const schema = runtime.schemas().find((tool) => tool.name === 'web_search')
      if (!schema) throw new Error('The host web_search tool is not mounted')
      const search = `${query} (site:github.com OR site:readthedocs.io OR site:docs.rs)`
      const properties = schema.parameters.properties ?? {}
      const args = Object.hasOwn(properties, 'queries') ? { queries: [search] } : Object.hasOwn(properties, 'query') ? { query: search } : undefined
      if (!args) throw new Error('The mounted web_search schema has no supported query field')
      const result = await runtime.execute({ callId: randomUUID(), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal, name: 'web_search', arguments: args })
      if (result.isError) throw new Error(result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'))
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      return { query, content: result.content, data: result.value }
    },
  })
}
