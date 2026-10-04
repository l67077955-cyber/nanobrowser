import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type DOMBaseNode, DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import type { BrowserState } from '@src/background/browser/views';
import { ActionResult } from '@src/background/agent/types';
import {
  buildActionSpace,
  buildJevRequest,
  groupCandidates,
  interpretAnswers,
  JevDecisionEngine,
  validateChoice,
} from '../jev';

function el(
  tagName: string,
  attributes: Record<string, string>,
  highlightIndex: number | null,
  children: DOMBaseNode[] = [],
) {
  const node = new DOMElementNode({
    tagName,
    xpath: tagName,
    attributes,
    children,
    isVisible: true,
    isInteractive: highlightIndex !== null,
    highlightIndex,
  });
  node.children.forEach(child => (child.parent = node));
  return node;
}

function text(value: string) {
  return new DOMTextNode(value, true);
}

function signupPage(): BrowserState {
  const email = el('input', { type: 'email', placeholder: 'Email' }, 1);
  const country = el('select', { name: 'country' }, 2, [
    el('option', {}, null, [text('Germany')]),
    el('option', {}, null, [text('France')]),
  ]);
  const submit = el('button', {}, 3, [text('Sign up')]);
  const heading = el('h1', {}, null, [text('Create account')]);
  const root = el('body', {}, null, [heading, email, country, submit]);
  return {
    elementTree: root,
    selectorMap: new Map([
      [1, email],
      [2, country],
      [3, submit],
    ]),
    url: 'https://example.com/signup',
    title: 'Sign up',
    tabs: [],
  } as unknown as BrowserState;
}

const choice = (picked: string, ids: string[], confidence = 0.95) => ({
  type: 'choice',
  choice: picked,
  probabilities: Object.fromEntries(ids.map(id => [id, id === picked ? 1 : 0])),
  confidence,
});

const OPS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'ABSTAIN', 'DONE', 'BLOCKED'];

function engineWith(answers: Record<string, unknown>, llmReply = '{"text": "a@b.com"}') {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ answers }), { status: 200 }));
  const textLLM = { invoke: vi.fn(async () => ({ content: llmReply })) } as unknown as BaseChatModel;
  const engine = new JevDecisionEngine({
    apiKey: 'sk-or-test',
    textLLM,
    getGoal: () => 'Sign up with a@b.com from France',
    fetchImpl,
  });
  return { engine, fetchImpl, textLLM };
}

describe('Jev action space', () => {
  it('maps elements to operations using highlight indices', () => {
    const space = buildActionSpace(signupPage().selectorMap);
    expect(space.elements.map(e => [e.index, e.role, e.label, e.operations])).toEqual([
      ['1', 'textbox', 'Email', ['CLICK', 'TYPE_TEXT']],
      ['2', 'combobox', 'country', ['SELECT']],
      ['3', 'button', 'Sign up', ['CLICK']],
    ]);
    expect(Object.keys(space.targets.SELECT!)).toEqual(['2:1', '2:2']);
    expect(space.targets.SELECT!['2:2'].optionText).toBe('France');
  });

  it('skips unlabeled clickables but keeps unlabeled text fields', () => {
    const wrapper = el('div', {}, 0);
    const field = el('input', { type: 'text' }, 5);
    const space = buildActionSpace(
      new Map([
        [0, wrapper],
        [5, field],
      ]),
    );
    expect(space.elements.map(e => e.index)).toEqual(['5']);
  });

  it('tells identical buttons apart by the post they sit in', () => {
    const more1 = el('button', { 'aria-label': 'More' }, 1);
    const more2 = el('button', { 'aria-label': 'More' }, 2);
    const follow = el('button', {}, 3, [text('Follow')]);
    el('article', {}, null, [text('Ripple defeats SEC #XRP'), more1]);
    el('article', {}, null, [text('My cat photos'), more2, follow]);
    const space = buildActionSpace(
      new Map([
        [1, more1],
        [2, more2],
        [3, follow],
      ]),
    );
    expect(space.elements.map(e => e.label)).toEqual([
      'More (in: Ripple defeats SEC #XRP)',
      'More (in: My cat photos)',
      'Follow',
    ]);
  });

  it('builds one question per operation plus the operation question', () => {
    const state = signupPage();
    const body = buildJevRequest(state, buildActionSpace(state.selectorMap), 'goal', [], 'm');
    expect(Object.keys(body.questions).sort()).toEqual([
      'click_target',
      'operation',
      'select_target',
      'type_text_target',
    ]);
    expect(body.state.page.text).toContain('Create account');
  });
});

describe('Jev response validation', () => {
  it('rejects answers whose choice is not offered', () => {
    expect(() => validateChoice(choice('9', ['9']), ['1', '2'])).toThrow();
  });

  it('rejects probabilities that do not sum to one', () => {
    expect(() =>
      validateChoice({ choice: '1', probabilities: { '1': 0.5, '2': 0.1 }, confidence: 0.9 }, ['1', '2']),
    ).toThrow();
  });

  it('resolves the target of the chosen operation', () => {
    const space = buildActionSpace(signupPage().selectorMap);
    const result = interpretAnswers(
      { operation: choice('SELECT', OPS), select_target: choice('2:2', ['2:1', '2:2', 'none']) },
      space,
    );
    expect(result).toMatchObject({ kind: 'action', operation: 'SELECT', target: { index: 2, optionText: 'France' } });
  });
});

describe('JevDecisionEngine', () => {
  const signal = new AbortController().signal;

  it('turns CLICK into click_element', async () => {
    const { engine, fetchImpl } = engineWith({
      operation: choice('CLICK', OPS),
      click_target: choice('3', ['1', '3', 'none']),
    });
    const { decision } = await engine.decide(signupPage(), signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [3] Sign up', index: 3 } }]);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
  });

  it('asks the text LLM for TYPE_TEXT values', async () => {
    const { engine, textLLM } = engineWith({
      operation: choice('TYPE_TEXT', OPS),
      type_text_target: choice('1', ['1', 'none']),
    });
    const { decision } = await engine.decide(signupPage(), signal);
    expect(decision?.action).toEqual([{ input_text: { intent: 'TYPE_TEXT [1] Email', index: 1, text: 'a@b.com' } }]);
    expect(textLLM.invoke).toHaveBeenCalledOnce();
  });

  it('defers when the text LLM has no value', async () => {
    const { engine } = engineWith(
      { operation: choice('TYPE_TEXT', OPS), type_text_target: choice('1', ['1', 'none']) },
      '{"text": null}',
    );
    expect((await engine.decide(signupPage(), signal)).decision).toBeNull();
  });

  it('defers DONE and low-confidence decisions to the LLM', async () => {
    expect(
      (await engineWith({ operation: choice('DONE', OPS) }).engine.decide(signupPage(), signal)).decision,
    ).toBeNull();
    const lowConfidence = { operation: choice('CLICK', OPS, 0.3), click_target: choice('3', ['1', '3', 'none']) };
    expect((await engineWith(lowConfidence).engine.decide(signupPage(), signal)).decision).toBeNull();
    const lowTarget = { operation: choice('CLICK', OPS), click_target: choice('3', ['1', '3', 'none'], 0.51) };
    expect((await engineWith(lowTarget).engine.decide(signupPage(), signal)).decision).toBeNull();
  });

  it('records why a step was deferred', async () => {
    const done = await engineWith({ operation: choice('DONE', OPS) }).engine.decide(signupPage(), signal);
    expect(done.trace).toMatchObject({ operation: 'DONE', deferred: 'task looks done' });
    const lowTarget = { operation: choice('CLICK', OPS), click_target: choice('3', ['1', '3', 'none'], 0.51) };
    const unsure = await engineWith(lowTarget).engine.decide(signupPage(), signal);
    expect(unsure.trace).toMatchObject({ target: '[3] Sign up', deferred: 'unsure which element' });
  });

  it('ranks target alternatives and reports the top-two margin', async () => {
    const clickTarget = {
      type: 'choice',
      choice: '3',
      probabilities: { '1': 0.3, '3': 0.7, none: 0 },
      confidence: 0.8,
    };
    const { trace } = await engineWith({ operation: choice('CLICK', OPS), click_target: clickTarget }).engine.decide(
      signupPage(),
      signal,
    );
    expect(trace?.alternatives).toEqual([
      { label: '[3] Sign up', p: 0.7 },
      { label: '[1] Email', p: 0.3 },
      { label: 'none', p: 0 },
    ]);
    expect(trace?.margin).toBeCloseTo(0.4);
    expect(trace?.deferred).toBeUndefined();
  });

  it('defers when Jev abstains or picks no target', async () => {
    const abstain = await engineWith({ operation: choice('ABSTAIN', OPS) }).engine.decide(signupPage(), signal);
    expect(abstain).toMatchObject({ decision: null, trace: { operation: 'ABSTAIN', deferred: 'jev abstained' } });
    const noTarget = { operation: choice('CLICK', OPS), click_target: choice('none', ['1', '3', 'none']) };
    const none = await engineWith(noTarget).engine.decide(signupPage(), signal);
    // the operation it wanted and how it weighed the targets stay on record
    expect(none).toMatchObject({
      decision: null,
      trace: {
        operation: 'CLICK',
        confidence: 0.95,
        alternatives: [{ label: 'none', p: 1 }, expect.anything(), expect.anything()],
        deferred: 'no element fits CLICK',
      },
    });
    expect(none.trace?.target).toBeUndefined();
  });

  it('records how the operations were weighed', async () => {
    const operation = {
      type: 'choice',
      choice: 'BLOCKED',
      probabilities: Object.fromEntries(OPS.map(id => [id, id === 'BLOCKED' ? 0.6 : id === 'CLICK' ? 0.3 : 0.1 / 7])),
      confidence: 0.6,
    };
    const { trace } = await engineWith({ operation }).engine.decide(signupPage(), signal);
    expect(trace).toMatchObject({ operation: 'BLOCKED', deferred: 'no way forward' });
    expect(trace?.operations?.slice(0, 2)).toEqual([
      { label: 'BLOCKED', p: 0.6 },
      { label: 'CLICK', p: 0.3 },
    ]);
    expect(trace?.operations).toHaveLength(3);
  });

  it('says so when the page has nothing to act on', async () => {
    const { engine, fetchImpl } = engineWith({});
    const result = await engine.decide({ ...signupPage(), selectorMap: new Map() }, signal);
    expect(result).toMatchObject({ decision: null, trace: { deferred: 'nothing to act on' } });
    expect(result.trace?.noPick).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers a none candidate in every target question', () => {
    const state = signupPage();
    const body = buildJevRequest(state, buildActionSpace(state.selectorMap), 'goal', [], 'm');
    for (const key of ['click_target', 'select_target', 'type_text_target']) {
      expect(Object.keys((body.questions[key] as { criteria: object }).criteria)).toContain('none');
    }
  });

  it('uses the configured confidence thresholds', async () => {
    const answers = { operation: choice('CLICK', OPS), click_target: choice('3', ['1', '3', 'none'], 0.55) };
    const { engine } = engineWith(answers);
    expect((await engine.decide(signupPage(), signal)).decision).toBeNull();
    const lenient = new JevDecisionEngine({
      apiKey: 'sk-or-test',
      textLLM: {} as BaseChatModel,
      getGoal: () => 'goal',
      minTargetConfidence: 0.5,
      fetchImpl: async () => new Response(JSON.stringify({ answers }), { status: 200 }),
    });
    expect((await lenient.decide(signupPage(), signal)).decision).not.toBeNull();
  });

  it('defers after the same decision repeats three times', async () => {
    const { engine } = engineWith({ operation: choice('CLICK', OPS), click_target: choice('3', ['1', '3', 'none']) });
    expect((await engine.decide(signupPage(), signal)).decision).not.toBeNull();
    expect((await engine.decide(signupPage(), signal)).decision).not.toBeNull();
    expect((await engine.decide(signupPage(), signal)).decision).toBeNull();
  });

  it('defers a click the last two steps already made, whoever decided them', async () => {
    const { engine } = engineWith({ operation: choice('CLICK', OPS), click_target: choice('3', ['1', '3', 'none']) });
    const llmClick = [{ click_element: { intent: 'open the menu', index: 3 } }];
    engine.observeStep(llmClick, [new ActionResult()]);
    expect((await engine.decide(signupPage(), signal)).decision).not.toBeNull();
    engine.observeStep(llmClick, [new ActionResult()]);
    expect((await engine.decide(signupPage(), signal)).decision).toBeNull();
  });

  it('throws on HTTP errors so the navigator can fall back', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 401 }));
    const engine = new JevDecisionEngine({
      apiKey: 'ts-key',
      textLLM: {} as BaseChatModel,
      getGoal: () => 'goal',
      fetchImpl,
    });
    await expect(engine.decide(signupPage(), signal)).rejects.toThrow('HTTP 401');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone');
  });
});

describe('Jev target narrowing', () => {
  const signal = new AbortController().signal;
  const GROUPS = ['g1', 'g2', 'g3', 'g4', 'g5', 'none'];
  const CLICK_OPS = OPS.filter(op => op !== 'TYPE_TEXT' && op !== 'SELECT');

  /** 25 buttons; [9] is the only Repost */
  function busyPage(): BrowserState {
    const buttons = Array.from({ length: 25 }, (_, i) =>
      el('button', {}, i + 1, [text(i === 8 ? 'Repost' : `Like ${i + 1}`)]),
    );
    return {
      elementTree: el('body', {}, null, buttons),
      selectorMap: new Map(buttons.map((button, i) => [i + 1, button])),
      url: 'https://example.com/feed',
      title: 'Feed',
      tabs: [],
    } as unknown as BrowserState;
  }

  /** Engine limited to 5 targets per question, answering each request with the next reply */
  function narrowingEngine(...replies: Record<string, unknown>[]) {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ answers: replies.shift() }), { status: 200 }),
    );
    const engine = new JevDecisionEngine({
      apiKey: 'sk-or-test',
      textLLM: {} as BaseChatModel,
      getGoal: () => 'Repost the post',
      maxChoiceOptions: 6,
      fetchImpl,
    });
    const questions = (call: number) =>
      JSON.parse(fetchImpl.mock.calls[call][1]!.body as string).questions as Record<
        string,
        { criteria: Record<string, unknown> }
      >;
    return { engine, fetchImpl, questions };
  }

  it('leaves candidates that fit in one question ungrouped', () => {
    const space = buildActionSpace(busyPage().selectorMap);
    expect(groupCandidates(space.targets.CLICK!, 26)).toBeNull();
  });

  it('splits candidates in page order into as many groups as a question holds', () => {
    const space = buildActionSpace(busyPage().selectorMap);
    const groups = groupCandidates(space.targets.CLICK!, 6)!;
    expect(Object.values(groups).map(g => g.label)).toEqual(['[1-5]', '[6-10]', '[11-15]', '[16-20]', '[21-25]']);
    expect(Object.keys(groups.g2.candidates)).toEqual(['6', '7', '8', '9', '10']);
  });

  it('asks for a group first, then for the element inside it', async () => {
    const { engine, fetchImpl, questions } = narrowingEngine(
      { operation: choice('CLICK', CLICK_OPS), click_target: choice('g2', GROUPS) },
      { click_target: choice('9', ['6', '7', '8', '9', '10', 'none']) },
    );
    const { decision, trace } = await engine.decide(busyPage(), signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [9] Repost', index: 9 } }]);
    expect(trace).toMatchObject({ target: '[9] Repost', path: ['[6-10]'] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(questions(0).click_target.criteria.g2).toEqual({
      range: '[6-10]',
      elements: ['Like 6', 'Like 7', 'Like 8', 'Repost', 'Like 10'],
    });
    expect(Object.keys(questions(1))).toEqual(['click_target']);
    expect(Object.keys(questions(1).click_target.criteria)).toEqual(['6', '7', '8', '9', '10', 'none']);
  });

  it('keeps narrowing while a group is still too large', async () => {
    const { engine, fetchImpl, questions } = narrowingEngine(
      { operation: choice('CLICK', CLICK_OPS), click_target: choice('g2', GROUPS) },
      { click_target: choice('g4', GROUPS) },
      { click_target: choice('43', ['41', '42', '43', '44', '45', 'none']) },
    );
    const state = busyPage();
    // 125 buttons: 5 groups of 25, then 5 groups of 5
    for (let i = 26; i <= 125; i++) state.selectorMap.set(i, el('button', {}, i, [text(`Like ${i}`)]));
    const { decision, trace } = await engine.decide(state, signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [43] Like 43', index: 43 } }]);
    expect(trace?.path).toEqual(['[26-50]', '[41-45]']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Object.keys(questions(1).click_target.criteria)).toEqual(GROUPS);
  });

  it('defers without a second request when unsure of the group', async () => {
    const { engine, fetchImpl } = narrowingEngine({
      operation: choice('CLICK', CLICK_OPS),
      click_target: choice('g2', GROUPS, 0.4),
    });
    const { decision, trace } = await engine.decide(busyPage(), signal);
    expect(decision).toBeNull();
    expect(trace).toMatchObject({
      deferred: 'unsure which element',
      target: '[6-10] Like 6 · Like 7 · Like 8 · Repost · Like 10',
    });
    expect(trace?.path).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('defers when no group or no element in the group matches', async () => {
    const noGroup = narrowingEngine({ operation: choice('CLICK', CLICK_OPS), click_target: choice('none', GROUPS) });
    expect(await noGroup.engine.decide(busyPage(), signal)).toMatchObject({
      decision: null,
      trace: { deferred: 'no element fits CLICK' },
    });
    const noElement = narrowingEngine(
      { operation: choice('CLICK', CLICK_OPS), click_target: choice('g1', GROUPS) },
      { click_target: choice('none', ['1', '2', '3', '4', '5', 'none']) },
    );
    expect(await noElement.engine.decide(busyPage(), signal)).toMatchObject({
      decision: null,
      trace: { deferred: 'no element fits CLICK', path: ['[1-5]'] },
    });
  });
});
