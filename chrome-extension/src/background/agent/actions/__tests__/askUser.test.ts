import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import { ActionBuilder } from '../builder';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));

const phoneField = { tagName: 'input' };
const captchaField = { tagName: 'input' };

function setup(reply: string | null) {
  const askUser = vi.fn(async () => reply);
  const addUserNote = vi.fn();
  const context = {
    emitEvent: vi.fn(),
    askUser,
    messageManager: { addUserNote },
    observedSelectorMap: new Map<number, unknown>([
      [5, phoneField],
      [9, captchaField],
    ]),
    browserContext: { getCurrentPage: async () => ({ tabId: 42 }) },
  } as unknown as AgentContext;
  const actions = new ActionBuilder(context, {} as BaseChatModel, null).buildDefaultActions();
  const action = actions.find(a => a.name() === 'ask_user');
  if (!action) throw new Error('ask_user is not registered');
  return { action, askUser, addUserNote };
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
    const note = addUserNote.mock.calls[0][0] as string;
    expect(note).toContain('Phone goes into [5], Captcha goes into [9]');
    expect(note).toContain('x7Kp');
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
});
