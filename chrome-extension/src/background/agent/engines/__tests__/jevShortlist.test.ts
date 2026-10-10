import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type DOMBaseNode, DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import type { BrowserState } from '@src/background/browser/views';
import { JevDecisionEngine } from '../jev';

function button(index: number) {
  const node = new DOMElementNode({
    tagName: 'button',
    xpath: 'button',
    attributes: {},
    children: [new DOMTextNode(`Button ${index}`, true) as DOMBaseNode],
    isVisible: true,
    isInteractive: true,
    highlightIndex: index,
  });
  node.children.forEach(child => (child.parent = node));
  return node;
}

/** A page of `count` buttons, indexed 1..count */
function pageOf(count: number): BrowserState {
  const buttons = Array.from({ length: count }, (_, i) => button(i + 1));
  const root = new DOMElementNode({
    tagName: 'body',
    xpath: 'body',
    attributes: {},
    children: buttons,
    isVisible: true,
    isInteractive: false,
    highlightIndex: null,
  });
  return {
    elementTree: root,
    selectorMap: new Map(buttons.map((b, i) => [i + 1, b])),
    url: 'https://example.com/feed',
    title: 'Feed',
    tabs: [],
  } as unknown as BrowserState;
}

const CLICK_OPS = ['CLICK', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'ABSTAIN', 'DONE', 'BLOCKED'];

/** An answer whose chosen key is the likeliest; `weights` are normalised so they sum to 1 */
function weighed(weights: Record<string, number>, ids: string[], confidence: number) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(ids.map(id => [id, (weights[id] ?? 0) / total]));
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice, probabilities, confidence };
}

const operation = (confidence = 0.95) => weighed({ CLICK: 1 }, CLICK_OPS, confidence);
const ids = (keys: number[]) => [...keys.map(String), 'none'];
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** Likeliest first; Jev's remaining weight is spread over the 'none' option */
const FORTY = range(40);
const SPREAD: Record<string, number> = {
  '7': 0.3,
  '21': 0.12,
  '3': 0.1,
  '30': 0.08,
  '12': 0.07,
  '35': 0.06,
  '18': 0.05,
  '25': 0.04,
  '2': 0.03,
  '38': 0.02,
  none: 0.13,
};
// page order of the eight likeliest of SPREAD
const SHORTLIST = [3, 7, 12, 18, 21, 25, 30, 35];

describe('Jev shortlist loop', () => {
  const signal = new AbortController().signal;

  function engineFor(replies: Record<string, unknown>[], extra: { minTargetConfidence?: number } = {}) {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ answers: replies.shift() }), { status: 200 }),
    );
    const engine = new JevDecisionEngine({
      apiKey: 'sk-or-test',
      textLLM: {} as BaseChatModel,
      getGoal: () => 'Repost the post',
      fetchImpl,
      ...extra,
    });
    const questions = (call: number) =>
      JSON.parse(fetchImpl.mock.calls[call][1]!.body as string).questions as Record<
        string,
        { criteria: Record<string, unknown> }
      >;
    return { engine, fetchImpl, questions };
  }

  it('asks again over the likeliest eight, in page order, when unsure among many', async () => {
    const { engine, fetchImpl, questions } = engineFor([
      { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
      { click_target: weighed({ '7': 1 }, ids(SHORTLIST), 0.9) },
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [7] Button 7', index: 7 } }]);
    expect(trace).toMatchObject({ target: '[7] Button 7', path: ['likeliest 8 of 40'] });
    expect(trace?.deferred).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // the first question offered all 40 buttons; the second only the shortlist
    expect(Object.keys(questions(0).click_target.criteria)).toHaveLength(41);
    expect(Object.keys(questions(1))).toEqual(['click_target']);
    expect(Object.keys(questions(1).click_target.criteria)).toEqual([...SHORTLIST.map(String), 'none']);
  });

  it('keeps a confident first pick without asking again', async () => {
    const { engine, fetchImpl } = engineFor([
      { operation: operation(), click_target: weighed({ ...SPREAD, '7': 0.9 }, ids(FORTY), 0.9) },
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [7] Button 7', index: 7 } }]);
    expect(trace?.path ?? []).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shrinks the shortlist again when the shortlist round is unsure and has a narrower likely set', async () => {
    const { engine, fetchImpl, questions } = engineFor([
      { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
      // 9 options now (floor 0.6): 0.5 is unsure, and only 4 candidates carry weight
      { click_target: weighed({ '7': 0.4, '21': 0.3, '3': 0.2, '30': 0.1 }, ids(SHORTLIST), 0.5) },
      { click_target: weighed({ '7': 1 }, ids([3, 7, 21, 30]), 0.85) },
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [7] Button 7', index: 7 } }]);
    expect(trace?.path).toEqual(['likeliest 8 of 40', 'likeliest 4 of 8']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Object.keys(questions(2).click_target.criteria)).toEqual(['3', '7', '21', '30', 'none']);
  });

  it('defers instead of looping when the shortlist round puts weight on every candidate', async () => {
    const even = Object.fromEntries(SHORTLIST.map(k => [String(k), 1]));
    const { engine, fetchImpl } = engineFor([
      { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
      { click_target: weighed({ ...even, '7': 2 }, ids(SHORTLIST), 0.4) },
      // never consumed: a third request would hand back undefined answers
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision).toBeNull();
    expect(trace).toMatchObject({ deferred: 'unsure which element', target: '[7] Button 7' });
    expect(trace?.path).toEqual(['likeliest 8 of 40']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('defers when the shortlist round is unsure and weight sits on a single candidate', async () => {
    const { engine, fetchImpl } = engineFor([
      { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
      { click_target: weighed({ '7': 0.97, none: 0.03 }, ids(SHORTLIST), 0.5) },
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision).toBeNull();
    expect(trace?.deferred).toBe('unsure which element');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('always terminates: each round offers fewer candidates, so an endlessly unsure Jev stops', async () => {
    const replies: Record<string, unknown>[] = [
      { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
      { click_target: weighed({ '7': 0.3, '21': 0.25, '3': 0.2, '30': 0.15, '12': 0.1 }, ids(SHORTLIST), 0.3) },
      { click_target: weighed({ '7': 0.4, '21': 0.3, '3': 0.2 }, ids([3, 7, 12, 21, 30]), 0.3) },
      { click_target: weighed({ '7': 0.5, '21': 0.3 }, ids([3, 7, 21]), 0.3) },
      { click_target: weighed({ '7': 0.5, '21': 0.5 }, ids([7, 21]), 0.3) },
    ];
    const { engine, fetchImpl } = engineFor(replies);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision).toBeNull();
    expect(trace?.deferred).toBe('unsure which element');
    expect(trace?.path).toEqual(['likeliest 8 of 40', 'likeliest 5 of 8', 'likeliest 3 of 5', 'likeliest 2 of 3']);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('does not shortlist when unsure which operation, even with an unsure target', async () => {
    const { engine, fetchImpl } = engineFor([
      { operation: operation(0.4), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision).toBeNull();
    expect(trace?.deferred).toBe('unsure which operation');
    expect(trace?.path ?? []).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('defers as "no element fits CLICK" when the shortlist round answers none', async () => {
    const { engine, fetchImpl } = engineFor([
      { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.3) },
      { click_target: weighed({ none: 1 }, ids(SHORTLIST), 0.9) },
    ]);
    const { decision, trace } = await engine.decide(pageOf(40), signal);
    expect(decision).toBeNull();
    expect(trace).toMatchObject({ deferred: 'no element fits CLICK', path: ['likeliest 8 of 40'] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe('adaptive floor', () => {
    // 40 buttons + none = 41 options: the 0.6 floor eases to 0.6 ** (ln 41 / ln 10), about 0.44
    it('takes a 0.45 pick on a big page that a fixed 0.6 would defer', async () => {
      const { engine, fetchImpl } = engineFor([
        { operation: operation(), click_target: weighed({ ...SPREAD, '7': 0.45 }, ids(FORTY), 0.45) },
      ]);
      const { decision, trace } = await engine.decide(pageOf(40), signal);
      expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [7] Button 7', index: 7 } }]);
      expect(trace?.path ?? []).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('still shortlists a pick below the eased floor', async () => {
      const { engine, fetchImpl } = engineFor([
        { operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.42) },
        { click_target: weighed({ '7': 1 }, ids(SHORTLIST), 0.9) },
      ]);
      const { trace } = await engine.decide(pageOf(40), signal);
      expect(trace?.path).toEqual(['likeliest 8 of 40']);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('keeps the full 0.6 on a small page: 0.55 among 5 buttons defers', async () => {
      const spread = { '1': 0.09, '2': 0.55, '3': 0.09, '4': 0.09, '5': 0.09, none: 0.09 };
      const { engine, fetchImpl } = engineFor([
        { operation: operation(), click_target: weighed(spread, ids(range(5)), 0.55) },
      ]);
      const { decision, trace } = await engine.decide(pageOf(5), signal);
      expect(decision).toBeNull();
      expect(trace).toMatchObject({ deferred: 'unsure which element', target: '[2] Button 2' });
      // every candidate carries weight, so there is no narrower set to ask about
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps the full 0.6 at exactly 10 options (9 buttons + none): 0.55 is unsure, 0.6 is not', async () => {
      const spread = (top: number) => ({
        ...Object.fromEntries(range(9).map(k => [String(k), (1 - top) / 9])),
        '4': top,
        none: (1 - top) / 9,
      });
      const unsure = engineFor([
        { operation: operation(), click_target: weighed(spread(0.55), ids(range(9)), 0.55) },
        { click_target: weighed({ '4': 1 }, ids([1, 2, 3, 4, 5, 6, 7, 8]), 0.9) },
      ]);
      const result = await unsure.engine.decide(pageOf(9), signal);
      // the ninth-likeliest button fell off the shortlist of 8
      expect(result.trace?.path).toEqual(['likeliest 8 of 9']);
      expect(unsure.fetchImpl).toHaveBeenCalledTimes(2);

      const sure = engineFor([{ operation: operation(), click_target: weighed(spread(0.6), ids(range(9)), 0.6) }]);
      expect((await sure.engine.decide(pageOf(9), signal)).decision).not.toBeNull();
      expect(sure.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('executes a 0.6 pick on a small page', async () => {
      const spread = { '1': 0.08, '2': 0.6, '3': 0.08, '4': 0.08, '5': 0.08, none: 0.08 };
      const { engine } = engineFor([{ operation: operation(), click_target: weighed(spread, ids(range(5)), 0.6) }]);
      const { decision } = await engine.decide(pageOf(5), signal);
      expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [2] Button 2', index: 2 } }]);
    });
  });

  describe('configured minTargetConfidence', () => {
    // at 41 options the floor is min ** 1.61: 0.8 -> 0.70, 0.3 -> 0.14
    it('eases down from a higher base: 0.65 clears the default floor but not 0.8 eased', async () => {
      const first = { operation: operation(), click_target: weighed({ ...SPREAD, '7': 0.65 }, ids(FORTY), 0.65) };
      const strict = engineFor([first, { click_target: weighed({ '7': 1 }, ids(SHORTLIST), 0.95) }], {
        minTargetConfidence: 0.8,
      });
      const strictResult = await strict.engine.decide(pageOf(40), signal);
      expect(strict.fetchImpl).toHaveBeenCalledTimes(2);
      expect(strictResult.trace?.path).toEqual(['likeliest 8 of 40']);

      const lax = engineFor([first]);
      const laxResult = await lax.engine.decide(pageOf(40), signal);
      expect(lax.fetchImpl).toHaveBeenCalledTimes(1);
      expect(laxResult.trace?.path ?? []).toEqual([]);
    });

    it('takes a 0.72 pick under a 0.8 base on a big page', async () => {
      const { engine, fetchImpl } = engineFor(
        [{ operation: operation(), click_target: weighed({ ...SPREAD, '7': 0.72 }, ids(FORTY), 0.72) }],
        { minTargetConfidence: 0.8 },
      );
      const { decision } = await engine.decide(pageOf(40), signal);
      expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [7] Button 7', index: 7 } }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('takes a 0.2 pick under a 0.3 base that the default floor would shortlist', async () => {
      const { engine, fetchImpl } = engineFor(
        [{ operation: operation(), click_target: weighed(SPREAD, ids(FORTY), 0.2) }],
        { minTargetConfidence: 0.3 },
      );
      const { decision, trace } = await engine.decide(pageOf(40), signal);
      expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [7] Button 7', index: 7 } }]);
      expect(trace?.path ?? []).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('uses the base as-is on a small page', async () => {
      const spread = { '1': 0.06, '2': 0.7, '3': 0.06, '4': 0.06, '5': 0.06, none: 0.06 };
      const { engine } = engineFor([{ operation: operation(), click_target: weighed(spread, ids(range(5)), 0.7) }], {
        minTargetConfidence: 0.8,
      });
      const { decision, trace } = await engine.decide(pageOf(5), signal);
      expect(decision).toBeNull();
      expect(trace?.deferred).toBe('unsure which element');
    });
  });
});
