import { defineTool } from '@deepseek-ai/dsh-tools'
import { WORKFLOWS, buildPrompt, parseSummarizeArgs } from '../prompts.js'

export function createWorkflowTool(refs) {
  return defineTool({
    name: 'feynman_workflow',
    description: 'Load the complete research workflow protocol for a target so an agent can perform it without a human slash command. Follow the returned instructions and write the declared artifacts.',
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
      return { workflow, instructions: buildPrompt(workflow, args, refs()) }
    },
  })
}
