import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import type { BasePrompt } from '../../prompts/base';
import type { Action } from '../../actions/builder';
import { NavigatorActionRegistry, NavigatorAgent } from '../navigator';

const readPageSchema = z.object({ intent: z.string().default('') });

// A minimal registered action: only its name and schema matter for parsing the model's output
const readPage = {
  name: () => 'read_page',
  schema: { name: 'read_page', description: 'Read the page', schema: readPageSchema },
  hasIndex: () => false,
  getIndexArg: () => null,
} as unknown as Action;

/**
 * A model wrote the action key with attributes where the colon belongs:
 * `"action" string="false">[{...}]`. The value is there, only the separator is wrong.
 */
const brokenArgs =
  '{"current_state": {"evaluation_previous_goal": "Success", "memory": "On the README tab", "next_goal": "Reading the full README text"}, "action" string="false">[{"read_page": {"intent": "Read the GNN-as-Judge README"}}]}';

// Simulates LangChain: the tool call could not be parsed, so it comes back as an invalid one
function navigatorWithBrokenArgs(context?: unknown) {
  const raw = new AIMessage({
    content: '',
    tool_calls: [],
    invalid_tool_calls: [
      {
        name: 'AgentOutput',
        args: brokenArgs,
        id: 'call_1',
        error: "Expected ':' after property name in JSON at position 407 (line 1 column 408)",
      },
    ],
  });
  const chatLLM = {
    modelName: 'deepseek-flash',
    withStructuredOutput: () => ({ invoke: async () => ({ parsed: null, raw }) }),
  } as unknown as BaseChatModel;
  return new NavigatorAgent(
    new NavigatorActionRegistry([readPage]),
    {
      chatLLM,
      context: (context ?? { controller: new AbortController() }) as AgentContext,
      prompt: {} as BasePrompt,
    },
    { id: 'navigator' },
  );
}

describe('navigator answers that come back unreadable', () => {
  it('reads the step out of tool call args whose key separator is wrong', async () => {
    const output = await navigatorWithBrokenArgs().invoke([]);
    expect(output.action).toEqual([{ read_page: { intent: 'Read the GNN-as-Judge README' } }]);
    expect(output.current_state.next_goal).toBe('Reading the full README text');
  });

  it('tells the model what was wrong with an answer that could not be read', () => {
    const context = { controller: new AbortController(), actionResults: [] } as unknown as AgentContext;
    navigatorWithBrokenArgs(context).reportUnreadableAnswer("Expected ':' after property name in JSON at position 407");
    expect(context.actionResults).toHaveLength(1);
    expect(context.actionResults[0].error).toContain('position 407');
  });
});
