import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import { ActionBuilder, askedValue } from '../builder';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));

const phoneField = { tagName: 'input' };
const captchaField = { tagName: 'input' };

function setup(reply: string | null) {
  const askUser = vi.fn(async () => reply);
  const addUserNote = vi.fn();
  const page = {
    tabId: 42,
    inputTextElementNode: vi.fn(async (_useVision: boolean, _node: unknown, text: string) => text),
  };
  const context = {
    emitEvent: vi.fn(),
    askUser,
    messageManager: { addUserNote },
    observedSelectorMap: new Map<number, unknown>([
      [5, phoneField],
      [9, captchaField],
    ]),
    options: { useVision: false },
    browserContext: { getCurrentPage: async () => page },
  } as unknown as AgentContext;
  const actions = new ActionBuilder(context, {} as BaseChatModel, null).buildDefaultActions();
  const action = actions.find(a => a.name() === 'ask_user');
  if (!action) throw new Error('ask_user is not registered');
  return { action, askUser, addUserNote, page };
}

describe('ask_user', () => {
  it('asks for the values in one form, with the fields they go into', async () => {
    const { action, askUser, addUserNote } = setup('Phone: 13800000000\nCaptcha: x7Kp');
    await action.call({
      question: 'Your phone and the captcha?',
      fields: [
        { label: 'Phone', kind: 'phone', index: 5 },
        { label: 'Captcha', kind: 'captcha', index: 9 },
      ],
    });
    expect(askUser).toHaveBeenCalledWith(
      expect.anything(),
      'Your phone and the captcha?',
      {
        kind: 'question',
        fields: [
          { label: 'Phone', kind: 'phone' },
          { label: 'Captcha', kind: 'captcha' },
        ],
      },
      { tabId: 42, nodes: [phoneField, captchaField] },
    );
    expect(addUserNote.mock.calls[0][0]).toContain('x7Kp');
  });

  it("types the user's values into their fields itself", async () => {
    const { action, page } = setup('Phone: 13800000000\nCaptcha: x7Kp');
    const result = await action.call({
      question: 'Your phone and the captcha?',
      fields: [
        { label: 'Phone', kind: 'phone', index: 5 },
        { label: 'Captcha', kind: 'captcha', index: 9 },
      ],
    });
    expect(page.inputTextElementNode).toHaveBeenCalledWith(false, phoneField, '13800000000');
    expect(page.inputTextElementNode).toHaveBeenCalledWith(false, captchaField, 'x7Kp');
    expect(result.extractedContent).toContain('typed in already');
  });

  it('leaves a reply that is no code to the model', async () => {
    const { action, page, addUserNote } = setup('SMS code: 没收到');
    const result = await action.call({
      question: 'The SMS code?',
      fields: [{ label: 'SMS code', kind: 'code', index: 9 }],
    });
    expect(page.inputTextElementNode).not.toHaveBeenCalled();
    expect(addUserNote.mock.calls[0][0]).toContain('SMS code goes into [9]');
    expect(result.extractedContent).not.toContain('typed in already');
  });

  it('asks for no more than three values', async () => {
    const { action, askUser } = setup('ok');
    await action.call({
      question: 'Details?',
      fields: ['A', 'B', 'C', 'D'].map(label => ({ label, kind: 'text' })),
    });
    const meta = (askUser.mock.calls[0] as unknown[])[2] as { fields: unknown[] };
    expect(meta.fields).toHaveLength(3);
  });

  it('marks something to do on the page', async () => {
    const { action, askUser } = setup('Done.');
    await action.call({ question: 'Please sign in', on_page: true });
    expect((askUser.mock.calls[0] as unknown[])[2]).toEqual({ kind: 'question', onPage: true });
  });

  it('goes on without a reply', async () => {
    const { action, addUserNote } = setup(null);
    const result = await action.call({ question: 'Which size?' });
    expect(addUserNote).not.toHaveBeenCalled();
    expect(result.extractedContent).toContain('No reply came');
  });

  it('reads a value from a reply line by its label', () => {
    expect(askedValue('Phone: 138\nCode：1234', 'Code')).toBe('1234');
    expect(askedValue('Phone: (left empty)', 'Phone')).toBeNull();
    expect(askedValue('just a sentence', 'Phone')).toBeNull();
  });
});
