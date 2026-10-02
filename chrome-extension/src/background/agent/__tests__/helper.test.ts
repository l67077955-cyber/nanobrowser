import { describe, it, expect } from 'vitest';
import type { ChatAnthropic } from '@langchain/anthropic';
import type { ChatOpenAI } from '@langchain/openai';
import { ProviderTypeEnum, type ProviderConfig } from '@extension/storage';
import { createChatModel, isAnthropicAdaptiveThinkingModel } from '../helper';

const anthropic: ProviderConfig = { apiKey: 'sk-test', type: ProviderTypeEnum.Anthropic };
const openai: ProviderConfig = { apiKey: 'sk-test', type: ProviderTypeEnum.OpenAI };
const deepseek: ProviderConfig = { apiKey: 'sk-test', type: ProviderTypeEnum.DeepSeek };

function anthropicRequest(modelName: string) {
  const model = createChatModel(anthropic, {
    provider: ProviderTypeEnum.Anthropic,
    modelName,
    parameters: { temperature: 0.2, topP: 0.1 },
  }) as ChatAnthropic;
  // the tool choice withStructuredOutput sets
  return model.invocationParams({ tool_choice: { type: 'tool', name: 'navigator_output' } } as never);
}

describe('isAnthropicAdaptiveThinkingModel', () => {
  it('matches Claude models that reject sampling parameters', () => {
    for (const name of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5']) {
      expect(isAnthropicAdaptiveThinkingModel(name)).toBe(true);
    }
    expect(isAnthropicAdaptiveThinkingModel('claude-sonnet-5-5')).toBe(true);
    expect(isAnthropicAdaptiveThinkingModel('claude-fable-5-1')).toBe(true);
  });

  it('leaves older Claude models alone', () => {
    for (const name of [
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-1',
    ]) {
      expect(isAnthropicAdaptiveThinkingModel(name)).toBe(false);
    }
  });
});

describe('createChatModel for Anthropic', () => {
  it('sends adaptive thinking, no sampling parameters and no forced tool to the latest models', () => {
    const params = anthropicRequest('claude-opus-5-5') as Record<string, unknown>;
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_k');
    expect(params).not.toHaveProperty('top_p');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.max_tokens).toBe(16384);
  });

  it('keeps temperature and the forced tool for older models', () => {
    const params = anthropicRequest('claude-haiku-4-5') as Record<string, unknown>;
    expect(params.temperature).toBe(0.2);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'navigator_output' });
    expect(params.max_tokens).toBe(4096);
  });
});

describe('createChatModel for OpenAI GPT-6', () => {
  function openaiModel(modelName: string, reasoningEffort: 'minimal' | 'low' | 'medium' | 'high') {
    return createChatModel(openai, {
      provider: ProviderTypeEnum.OpenAI,
      modelName,
      parameters: { temperature: 0.2, topP: 0.1 },
      reasoningEffort,
    }) as ChatOpenAI;
  }

  it('treats GPT-6 as a reasoning model without sampling parameters', () => {
    const model = openaiModel('gpt-6-luna', 'low');
    expect(model.temperature).toBeUndefined();
    expect(model.modelKwargs).toEqual({ max_completion_tokens: 4096, reasoning_effort: 'low' });
  });

  it('maps minimal to the lowest effort each GPT-6 model accepts', () => {
    expect(openaiModel('gpt-6-luna', 'minimal').modelKwargs?.reasoning_effort).toBe('none');
    expect(openaiModel('gpt-6.1-sol', 'minimal').modelKwargs?.reasoning_effort).toBe('low');
    expect(openaiModel('openai/gpt-6-astra', 'minimal').modelKwargs?.reasoning_effort).toBe('low');
  });
});

describe('createChatModel for DeepSeek', () => {
  function deepseekRequest(thinking: boolean) {
    const model = createChatModel(
      deepseek,
      { provider: ProviderTypeEnum.DeepSeek, modelName: 'deepseek-flash', parameters: { temperature: 0.1, topP: 0.1 } },
      { thinking },
    ) as ChatOpenAI;
    // the tool choice withStructuredOutput sets
    return model.invocationParams({ tool_choice: 'planner_output' } as never) as Record<string, unknown>;
  }

  it('thinks and lets the model choose the tool when asked to think', () => {
    const params = deepseekRequest(true);
    expect(params.thinking).toEqual({ type: 'enabled' });
    expect(params.tool_choice).toBe('auto');
  });

  it('keeps thinking off and the forced tool otherwise', () => {
    const params = deepseekRequest(false);
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.tool_choice).toEqual({ type: 'function', function: { name: 'planner_output' } });
  });
});

describe('createChatModel with a thinking level chosen in the settings', () => {
  const openrouter: ProviderConfig = { apiKey: 'sk-test', type: ProviderTypeEnum.OpenRouter };
  const custom: ProviderConfig = { apiKey: 'sk-test', type: ProviderTypeEnum.CustomOpenAI, baseUrl: 'http://x' };

  function request(
    providerConfig: ProviderConfig,
    provider: string,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
    thinking = false,
  ) {
    const model = createChatModel(
      providerConfig,
      { provider, modelName: 'deepseek-flash', parameters: { temperature: 0.1, topP: 0.1 }, reasoningEffort },
      { thinking },
    ) as ChatOpenAI;
    return model.invocationParams({ tool_choice: 'planner_output' } as never) as Record<string, unknown>;
  }

  it('sends OpenRouter one reasoning object and lets a thinking model choose the tool', () => {
    const params = request(openrouter, ProviderTypeEnum.OpenRouter, 'high');
    expect(params.reasoning).toEqual({ effort: 'high' });
    expect(params.tool_choice).toBe('auto');
    expect(params.max_tokens).toBe(16384);
  });

  it('turns OpenRouter reasoning off and keeps the forced tool for Off', () => {
    const params = request(openrouter, ProviderTypeEnum.OpenRouter, 'minimal');
    expect(params.reasoning).toEqual({ effort: 'none' });
    expect(params.tool_choice).toEqual({ type: 'function', function: { name: 'planner_output' } });
  });

  it('sends nothing to OpenRouter when no level is chosen', () => {
    const params = request(openrouter, ProviderTypeEnum.OpenRouter);
    expect(params).not.toHaveProperty('reasoning');
    expect(params.max_tokens).toBe(4096);
  });

  it('sends reasoning_effort to a custom OpenAI-compatible provider', () => {
    expect(request(custom, 'custom_openai_1', 'low').reasoning_effort).toBe('low');
    expect(request(custom, 'custom_openai_1', 'minimal').reasoning_effort).toBe('none');
  });

  it('lets the chosen level decide DeepSeek thinking over the caller default', () => {
    const on = request(deepseek, ProviderTypeEnum.DeepSeek, 'low', false);
    expect(on.thinking).toEqual({ type: 'enabled' });
    expect(on.reasoning_effort).toBe('low');
    const off = request(deepseek, ProviderTypeEnum.DeepSeek, 'minimal', true);
    expect(off.thinking).toEqual({ type: 'disabled' });
  });
});
