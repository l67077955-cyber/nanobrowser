import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type DOMBaseNode, DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import type { BrowserState } from '@src/background/browser/views';
import { buildActionSpace, buildJevRequest, interpretAnswers, JevDecisionEngine, validateChoice } from '../jev';

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

const OPS = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'DONE', 'BLOCKED'];

function engineWith(answers: Record<string, unknown>, llmReply = '{"text": "a@b.com"}') {
  const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ answers }), { status: 200 }));
  const textLLM = { invoke: vi.fn(async () => ({ content: llmReply })) } as unknown as BaseChatModel;
  const engine = new JevDecisionEngine({
    apiKey: 'sk-or-test',
    textLLM,
    getGoal: () => 'Sign up with a@b.com from France',
    fetchImpl: fetchImpl as unknown as typeof fetch,
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
      { operation: choice('SELECT', OPS), select_target: choice('2:2', ['2:1', '2:2']) },
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
      click_target: choice('3', ['1', '3']),
    });
    const decision = await engine.decide(signupPage(), signal);
    expect(decision?.action).toEqual([{ click_element: { intent: 'CLICK [3] Sign up', index: 3 } }]);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
  });

  it('asks the text LLM for TYPE_TEXT values', async () => {
    const { engine, textLLM } = engineWith({
      operation: choice('TYPE_TEXT', OPS),
      type_text_target: choice('1', ['1']),
    });
    const decision = await engine.decide(signupPage(), signal);
    expect(decision?.action).toEqual([{ input_text: { intent: 'TYPE_TEXT [1] Email', index: 1, text: 'a@b.com' } }]);
    expect(textLLM.invoke).toHaveBeenCalledOnce();
  });

  it('defers when the text LLM has no value', async () => {
    const { engine } = engineWith(
      { operation: choice('TYPE_TEXT', OPS), type_text_target: choice('1', ['1']) },
      '{"text": null}',
    );
    expect(await engine.decide(signupPage(), signal)).toBeNull();
  });

  it('defers DONE and low-confidence decisions to the LLM', async () => {
    expect(await engineWith({ operation: choice('DONE', OPS) }).engine.decide(signupPage(), signal)).toBeNull();
    const lowConfidence = { operation: choice('CLICK', OPS, 0.3), click_target: choice('3', ['1', '3']) };
    expect(await engineWith(lowConfidence).engine.decide(signupPage(), signal)).toBeNull();
  });

  it('defers after the same decision repeats three times', async () => {
    const { engine } = engineWith({ operation: choice('CLICK', OPS), click_target: choice('3', ['1', '3']) });
    expect(await engine.decide(signupPage(), signal)).not.toBeNull();
    expect(await engine.decide(signupPage(), signal)).not.toBeNull();
    expect(await engine.decide(signupPage(), signal)).toBeNull();
  });

  it('throws on HTTP errors so the navigator can fall back', async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response('nope', { status: 401 }));
    const engine = new JevDecisionEngine({
      apiKey: 'ts-key',
      textLLM: {} as BaseChatModel,
      getGoal: () => 'goal',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(engine.decide(signupPage(), signal)).rejects.toThrow('HTTP 401');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone');
  });
});
