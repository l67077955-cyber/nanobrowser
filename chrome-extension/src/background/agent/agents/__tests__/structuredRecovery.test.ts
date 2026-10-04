import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import type { BasePrompt } from '../../prompts/base';
import { PlannerAgent } from '../planner';

// Simulates LangChain returning parsed=null because the tool call args fail the zod schema
function plannerReturning(args: Record<string, unknown>) {
  const raw = new AIMessage({ content: '', tool_calls: [{ name: 'AgentOutput', args, id: 'call_1' }] });
  const chatLLM = {
    modelName: 'deepseek-flash',
    withStructuredOutput: () => ({ invoke: async () => ({ parsed: null, raw }) }),
  } as unknown as BaseChatModel;
  return new PlannerAgent(
    {
      chatLLM,
      context: { controller: new AbortController() } as unknown as AgentContext,
      prompt: {} as BasePrompt,
    },
    { id: 'planner' },
  );
}

const plan = {
  observation: 'Spam post is visible',
  challenges: 'none',
  done: false,
  next_steps: 'Open the More menu',
  final_answer: '',
  reasoning: 'Posts remain',
  web_task: true,
  schedule: '',
  schedule_task: '',
  follow_ups: '',
};

describe('structured output recovery', () => {
  it('recovers when the model sends null for empty text fields', async () => {
    const output = await plannerReturning({ ...plan, final_answer: null, challenges: null }).invoke([]);
    expect(output).toMatchObject({ next_steps: 'Open the More menu', final_answer: '', challenges: '' });
  });

  it('recovers when the model omits empty text fields', async () => {
    const rest: Record<string, unknown> = { ...plan };
    delete rest.final_answer;
    const output = await plannerReturning(rest).invoke([]);
    expect(output.final_answer).toBe('');
  });

  it('takes a plan that leaves out done as not done', async () => {
    const rest: Record<string, unknown> = { ...plan };
    delete rest.done;
    expect((await plannerReturning(rest).invoke([])).done).toBe(false);
    expect((await plannerReturning({ ...plan, done: null }).invoke([])).done).toBe(false);
  });

  it('reports what the model sent for a field that fails the schema', async () => {
    await expect(plannerReturning({ ...plan, web_task: 3 }).invoke([])).rejects.toThrow(
      /schema: web_task: Invalid input \(got 3\)/,
    );
  });

  it('still fails on wrongly typed values, and reports the schema issue', async () => {
    await expect(plannerReturning({ ...plan, done: 'maybe' }).invoke([])).rejects.toThrow(
      /tool_calls=AgentOutput: .*schema: Invalid boolean string/,
    );
  });
});
