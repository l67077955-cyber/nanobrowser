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
  result: {
    observation: '',
    challenges: '',
    done,
    next_steps: '',
    final_answer,
    reasoning: '',
    web_task: true,
    schedule: '',
    schedule_task: '',
    follow_ups: '',
  },
});

/**
 * An executor whose agents are scripted: the planner answers with `plans` in turn, each after the navigator
 * has taken as many further steps as `stepsDuringPlan` says (0: the navigator waits for the plan).
 */
function scripted(plans: AgentOutput<PlannerOutput>[], stepsDuringPlan: number[], navigatorDoneAt = -1) {
  const executor = new Executor(
    'read the code',
    'task',
    {} as BrowserContext,
    { modelName: 'm' } as unknown as BaseChatModel,
  );
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
    return { id: 'navigator', result: { done: navigated === navigatorDoneAt, success: true, doneText: 'done' } };
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

  it('plans right after the navigator read a page, and finishes with what it read', async () => {
    const run = scripted([plan(false), plan(true, 'from the page text')], [0, 0]);
    const navigate = (run.executor as unknown as { navigator: { execute: () => Promise<AgentOutput<unknown>> } })
      .navigator;
    const step = navigate.execute;
    navigate.execute = async () => {
      const output = await step();
      return run.steps() === 2 ? { ...output, result: { done: false, readPage: true } } : output;
    };
    await run.executor.execute();
    expect(run.pagesPlanned).toEqual([0, 2]);
    expect(run.context.finalAnswer).toBe('from the page text');
    expect(run.steps()).toBe(2);
  });

  it('takes a finish that the navigator and a plan under way agree on without another plan', async () => {
    const run = scripted([plan(false), plan(true, 'both agree')], [0, 1], 4);
    await run.executor.execute();
    expect(run.pagesPlanned).toEqual([0, 3]);
    expect(run.context.finalAnswer).toBe('both agree');
  });
});

describe('Executor calling off out-of-date plans', () => {
  /** records the signal each planner call got, to see which were called off */
  function withSignals(run: ReturnType<typeof scripted>) {
    const internals = run.executor as unknown as {
      planner: { execute: (signal?: AbortSignal) => Promise<AgentOutput<PlannerOutput>> };
    };
    const planOnce = internals.planner.execute;
    const signals: (AbortSignal | undefined)[] = [];
    internals.planner.execute = signal => {
      signals.push(signal);
      return planOnce(signal);
    };
    return signals;
  }

  it('does not wait for a plan under way when the navigator says it is done, but plans on the current page', async () => {
    // the periodic plan from step 3 would take five more steps; the navigator finishes at step 4
    const run = scripted(
      [plan(false), plan(true, 'from an older page'), plan(true, 'from the current page')],
      [0, 5],
      4,
    );
    const signals = withSignals(run);
    await run.executor.execute();
    expect(run.pagesPlanned).toEqual([0, 3, 4]);
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]?.aborted).toBe(false);
    expect(run.context.finalAnswer).toBe('from the current page');
    expect(run.steps()).toBe(4);
  });

  it('calls off a plan under way when the user sends a message, and keeps it out of the history', async () => {
    const run = scripted(
      [plan(false), { id: 'planner', result: { ...plan(false).result!, next_steps: 'STALE PLAN' } }, plan(true, 'ok')],
      [0, 5, 0],
    );
    const signals = withSignals(run);
    const navigate = (run.executor as unknown as { navigator: { execute: () => Promise<unknown> } }).navigator;
    const step = navigate.execute;
    navigate.execute = async () => {
      if (run.steps() === 3) run.executor.steer('only the docs');
      return step();
    };
    await run.executor.execute();
    expect(signals[1]?.aborted).toBe(true);
    expect(run.pagesPlanned).toEqual([0, 3, 4]);
    const history = run.context.messageManager
      .getMessages()
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(history).not.toContain('STALE PLAN');
    expect(run.context.finalAnswer).toBe('ok');
  });
});

describe('Executor steering', () => {
  const history = (context: AgentContext) =>
    context.messageManager
      .getMessages()
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

  it('takes in a message sent during the run and plans again with it', async () => {
    const run = scripted([plan(false), plan(false), plan(true, 'only the docs')], [0, 0, 0], 3);
    const navigate = (run.executor as unknown as { navigator: { execute: () => Promise<unknown> } }).navigator;
    const step = navigate.execute;
    navigate.execute = async () => {
      if (run.steps() === 1) expect(run.executor.steer('only look at the docs folder')).toBe(true);
      return step();
    };
    await run.executor.execute();
    // a plan at the start, one right after the message, and the check of the finish
    expect(run.pagesPlanned).toEqual([0, 2, 3]);
    expect(history(run.context)).toContain(
      'While you were working, the user added: """only look at the docs folder"""',
    );
    expect(run.context.finalAnswer).toBe('only the docs');
  });

  it('does not end on a finish when a message came in while it was being planned', async () => {
    const run = scripted([plan(true, 'too soon'), plan(true, 'with the message')], [0, 0]);
    const internals = run.executor as unknown as { planner: { execute: () => Promise<AgentOutput<PlannerOutput>> } };
    const planOnce = internals.planner.execute;
    let calls = 0;
    internals.planner.execute = () => {
      if (calls++ === 0) run.executor.steer('and add the changelog');
      return planOnce();
    };
    await run.executor.execute();
    expect(run.context.finalAnswer).toBe('with the message');
  });

  it('answers a question the agent is waiting on instead of queueing the message', async () => {
    const run = scripted([plan(false), plan(true, 'done')], [0, 0], 2);
    const navigate = (run.executor as unknown as { navigator: { execute: () => Promise<unknown> } }).navigator;
    const step = navigate.execute;
    let reply: string | null | undefined;
    navigate.execute = async () => {
      if (run.steps() === 0) {
        const asked = run.context.askUser('navigator' as never, 'Which account?');
        expect(run.executor.steer('the work one')).toBe(true);
        reply = await asked;
      }
      return step();
    };
    await run.executor.execute();
    expect(reply).toBe('the work one');
    expect(history(run.context)).not.toContain('While you were working');
  });

  it('turns a message away once the run is over, so it can start a task of its own', async () => {
    const run = scripted([plan(true, 'done')], [0]);
    await run.executor.execute();
    expect(run.executor.steer('one more thing')).toBe(false);
  });
});
