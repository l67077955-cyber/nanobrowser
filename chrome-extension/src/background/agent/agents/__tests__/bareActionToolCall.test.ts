import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import type { BasePrompt } from '../../prompts/base';
import type { Action } from '../../actions/builder';
import { NavigatorActionRegistry, NavigatorAgent } from '../navigator';

const openTabSchema = z.object({ intent: z.string().default(''), url: z.string() });

// A minimal registered action: only its name and schema matter for parsing the model's output
const openTab = {
  name: () => 'open_tab',
  schema: { name: 'open_tab', description: 'Open a url in a new tab', schema: openTabSchema },
  hasIndex: () => false,
  getIndexArg: () => null,
} as unknown as Action;

// Simulates LangChain returning parsed=null because the model sent tool calls other than AgentOutput
function navigatorReturning(toolCalls: Array<{ name: string; args: Record<string, unknown> }>) {
  const raw = new AIMessage({
    content: '',
    tool_calls: toolCalls.map((call, i) => ({ ...call, id: `call_${i}` })),
  });
  const chatLLM = {
    modelName: 'deepseek-flash',
    withStructuredOutput: () => ({ invoke: async () => ({ parsed: null, raw }) }),
  } as unknown as BaseChatModel;
  return new NavigatorAgent(
    new NavigatorActionRegistry([openTab]),
    {
      chatLLM,
      context: { controller: new AbortController() } as unknown as AgentContext,
      prompt: {} as BasePrompt,
    },
    { id: 'navigator' },
  );
}

describe('navigator bare action tool calls', () => {
  it('takes an action called as a tool of its own as the step action', async () => {
    const output = await navigatorReturning([
      { name: 'open_tab', args: { intent: 'Search for the term', url: 'https://www.bing.com/search?q=x' } },
    ]).invoke([]);
    expect(output.action).toEqual([
      { open_tab: { intent: 'Search for the term', url: 'https://www.bing.com/search?q=x' } },
    ]);
    expect(output.current_state.next_goal).toBe('Search for the term');
  });

  it('still fails when a tool call is not a known action', async () => {
    await expect(navigatorReturning([{ name: 'delete_everything', args: { intent: 'x' } }]).invoke([])).rejects.toThrow(
      /Could not parse navigator response/,
    );
  });

  it('still fails when the action args do not match its schema', async () => {
    await expect(navigatorReturning([{ name: 'open_tab', args: { intent: 'x' } }]).invoke([])).rejects.toThrow(
      /Could not parse navigator response/,
    );
  });
});
