import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type BrowserContext from '../../browser/context';
import type { AgentContext, AgentOutput } from '../types';
import { ActionResult } from '../types';
import type { PlannerOutput } from '../agents/planner';
import { Action } from '../actions/builder';
import { NavigatorAgent, NavigatorActionRegistry } from '../agents/navigator';
import { Executor } from '../executor';
import { EventType, ExecutionState } from '../event/types';
import type { BrowserState } from '../../browser/views';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));
vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: { storeAgentContext: async () => {} } }));
vi.mock('../../services/analytics', () => ({
  analytics: {
    trackTaskStart: async () => {},
    trackTaskComplete: async () => {},
    trackTaskFailed: async () => {},
    categorizeError: () => 'x',
  },
}));

/** Seeded PRNG (fast-check is not a dependency) */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const ITERATIONS = 200;
const BASE_SEED = 20261010;
/** mirrors MAX_REJECTED_CLAIMS in executor.ts (not exported) */
const MAX_REJECTED_CLAIMS = 2;

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

type NavStep = 'none' | 'fail' | 'ok';

/** What a run should do, by a model that knows nothing of the executor's code */
function reference(maxSteps: number, nav: NavStep[], accept: boolean[]) {
  let navSteps = 0;
  let planCalls = 0;
  let pendingClaim = false;
  let rejected = 0;
  for (let step = 0; step < maxSteps; step++) {
    if (pendingClaim || step === 0) {
      const accepted = accept[planCalls++];
      if (accepted) return { navSteps, planCalls, end: 'planner' as const, step };
      if (pendingClaim) {
        rejected++;
        if (rejected >= MAX_REJECTED_CLAIMS) return { navSteps, planCalls, end: 'taken' as const, step };
      }
      pendingClaim = false;
    }
    const kind = nav[navSteps++];
    if (kind === 'fail') return { navSteps, planCalls, end: 'failed' as const, step };
    if (kind === 'ok') pendingClaim = true;
  }
  return { navSteps, planCalls, end: 'maxSteps' as const, step: maxSteps };
}

function runScript(maxSteps: number, nav: NavStep[], accept: boolean[]) {
  const executor = new Executor(
    'read the code',
    'task',
    {} as BrowserContext,
    { modelName: 'm' } as unknown as BaseChatModel,
    // no periodic plans: planner calls then happen only at the start and after a done
    { agentOptions: { maxSteps, planningInterval: 100000 } } as never,
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
    const kind = nav[navigated];
    navigated++;
    const text = `nav says ${navigated}`;
    if (kind === 'none' || kind === undefined) return { id: 'navigator', result: { done: false } };
    return { id: 'navigator', result: { done: true, success: kind === 'ok', doneText: text } };
  };
  internals.planner.execute = async () => {
    const call = planned++;
    return accept[call] ? plan(true, `plan says ${call}`) : plan(false);
  };
  const events: { state: string; details: string }[] = [];
  internals.context.eventManager.subscribe(EventType.EXECUTION, async event => {
    events.push({ state: event.state, details: event.data.details });
  });
  return { executor, events, navigated: () => navigated, planned: () => planned, context: internals.context };
}

describe('Executor done handling (random scripts)', () => {
  it(`matches the reference model over ${ITERATIONS} random scripts`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + i;
      const rnd = mulberry32(seed);
      const maxSteps = int(rnd, 1, 12);
      // mostly quiet steps, so that runs are long enough for several claims
      const pNone = rnd();
      const nav: NavStep[] = Array.from({ length: 40 }, () => {
        const r = rnd();
        if (r < pNone) return 'none';
        return rnd() < 0.25 ? 'fail' : 'ok';
      });
      const accept = Array.from({ length: 40 }, () => rnd() < 0.3);
      const where = `seed=${seed} maxSteps=${maxSteps} nav=${nav.slice(0, maxSteps).join(',')} accept=${accept
        .slice(0, maxSteps + 1)
        .map(a => (a ? 1 : 0))
        .join('')}`;

      const want = reference(maxSteps, nav, accept);
      const run = runScript(maxSteps, nav, accept);
      await run.executor.execute();
      const states = run.events.map(e => e.state);
      const last = run.events[run.events.length - 1];
      const ok = states.filter(s => s === ExecutionState.TASK_OK).length;
      const fail = states.filter(s => s === ExecutionState.TASK_FAIL).length;

      expect(run.navigated(), where).toBeLessThanOrEqual(maxSteps);
      expect(run.navigated(), `navigator steps: ${where}`).toBe(want.navSteps);
      expect(run.planned(), `planner calls: ${where}`).toBe(want.planCalls);
      expect(ok + fail, `exactly one verdict: ${where}`).toBe(1);

      switch (want.end) {
        case 'failed':
          expect(last.state, where).toBe(ExecutionState.TASK_FAIL);
          expect(last.details, where).toBe(`nav says ${want.navSteps}`);
          expect(run.context.finalAnswer, where).toBe(`nav says ${want.navSteps}`);
          break;
        case 'planner':
          expect(last.state, where).toBe(ExecutionState.TASK_OK);
          expect(last.details, where).toBe(`plan says ${want.planCalls - 1}`);
          break;
        case 'taken':
          expect(last.state, where).toBe(ExecutionState.TASK_OK);
          expect(last.details, where).toBe(`nav says ${want.navSteps}`);
          expect(run.context.finalAnswer, where).toBe(`nav says ${want.navSteps}`);
          break;
        case 'maxSteps':
          expect(last.state, where).toBe(ExecutionState.TASK_FAIL);
          expect(run.context.nSteps, where).toBe(maxSteps);
          break;
      }
    }
  });

  it('a run with no done at all ends by max steps', async () => {
    for (let i = 0; i < 50; i++) {
      const seed = BASE_SEED + 1000 + i;
      const rnd = mulberry32(seed);
      const maxSteps = int(rnd, 1, 15);
      // the first plan may not accept either, or the run would end before the navigator moves
      const run = runScript(maxSteps, [], Array.from({ length: 40 }, () => false));
      await run.executor.execute();
      const states = run.events.map(e => e.state);
      expect(run.navigated(), `seed=${seed}`).toBe(maxSteps);
      expect(states[states.length - 1], `seed=${seed}`).toBe(ExecutionState.TASK_FAIL);
      expect(states.includes(ExecutionState.TASK_OK), `seed=${seed}`).toBe(false);
    }
  });
});

describe('doMultiAction with a done at a random position (random batches)', () => {
  function setup() {
    const ran: string[] = [];
    const action = (name: string, isDone: boolean) =>
      new Action(
        async () => {
          ran.push(name);
          return new ActionResult({
            extractedContent: name,
            includeInMemory: true,
            isDone,
          });
        },
        { name, description: name, schema: z.object({ index: z.number().optional() }) },
        false,
      );
    const registry = new NavigatorActionRegistry([action('note', false), action('done', true)]);
    const state = { elementTree: {}, selectorMap: new Map() } as unknown as BrowserState;
    const context = {
      options: { actionMode: 'auto', useVision: false },
      paused: false,
      stopped: false,
      browserContext: { removeHighlight: async () => {}, getState: async () => state },
      emitEvent: async () => {},
    };
    const agent = new NavigatorAgent(registry, {
      chatLLM: { model: 'test' } as never,
      context: context as never,
      prompt: {} as never,
    });
    const run = (actions: Record<string, unknown>[]) =>
      (agent as unknown as { doMultiAction: (a: unknown, s: BrowserState) => Promise<ActionResult[]> }).doMultiAction(
        actions,
        state,
      );
    return { ran, run };
  }

  it(`runs nothing after the first done (${ITERATIONS} random batches)`, async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const seed = BASE_SEED + 5000 + i;
        const rnd = mulberry32(seed);
        const s = setup();
        const n = int(rnd, 1, 8);
        // each slot is a note or a done; each done gets its own name so the executed one can be told
        const kinds = Array.from({ length: n }, () => (rnd() < 0.3 ? 'done' : 'note'));
        const actions = kinds.map((k, idx) => {
          if (k === 'note') return { note: {} };
          return { done: { idx } };
        });
        const firstDone = kinds.indexOf('done');
        const where = `seed=${seed} kinds=${kinds.join(',')}`;
        let settled = false;
        const p = s.run(actions).finally(() => (settled = true));
        for (let k = 0; k < 50 && !settled; k++) await vi.advanceTimersByTimeAsync(1000);
        const results = await p;
        if (firstDone === -1) {
          expect(s.ran.length, where).toBe(n);
          expect(results.some(r => r.isDone), where).toBe(false);
        } else {
          expect(s.ran.length, `nothing after done: ${where}`).toBe(firstDone + 1);
          expect(results.length, where).toBe(firstDone + 1);
          expect(results[results.length - 1].isDone, where).toBe(true);
          expect(results.filter(r => r.isDone).length, where).toBe(1);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
