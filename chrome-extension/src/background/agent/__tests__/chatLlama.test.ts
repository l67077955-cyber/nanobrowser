import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatOpenAICompletions } from '@langchain/openai';
import { ChatLlama } from '../helper';

describe('ChatLlama', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts Llama API responses to OpenAI chat completion format', async () => {
    vi.spyOn(ChatOpenAICompletions.prototype, 'completionWithRetry').mockResolvedValue({
      id: 'llama-1',
      completion_message: {
        content: { type: 'text', text: 'hello from llama' },
        stop_reason: 'stop',
      },
      metrics: [
        { metric: 'num_prompt_tokens', value: 3 },
        { metric: 'num_completion_tokens', value: 4 },
        { metric: 'num_total_tokens', value: 7 },
      ],
    } as never);

    const model = new ChatLlama({ model: 'Llama-4-Maverick', apiKey: 'test-key' });
    const result = await model.invoke('hi');

    expect(result.content).toBe('hello from llama');
    expect(result.usage_metadata?.total_tokens).toBe(7);
  });

  it('passes OpenAI-format responses through unchanged', async () => {
    vi.spyOn(ChatOpenAICompletions.prototype, 'completionWithRetry').mockResolvedValue({
      id: 'openai-1',
      object: 'chat.completion',
      created: 0,
      model: 'Llama-4-Maverick',
      choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }],
    } as never);

    const model = new ChatLlama({ model: 'Llama-4-Maverick', apiKey: 'test-key' });
    const result = await model.invoke('hi');

    expect(result.content).toBe('plain');
  });
});
