import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ActionResult } from '../../types';
import { Action } from '../../actions/builder';
import { NavigatorAgent, NavigatorActionRegistry, describePageInput } from '../navigator';
import { DOMElementNode } from '@src/background/browser/dom/views';
import type { BrowserState } from '@src/background/browser/views';
import type { ActionMode } from '@extension/storage';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));

function element(tagName: string, attributes: Record<string, string>): DOMElementNode {
  return new DOMElementNode({ tagName, xpath: null, attributes, children: [], isVisible: true });
}

const button = element('button', { 'aria-label': 'Sign in' });
const field = element('input', { 'aria-label': 'Search' });
const selectorMap = new Map([
  [3, button],
  [4, field],
]);

describe('describePageInput', () => {
  it('names the element and the text the user approves', () => {
    expect(describePageInput('click_element', { index: 3 }, selectorMap)).toBe('act_confirm_desc_click Sign in');
    expect(describePageInput('input_text', { index: 4, text: 'cats' }, selectorMap)).toBe(
      'act_confirm_desc_input cats Search',
    );
    expect(describePageInput('send_keys', { keys: 'Enter' }, selectorMap)).toBe('act_confirm_desc_keys Enter');
  });

  it('falls back to the index for an element it cannot name', () => {
    expect(describePageInput('click_element', { index: 9 }, selectorMap)).toBe(
      'act_confirm_desc_click act_confirm_desc_element 9',
    );
  });
});

function setup(actionMode: ActionMode, approve: boolean) {
  const ran: string[] = [];
  const action = (name: string, hasIndex: boolean) =>
    new Action(
      async () => {
        ran.push(name);
        return new ActionResult({ extractedContent: name, includeInMemory: true });
      },
      { name, description: name, schema: z.object({ index: z.number().optional() }) },
      hasIndex,
    );
  const registry = new NavigatorActionRegistry([action('click_element', true), action('scroll_to_top', false)]);
  const requestConfirmation = vi.fn<(actor: unknown, description: string) => Promise<boolean>>(async () => approve);
  const state = { elementTree: element('body', {}), selectorMap } as unknown as BrowserState;
  const context = {
    options: { actionMode, useVision: false },
    paused: false,
    stopped: false,
    browserContext: { removeHighlight: async () => {}, getState: async () => state },
    requestConfirmation,
    emitEvent: async () => {},
  };
  const agent = new NavigatorAgent(registry, {
    chatLLM: { model: 'test' } as never,
    context: context as never,
    prompt: {} as never,
  });
  const run = (actions: Record<string, unknown>[]): Promise<ActionResult[]> =>
    (agent as unknown as { doMultiAction: (a: unknown, s: BrowserState) => Promise<ActionResult[]> }).doMultiAction(
      actions,
      state,
    );
  return { ran, requestConfirmation, run };
}

describe('action modes', () => {
  it('auto runs page actions without asking', async () => {
    const { ran, requestConfirmation, run } = setup('auto', false);
    await run([{ scroll_to_top: {} }, { click_element: { index: 3 } }]);
    expect(ran).toEqual(['scroll_to_top', 'click_element']);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('read-only reads but never clicks', async () => {
    const { ran, requestConfirmation, run } = setup('readonly', true);
    const results = await run([{ scroll_to_top: {} }, { click_element: { index: 3 } }]);
    expect(ran).toEqual(['scroll_to_top']);
    expect(results[1].error).toContain('act_readonly_blocked click_element');
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('manual asks before a click and runs it once approved', async () => {
    const { ran, requestConfirmation, run } = setup('manual', true);
    await run([{ scroll_to_top: {} }, { click_element: { index: 3 } }]);
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0][1]).toContain('act_confirm_desc_click Sign in');
    expect(ran).toEqual(['scroll_to_top', 'click_element']);
  });

  it('manual skips a declined click and tells the model', async () => {
    const { ran, run } = setup('manual', false);
    const results = await run([{ click_element: { index: 3 } }]);
    expect(ran).toEqual([]);
    expect(results[0].error).toContain('act_confirm_manual_declined');
  });
});
