import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import { ActionBuilder } from '../builder';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));

const field = { tagName: 'input' };
const picture = { tagName: 'img' };

function setup(captchaLLM: BaseChatModel | null) {
  const page = {
    captureCaptchaImage: vi.fn(async () => 'QUJD'),
    inputTextElementNode: vi.fn(async (_useVision: boolean, _node: unknown, text: string) => text),
  };
  const context = {
    emitEvent: vi.fn(),
    options: { useVision: false },
    controller: new AbortController(),
    observedSelectorMap: new Map<number, unknown>([
      [3, field],
      [4, picture],
    ]),
    browserContext: { getCurrentPage: async () => page },
  } as unknown as AgentContext;
  const actions = new ActionBuilder(context, {} as BaseChatModel, captchaLLM).buildDefaultActions();
  const action = actions.find(a => a.name() === 'solve_captcha');
  if (!action) throw new Error('solve_captcha is not registered');
  return { action, page };
}

const modelReplying = (content: string) => ({ invoke: vi.fn(async () => ({ content })) }) as unknown as BaseChatModel;

describe('solve_captcha', () => {
  it('types what the model read into the field', async () => {
    const { action, page } = setup(modelReplying('x7Kp'));
    const result = await action.call({ index: 3 });
    expect(page.captureCaptchaImage).toHaveBeenCalledWith(field, undefined, false);
    expect(page.inputTextElementNode).toHaveBeenCalledWith(false, field, 'x7Kp');
    expect(result.error).toBeNull();
    expect(result.extractedContent).toContain('x7Kp');
  });

  it('reads the image the model pointed at', async () => {
    const { action, page } = setup(modelReplying('x7Kp'));
    await action.call({ index: 3, image_index: 4 });
    expect(page.captureCaptchaImage).toHaveBeenCalledWith(field, picture, false);
  });

  it('asks for a new picture on a retry', async () => {
    const { action, page } = setup(modelReplying('x7Kp'));
    await action.call({ index: 3, refresh: true });
    expect(page.captureCaptchaImage).toHaveBeenCalledWith(field, undefined, true);
  });

  it('types nothing when the model has no code', async () => {
    const { action, page } = setup(modelReplying('UNREADABLE'));
    const result = await action.call({ index: 3 });
    expect(page.inputTextElementNode).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });

  it('tells a model that cannot be called from a captcha that cannot be read', async () => {
    const failing = {
      invoke: vi.fn(async () => {
        throw new Error('404 No endpoints found that support image input');
      }),
    } as unknown as BaseChatModel;
    const { action, page } = setup(failing);
    const result = await action.call({ index: 3 });
    expect(page.inputTextElementNode).not.toHaveBeenCalled();
    expect(result.error).toContain('act_solveCaptcha_modelFailed');
    expect(result.error).toContain('No endpoints found');

    const unreadable = await setup(modelReplying('UNREADABLE')).action.call({ index: 3 });
    expect(unreadable.error).toContain('act_solveCaptcha_failed');
  });

  it('says that a model is missing instead of looking at the page', async () => {
    const { action, page } = setup(null);
    const result = await action.call({ index: 3 });
    expect(page.captureCaptchaImage).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });
});
