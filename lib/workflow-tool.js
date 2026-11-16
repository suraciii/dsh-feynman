import { defineTool } from '@deepseek-ai/dsh-tools'
import { WORKFLOWS, buildPrompt, parseSummarizeArgs } from '../prompts.js'
import { DEFAULT_ARTIFACT_ROOT, MARKER_DIR, MARKER_FILE } from './project-paths.js'

/** `resolveRoot(session)` returns `{ root, detail? }`; callers pass the session layout. */
export function createWorkflowTool(refs, resolveRoot = () => ({ root: '' })) {
  return defineTool({
    name: 'feynman_workflow',
    description: `Load the complete research workflow protocol for a target so an agent can perform it without a human slash command. Follow the returned instructions and write the declared artifacts under the project artifact root (\`${DEFAULT_ARTIFACT_ROOT}/\` by default; recorded in \`${MARKER_DIR}/${MARKER_FILE}\`).`,
    parameters: {
      workflow: { type: 'string', enum: Object.keys(WORKFLOWS).filter((name) => name !== 'review-loop'), required: true },
      input: { type: 'string', required: true, description: 'Workflow target; `log` also accepts an empty string.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.instructions }] },
    async execute({ workflow, input }, exec) {
      exec.signal.throwIfAborted()
      // `/log` is the one workflow whose upstream form takes no target.
      if (!input.trim() && workflow !== 'log') throw new Error('A workflow target is required')
      const args = workflow === 'summarize' ? parseSummarizeArgs(input) : input
      if (workflow === 'summarize' && (args.error || args.unsupported.length || !args.source)) throw new Error(args.error ?? 'Invalid summarize arguments')
      const layout = resolveRoot(exec.agent?.session) ?? { root: '' }
      return { workflow, instructions: buildPrompt(workflow, args, refs(), { root: layout.root, note: layout.detail ?? layout.note }) }
    },
  })
}
