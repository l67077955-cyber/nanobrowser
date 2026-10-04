import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext } from '../../types';
import { ActionBuilder } from '../builder';

vi.mock('@extension/i18n', () => ({ t: (key: string, args: string[] = []) => [key, ...args].join(' ') }));

function setup(text: string) {
  const page = { getPageText: vi.fn(async () => ({ title: 'Ten heuristics', url: 'https://example.com/a', text })) };
  const context = {
    emitEvent: vi.fn(),
    options: { useVision: false },
    controller: new AbortController(),
    browserContext: { getCurrentPage: async () => page },
  } as unknown as AgentContext;
  const action = new ActionBuilder(context, {} as BaseChatModel, null)
    .buildDefaultActions()
    .find(a => a.name() === 'read_page');
  if (!action) throw new Error('read_page is not registered');
  return action;
}

describe('read_page', () => {
  it('gives the whole text of a short page as untrusted content, kept in memory', async () => {
    const result = await setup('Visibility of system status\nMatch the real world').call({});
    expect(result.includeInMemory).toBe(true);
    expect(result.extractedContent).toContain('Ten heuristics');
    expect(result.extractedContent).toContain('Match the real world');
    expect(result.extractedContent).toContain('nano_untrusted_content');
    expect(result.extractedContent).toContain('end of the page text');
  });

  it('reads a long page in parts, saying where to go on from', async () => {
    const text = 'a'.repeat(15000) + 'b'.repeat(5000);
    const first = await setup(text).call({});
    expect(first.extractedContent).toContain('characters 0-15000 of 20000');
    expect(first.extractedContent).toContain('offset 15000');
    expect(first.extractedContent).not.toContain('b');

    const second = await setup(text).call({ offset: 15000 });
    expect(second.extractedContent).toContain('characters 15000-20000 of 20000');
    expect(second.extractedContent).toContain('bbbbb');
  });

  it('says so when there is nothing left to read', async () => {
    const result = await setup('short').call({ offset: 99 });
    expect(result.extractedContent).toContain('act_readPage_empty');
  });
});
