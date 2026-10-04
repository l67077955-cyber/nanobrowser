import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { captchaAnswer, captchaReading, CaptchaUnreadableError, readCaptcha } from '../captcha';

function modelReplying(content: unknown) {
  const invoke = vi.fn(async () => ({ content }));
  return { llm: { invoke } as unknown as BaseChatModel, invoke };
}

describe('captchaAnswer', () => {
  it('takes the code out of what a model wraps around it', () => {
    expect(captchaAnswer('x7Kp')).toBe('x7Kp');
    expect(captchaAnswer(' "x7Kp"\n')).toBe('x7Kp');
    expect(captchaAnswer('`X 7 K p`')).toBe('X7Kp');
    expect(captchaAnswer('<think>four characters, the third is K</think>x7Kp')).toBe('x7Kp');
    expect(captchaAnswer('8.')).toBe('8');
    expect(captchaAnswer('-3')).toBe('-3');
    expect(captchaAnswer('移动招聘')).toBe('移动招聘');
  });

  it('has no code for a reply that is not one', () => {
    expect(captchaAnswer('')).toBeNull();
    expect(captchaAnswer('UNREADABLE')).toBeNull();
    expect(captchaAnswer('Unreadable.')).toBeNull();
    expect(captchaAnswer("I'm sorry, but I can't help with reading captchas.")).toBeNull();
  });
});

describe('captchaReading', () => {
  it('takes the answer, the rule and the characters out of the JSON reply', () => {
    const reply =
      '```json\n{"rule": "请输入红色的字符", "characters": "T red, 4 red, V red, S red, y black", "answer": "T4VS"}\n```';
    expect(captchaReading(reply)).toEqual({
      rule: '请输入红色的字符',
      characters: 'T red, 4 red, V red, S red, y black',
      answer: 'T4VS',
    });
  });

  it('reads a bare code from a model that ignores the format', () => {
    expect(captchaReading('x7Kp').answer).toBe('x7Kp');
  });

  it('has no answer when the model says the picture is unreadable', () => {
    expect(captchaReading('{"answer": "UNREADABLE"}').answer).toBeNull();
  });
});

describe('readCaptcha', () => {
  it('sends the image to the model and returns the code', async () => {
    const { llm, invoke } = modelReplying('x7Kp\n');
    expect(await readCaptcha(llm, 'QUJD', new AbortController().signal)).toBe('x7Kp');
    const [[message]] = invoke.mock.calls[0] as unknown as [
      [{ content: { type: string; image_url?: { url: string } }[] }],
    ];
    expect(message.content.find(part => part.type === 'image_url')?.image_url?.url).toBe('data:image/png;base64,QUJD');
  });

  it('reads a reply given as content parts', async () => {
    const { llm } = modelReplying([{ type: 'text', text: '12' }]);
    expect(await readCaptcha(llm, 'QUJD', new AbortController().signal)).toBe('12');
  });

  it('fails when the model does not answer with a code', async () => {
    const { llm } = modelReplying('I cannot view images, please describe it to me.');
    await expect(readCaptcha(llm, 'QUJD', new AbortController().signal)).rejects.toBeInstanceOf(CaptchaUnreadableError);
  });

  it('sends back a reading longer than the field takes, with the page hints', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ content: 'T4VSy' }).mockResolvedValueOnce({ content: 'T4VS' });
    const llm = { invoke } as unknown as BaseChatModel;
    const code = await readCaptcha(llm, 'QUJD', new AbortController().signal, {
      maxLength: 4,
      textAround: '请输入红色的字符',
    });
    expect(code).toBe('T4VS');
    const firstPrompt = JSON.stringify(invoke.mock.calls[0][0]);
    expect(firstPrompt).toContain('at most 4 characters');
    expect(firstPrompt).toContain('请输入红色的字符');
    expect(JSON.stringify(invoke.mock.calls[1][0])).toContain('takes only 4');
  });

  it('falls back to the first reading cut to fit when the second is still too long', async () => {
    const llm = { invoke: vi.fn(async () => ({ content: 'T4VSy' })) } as unknown as BaseChatModel;
    expect(await readCaptcha(llm, 'QUJD', new AbortController().signal, { maxLength: 4 })).toBe('T4VS');
  });

  it('falls back to the first reading cut to fit when the second look fails', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ content: '{"answer": "MTEBX"}' })
      .mockRejectedValueOnce(new Error('timed out'));
    const llm = { invoke } as unknown as BaseChatModel;
    expect(await readCaptcha(llm, 'QUJD', new AbortController().signal, { maxLength: 4 })).toBe('MTEB');
  });
});
