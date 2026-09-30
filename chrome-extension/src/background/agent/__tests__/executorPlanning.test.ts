import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type BrowserContext from '../../browser/context';
import type { AgentContext, AgentOutput } from '../types';
import type { PlannerOutput } from '../agents/planner';
import { Executor } from '../executor';

vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: { storeAgentContext: async () => {} } }));
vi.mock('../../services/analytics', () => ({
  analytics: { trackTaskStart: async () => {}, trackTaskComplete: async () => {}, trackTaskFailed: async () => {} },
}));

const plan = (done: boolean, final_answer = ''): AgentOutput<PlannerOutput> => ({
  id: 'planner',
  result: { observation: '', challenges: '', done, next_steps: '', final_answer, reasoning: '', web_task: true },
});

/**
 * An executor whose agents are scripted: the planner answers with `plans` in turn, each after the navigator
 * has taken as many further steps as `stepsDuringPlan` says (0: the navigator waits for the plan).
 */
function scripted(plans: AgentOutput<PlannerOutput>[], stepsDuringPlan: number[], navigatorDoneAt = -1) {
  const executor = new Executor('read the code', 'task', {} as BrowserContext, { modelName: 'm' } as unknown as BaseChatModel);
  const internals = executor as unknown as {
    context: AgentContext;
    planner: { execute: () => Promise<AgentOutput<PlannerOutput>> };
    navigator: { execute: () => Promise<unknown>; addStateMessageToMemory: () => Promise<void> };
  };
  const pagesPlanned: number[] = [];
  let navigated = 0;
  const waiting: { atStep: number; release: () => void }[] = [];
  internals.navigator.addStateMessageToMemory = async () => {};
  internals.navigator.execute = async () => {
    navigated++;
    // let a plan that is due settle before the loop looks at it again
    for (const w of waiting.filter(w => w.atStep <= navigated)) w.release();
    await new Promise(resolve => setTimeout(resolve, 0));
    return { id: 'navigator', result: { done: navigated === navigatorDoneAt } };
  };
  internals.planner.execute = () => {
    const call = pagesPlanned.length;
    pagesPlanned.push(navigated);
    const delay = stepsDuringPlan[call] ?? 0;
    if (delay === 0) return Promise.resolve(plans[call]);
    return new Promise(resolve => waiting.push({ atStep: navigated + delay, release: () => resolve(plans[call]) }));
  };
  return { executor, context: internals.context, pagesPlanned, steps: () => navigated };
}

describe('Executor planning', () => {
  it('checks a finish found by a background plan on the page the navigator is on by then', async () => {
    // first plan, then the periodic one at step 3, which settles while the navigator takes step 4
    const run = scripted([plan(false), plan(true, 'from the README'), plan(true, 'from the code')], [0, 1]);
    await run.executor.execute();
    expect(run.pagesPlanned).toEqual([0, 3, 4]);
    expect(run.context.finalAnswer).toBe('from the code');
    expect(run.steps()).toBe(4);
  });

  it('goes on when the check on the current page finds the task unfinished', async () => {
    const run = scripted([plan(false), plan(true, 'too early'), plan(false), plan(true, 'finished')], [0, 1, 0, 0], 5);
    await run.executor.execute();
    expect(run.context.finalAnswer).toBe('finished');
    expect(run.steps()).toBe(5);
  });

  it('takes a finish that the navigator and a plan under way agree on without another plan', async () => {
    const run = scripted([plan(false), plan(true, 'both agree')], [0, 1], 4);
    await run.executor.execute();
    expect(run.pagesPlanned).toEqual([0, 3]);
    expect(run.context.finalAnswer).toBe('both agree');
  });
});
