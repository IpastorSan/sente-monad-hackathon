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
import { GATED_TOOLS, toResultText, type GatedTool, type ToolOutcome } from './gate';

export type RunnerTool = ReturnType<typeof betaZodTool>;

/**
 * Told of every tool outcome the model is about to read (SEN-178, the run
 * transcript), including input the schema rejected before the gate saw it.
 * `toolUseId` is the model's id for the call; absent for a schema rejection,
 * which the runner parses before it hands the call over.
 */
export type ToolObserver = (observed: {
  readonly tool: string;
  readonly toolUseId?: string;
  readonly outcome: ToolOutcome;
}) => void;

export function toRunnerTools(
  ctx: ToolContext,
  tools: readonly GatedTool[] = GATED_TOOLS,
  observe?: ToolObserver,
): RunnerTool[] {
  return tools.map((tool) => {
    const runnable = betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input,
      run: async (args, context) => {
        const outcome = await tool.invoke(ctx, args);
        observe?.({ tool: tool.name, toolUseId: context?.toolUse.id, outcome });
        if (!outcome.ok) throw new ToolError(outcome.message);
        return toResultText(outcome.result);
      },
    });
    if (!observe) return runnable;
    const parse = runnable.parse.bind(runnable);
    return {
      ...runnable,
      parse: (content: unknown) => {
        try {
          return parse(content);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          observe({
            tool: tool.name,
            outcome: {
              ok: false,
              message: `Input rejected by the tool schema: ${detail}`,
              refusal: { layer: 'sente', code: 'invalid_input' },
            },
          });
          throw error;
        }
      },
    };
  });
}
