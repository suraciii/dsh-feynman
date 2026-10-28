/**
 * Check that `lib/init-scaffold.js` copies the upstream v0.5.58 templates verbatim.
 *
 * The upstream templates live in a TypeScript template literal, so escaped
 * backticks are unescaped before comparing.
 *
 * Run: node experiments/check-init-templates.mjs
 */
import { readFileSync } from 'node:fs'
import { PROJECT_AGENTS_TEMPLATE, SESSION_LOGS_README } from '../lib/init-scaffold.js'

const upstreamPath = 'outputs/.work/upstream-0541/extensions/research-tools/project-scaffold.ts'
const source = readFileSync(upstreamPath, 'utf8')

function template(name) {
  const start = source.indexOf(`export function ${name}`)
  if (start < 0) throw new Error(`${name} not found in ${upstreamPath}`)
  const open = source.indexOf('`', start) + 1
  const close = source.indexOf('`;', open)
  return source.slice(open, close).replace(/\\`/g, '`')
}

const agents = template('buildProjectAgentsTemplate')
const logs = template('buildSessionLogsReadme')
console.log(JSON.stringify({
  agentsEqual: agents === PROJECT_AGENTS_TEMPLATE,
  logsEqual: logs === SESSION_LOGS_README,
  agentsChars: agents.length,
  logsChars: logs.length,
}))
