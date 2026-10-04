import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';

const logged = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }));
vi.mock('@src/background/log', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: (line: string) => logged.info.push(line),
    error: (line: string) => logged.error.push(line),
  }),
}));

import { ModelCallLogger } from '../modelCallLog';

describe('ModelCallLogger', () => {
  beforeEach(() => {
    logged.info.length = 0;
    logged.error.length = 0;
  });

  it('logs who called which model, and that it answered', async () => {
    const llm = new FakeListChatModel({ responses: ['abc'] });
    llm.callbacks = [new ModelCallLogger('fake @ test')];
    await llm.invoke('hi', { tags: ['captcha'] });
    expect(logged.info[0]).toBe('→ captcha · fake @ test');
    expect(logged.info[1]).toMatch(/^✓ captcha · fake @ test · \d+ms$/);
  });

  it('logs a failed call with its HTTP status', async () => {
    const llm = new FakeListChatModel({ responses: ['x'] });
    llm.callbacks = [new ModelCallLogger('fake @ test')];
    vi.spyOn(llm, '_generate').mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    await expect(llm.invoke('hi', { tags: ['planner'] })).rejects.toThrow('rate limited');
    expect(logged.error[0]).toMatch(/^✗ planner · fake @ test · \d+ms · Error · HTTP 429 · rate limited$/);
  });
});
