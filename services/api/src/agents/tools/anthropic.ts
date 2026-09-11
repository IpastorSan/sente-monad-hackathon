/**
 * The gated tools as Tool Runner tools (`client.beta.messages.toolRunner`).
 *
 * `betaZodTool`, not `betaTool`: its `parse` runs the zod schema, so input the
 * model got wrong is rejected by the runner before `run` is ever called.
 * (`betaTool`'s `parse` is only a type cast.) A refusal throws `ToolError`, so
 * the runner returns it to the model as an `is_error` tool result and the
 * loop carries on.
 */
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '@anthropic-ai/sdk/resources/beta/messages';

import type { ToolContext } from './context';
import { GATED_TOOLS, toResultText, type GatedTool } from './gate';

export type RunnerTool = ReturnType<typeof betaZodTool>;

export function toRunnerTools(
  ctx: ToolContext,
  tools: readonly GatedTool[] = GATED_TOOLS,
): RunnerTool[] {
  return tools.map((tool) =>
    betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input,
      run: async (args) => {
        const outcome = await tool.invoke(ctx, args);
        if (!outcome.ok) throw new ToolError(outcome.message);
        return toResultText(outcome.result);
      },
    }),
  );
}
