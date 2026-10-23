import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'

const base = new URL('../resources/', import.meta.url)
export const ROLES = JSON.parse(readFileSync(new URL('roles.json', base), 'utf8'))
const catalog = JSON.parse(readFileSync(new URL('catalog.json', base), 'utf8'))

export function createResearchSkillProvider() {
  const candidates = catalog.map(({ name, description, file }) => ({
    name, description, path: fileURLToPath(new URL(file, base)), locator: file,
    invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    provider: 'feynman',
  }))
  return {
    name: 'feynman',
    async list(options = {}) { return options.signal?.aborted ? [] : candidates },
    async get(candidate, options = {}) {
      if (options.signal?.aborted) return undefined
      const known = candidates.find((entry) => entry.name === candidate.name && entry.locator === candidate.locator)
      if (!known) return undefined
      const source = readFileSync(new URL(known.locator, base), 'utf8')
      return { ...known, resourceBase: { kind: 'directory', path: fileURLToPath(base) }, content: source.replace(/^---\n[\s\S]*?\n---\n/, '').trim() }
    },
  }
}

export function createRoleTool() {
  return defineTool({
    name: 'feynman_research_role',
    description: 'Load the researcher, writer, verifier, or reviewer research protocol before assigning a DSH subagent. Roles are instructions, not model aliases.',
    parameters: { role: { type: 'string', enum: Object.keys(ROLES), required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.content }] },
    async execute({ role }) { return { role, ...ROLES[role] } },
  })
}
