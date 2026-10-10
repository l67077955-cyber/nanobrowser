import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type BrowserContext from '../../browser/context';
import type { AgentContext, AgentOutput } from '../types';
import type { PlannerOutput } from '../agents/planner';
import { Executor } from '../executor';
import { EventType, ExecutionState } from '../event/types';

vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: { storeAgentContext: async () => {} } }));
vi.mock('../../services/analytics', () => ({
  analytics: {
    trackTaskStart: async () => {},
    trackTaskComplete: async () => {},
    trackTaskFailed: async () => {},
    categorizeError: () => 'x',
  },
}));

const plan = (done: boolean, final_answer = ''): AgentOutput<PlannerOutput> => ({
  id: 'planner',
  result: {
    observation: '',
    challenges: '',
    done,
    next_steps: 'try again',
    final_answer,
    reasoning: '',
    web_task: true,
    schedule: '',
    schedule_task: '',
    follow_ups: '',
  },
});

/** The navigator says done at the steps in `doneAt` (1-based), with `success` and `text`; the planner answers by `planDone` */
function run(doneAt: number[], success: boolean, planDone: (call: number) => AgentOutput<PlannerOutput>) {
  const executor = new Executor(
    'read the code',
    'task',
    {} as BrowserContext,
    { modelName: 'm' } as unknown as BaseChatModel,
    { agentOptions: { maxSteps: 8 } } as never,
  );
  const internals = executor as unknown as {
    context: AgentContext;
    planner: { execute: () => Promise<AgentOutput<PlannerOutput>> };
    navigator: { execute: () => Promise<unknown>; addStateMessageToMemory: () => Promise<void> };
  };
  let navigated = 0;
  let planned = 0;
  internals.navigator.addStateMessageToMemory = async () => {};
  internals.navigator.execute = async () => {
    navigated++;
    const done = doneAt.includes(navigated);
    return { id: 'navigator', result: done ? { done, success, doneText: `nav says ${navigated}` } : { done } };
  };
  internals.planner.execute = async () => plan_(planned++);
  const plan_ = planDone;
  const events: { state: string; details: string }[] = [];
  internals.context.eventManager.subscribe(EventType.EXECUTION, async event => {
    events.push({ state: event.state, details: event.data.details });
  });
  return {
    executor,
    events,
    steps: () => navigated,
    plans: () => planned,
    answer: () => internals.context.finalAnswer,
  };
}

describe('navigator done', () => {
  it('ends the run at once when the navigator gives up', async () => {
    const r = run([3], false, () => plan(false));
    await r.executor.execute();
    expect(r.steps()).toBe(3);
    expect(r.answer()).toBe('nav says 3');
    const last = r.events[r.events.length - 1];
    expect(last.state).toBe(ExecutionState.TASK_FAIL);
    expect(last.details).toBe('nav says 3');
    expect(r.events.some(e => e.state === ExecutionState.TASK_OK)).toBe(false);
  });

  it('stops when the planner refuses a claimed success twice in a row', async () => {
    const r = run([2, 4, 6], true, () => plan(false));
    await r.executor.execute();
    expect(r.steps()).toBe(4);
    expect(r.answer()).toBe('nav says 4');
    expect(r.events.some(e => e.state === ExecutionState.TASK_FAIL)).toBe(false);
  });

  it('completes normally when the planner confirms a claimed success', async () => {
    const r = run([2], true, call => plan(call > 0, 'planner answer'));
    await r.executor.execute();
    expect(r.steps()).toBe(2);
    expect(r.answer()).toBe('planner answer');
    const last = r.events[r.events.length - 1];
    expect(last.state).toBe(ExecutionState.TASK_OK);
    expect(last.details).toBe('planner answer');
  });
});
