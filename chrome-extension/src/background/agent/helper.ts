import { type ProviderConfig, type ModelConfig, ProviderTypeEnum } from '@extension/storage';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatXAI } from '@langchain/xai';
import { ChatGroq } from '@langchain/groq';
import { ChatCerebras } from '@langchain/cerebras';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama } from '@langchain/ollama';
import { ChatDeepSeek } from '@langchain/deepseek';

const maxTokens = 1024 * 4;
// thinking shares the output budget with the answer
const adaptiveThinkingMaxTokens = 1024 * 16;

// Custom ChatLlama class to handle Llama API response format
class ChatLlama extends ChatOpenAI {
  constructor(args: any) {
    super(args);
  }

  // Override the completionWithRetry method to intercept and transform the response
  async completionWithRetry(request: any, options?: any): Promise<any> {
    try {
      // Make the request using the parent's implementation
      const response = await super.completionWithRetry(request, options);

      // Check if this is a Llama API response format
      if (response?.completion_message?.content?.text) {
        // Transform Llama API response to OpenAI format
        const transformedResponse = {
          id: response.id || 'llama-response',
          object: 'chat.completion',
          created: Date.now(),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: response.completion_message.content.text,
              },
              finish_reason: response.completion_message.stop_reason || 'stop',
            },
          ],
          usage: {
            prompt_tokens: response.metrics?.find((m: any) => m.metric === 'num_prompt_tokens')?.value || 0,
            completion_tokens: response.metrics?.find((m: any) => m.metric === 'num_completion_tokens')?.value || 0,
            total_tokens: response.metrics?.find((m: any) => m.metric === 'num_total_tokens')?.value || 0,
          },
        };

        return transformedResponse;
      }

      return response;
    } catch (error: any) {
      console.error(`[ChatLlama] Error during API call:`, error);
      throw error;
    }
  }
}

/**
 * LangChain 0.3 always sends sampling parameters and forces the tool for structured output, and only knows
 * budget thinking. Claude models from Opus 4.7 on reject sampling parameters; the latest ones also reject
 * forced tool use and budget thinking. Sends adaptive thinking and lets the model choose the tool instead.
 */
class ChatAnthropicAdaptiveThinking extends ChatAnthropic {
  invocationParams(options?: this['ParsedCallOptions']): ReturnType<ChatAnthropic['invocationParams']> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { temperature, top_k, top_p, thinking, ...params } = super.invocationParams(options);
    const forcesTool = params.tool_choice?.type === 'any' || params.tool_choice?.type === 'tool';
    return {
      ...params,
      ...(forcesTool ? { tool_choice: { type: 'auto' } } : {}),
      thinking: { type: 'adaptive' },
    } as unknown as ReturnType<ChatAnthropic['invocationParams']>;
  }
}

/**
 * DeepSeek models think unless told not to, but reject thinking together with the forced tool LangChain
 * sets for structured output. Turns thinking on and lets the model choose the tool instead.
 */
class ChatDeepSeekThinking extends ChatDeepSeek {
  invocationParams(
    ...args: Parameters<ChatDeepSeek['invocationParams']>
  ): ReturnType<ChatDeepSeek['invocationParams']> {
    const params = super.invocationParams(...args);
    const forcesTool = typeof params.tool_choice === 'object' || params.tool_choice === 'required';
    return {
      ...params,
      ...(forcesTool ? { tool_choice: 'auto' } : {}),
      thinking: { type: 'enabled' },
    } as unknown as ReturnType<ChatDeepSeek['invocationParams']>;
  }
}

/**
 * Lets the model choose the tool LangChain forces for structured output: OpenAI-compatible APIs reject a
 * forced tool from a thinking model (DeepSeek through OpenRouter, Qwen, ...).
 */
class ChatOpenAIThinking extends ChatOpenAI {
  invocationParams(...args: Parameters<ChatOpenAI['invocationParams']>): ReturnType<ChatOpenAI['invocationParams']> {
    const params = super.invocationParams(...args);
    const forcesTool = typeof params.tool_choice === 'object' || params.tool_choice === 'required';
    return forcesTool ? { ...params, tool_choice: 'auto' } : params;
  }
}

/** Extra choices for the model a caller gets */
export interface ChatModelOptions {
  /**
   * Turn thinking on where the provider makes it optional. For the calls that judge (planner, memory);
   * the navigator acts on every step and stays fast without it.
   */
  thinking?: boolean;
}

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** The thinking level chosen in the model settings; none chosen leaves it to the provider and the caller */
function chosenThinkingLevel(modelConfig: ModelConfig): ThinkingLevel | undefined {
  if (!modelConfig.reasoningEffort) return undefined;
  return modelConfig.reasoningEffort === 'minimal' ? 'off' : modelConfig.reasoningEffort;
}

/** OpenRouter takes one reasoning object for every model; other OpenAI-compatible APIs take reasoning_effort */
function compatibleThinkingKwargs(providerConfig: ProviderConfig, level: ThinkingLevel): Record<string, unknown> {
  const effort = level === 'off' ? 'none' : level;
  return providerConfig.type === ProviderTypeEnum.OpenRouter ? { reasoning: { effort } } : { reasoning_effort: effort };
}

// O series, GPT-5 or GPT-6 models that support reasoning
function isOpenAIReasoningModel(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('openai/')) {
    modelNameWithoutProvider = modelName.substring(7);
  }
  return (
    modelNameWithoutProvider.startsWith('o') ||
    (modelNameWithoutProvider.startsWith('gpt-5') && !modelNameWithoutProvider.startsWith('gpt-5-chat')) ||
    modelNameWithoutProvider.startsWith('gpt-6')
  );
}

// GPT-6 models reject minimal: Luna takes none instead, Sol and Astra (no none either) take low
function toGpt6ReasoningEffort(
  modelName: string,
  effort: NonNullable<ModelConfig['reasoningEffort']>,
): 'none' | 'low' | 'medium' | 'high' {
  if (modelName.includes('luna')) {
    return effort === 'minimal' ? 'none' : effort;
  }
  return effort === 'minimal' ? 'low' : effort;
}

/**
 * Claude models from Opus 4.7 on reject sampling parameters (temperature, top_p, top_k),
 * and from the 5 generation on think by default, which rules out forced tool use.
 */
export function isAnthropicAdaptiveThinkingModel(modelName: string): boolean {
  const modelNameWithoutProvider = modelName.startsWith('anthropic/') ? modelName.substring(10) : modelName;
  return /^claude-(opus-4-[78]|(opus|sonnet)-5|fable|mythos)/.test(modelNameWithoutProvider);
}

// Function to check if a model is an Anthropic Opus model
function isAnthropicOpusModel(modelName: string): boolean {
  // Extract the model name without provider prefix if present
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('anthropic/')) {
    modelNameWithoutProvider = modelName.substring(10);
  }
  return modelNameWithoutProvider.startsWith('claude-opus');
}

// check if a model is sonnet-4-5 or haiku-4-5
function isAnthropic4_5Model(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('anthropic/')) {
    modelNameWithoutProvider = modelName.substring(10);
  }
  return (
    modelNameWithoutProvider.startsWith('claude-sonnet-4-5') || modelNameWithoutProvider.startsWith('claude-haiku-4-5')
  );
}

function createOpenAIChatModel(
  providerConfig: ProviderConfig,
  modelConfig: ModelConfig,
  // Add optional extra fetch options for headers etc.
  extraFetchOptions: { headers?: Record<string, string> } | undefined,
): BaseChatModel {
  const args: {
    model: string;
    apiKey?: string;
    // Configuration should align with ClientOptions from @langchain/openai
    configuration?: Record<string, unknown>;
    modelKwargs?: {
      max_completion_tokens: number;
      reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    };
    topP?: number;
    temperature?: number;
    maxTokens?: number;
  } = {
    model: modelConfig.modelName,
    apiKey: providerConfig.apiKey,
  };

  const configuration: Record<string, unknown> = {};
  if (providerConfig.baseUrl) {
    configuration.baseURL = providerConfig.baseUrl;
  }
  if (extraFetchOptions?.headers) {
    configuration.defaultHeaders = extraFetchOptions.headers;
  }
  args.configuration = configuration;

  // custom provider may have no api key
  if (providerConfig.apiKey) {
    args.apiKey = providerConfig.apiKey;
  }

  // O series models have different parameters
  if (isOpenAIReasoningModel(modelConfig.modelName)) {
    args.modelKwargs = {
      max_completion_tokens: maxTokens,
    };

    // Add reasoning_effort parameter for o-series models if specified
    if (modelConfig.reasoningEffort) {
      // if it's gpt-5.1, we need to convert minimal to none, it doesn't support minimal
      if (modelConfig.modelName.includes('gpt-5.1') && modelConfig.reasoningEffort === 'minimal') {
        args.modelKwargs.reasoning_effort = 'none';
      } else if (modelConfig.modelName.includes('gpt-6')) {
        args.modelKwargs.reasoning_effort = toGpt6ReasoningEffort(modelConfig.modelName, modelConfig.reasoningEffort);
      } else {
        args.modelKwargs.reasoning_effort = modelConfig.reasoningEffort;
      }
    }
  } else {
    args.topP = (modelConfig.parameters?.topP ?? 0.1) as number;
    args.temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
    args.maxTokens = maxTokens;
    // OpenAI's own chat models take no thinking level; OpenRouter and custom providers serve models that do
    const level = chosenThinkingLevel(modelConfig);
    if (level && providerConfig.type !== ProviderTypeEnum.OpenAI) {
      (args as Record<string, unknown>).modelKwargs = compatibleThinkingKwargs(providerConfig, level);
      if (level !== 'off') {
        args.maxTokens = adaptiveThinkingMaxTokens;
        return new ChatOpenAIThinking(args);
      }
    }
  }
  return new ChatOpenAI(args);
}

// Function to extract instance name from Azure endpoint URL
function extractInstanceNameFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const hostnameParts = parsedUrl.hostname.split('.');
    // Expecting format like instance-name.openai.azure.com
    if (hostnameParts.length >= 4 && hostnameParts[1] === 'openai' && hostnameParts[2] === 'azure') {
      return hostnameParts[0];
    }
  } catch (e) {
    console.error('Error parsing Azure endpoint URL:', e);
  }
  return null;
}

// Function to check if a provider ID is an Azure provider
function isAzureProvider(providerId: string): boolean {
  return providerId === ProviderTypeEnum.AzureOpenAI || providerId.startsWith(`${ProviderTypeEnum.AzureOpenAI}_`);
}

// Function to create an Azure OpenAI chat model
function createAzureChatModel(providerConfig: ProviderConfig, modelConfig: ModelConfig): BaseChatModel {
  const temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
  const topP = (modelConfig.parameters?.topP ?? 0.1) as number;

  // Validate necessary fields first
  if (
    !providerConfig.baseUrl ||
    !providerConfig.azureDeploymentNames ||
    providerConfig.azureDeploymentNames.length === 0 ||
    !providerConfig.azureApiVersion ||
    !providerConfig.apiKey
  ) {
    throw new Error(
      'Azure configuration is incomplete. Endpoint, Deployment Name, API Version, and API Key are required. Please check settings.',
    );
  }

  // Instead of always using the first deployment name, use the model name from modelConfig
  // which contains the actual model selected in the UI
  const deploymentName = modelConfig.modelName;

  // Validate that the selected model exists in the configured deployments
  if (!providerConfig.azureDeploymentNames.includes(deploymentName)) {
    console.warn(
      `[createChatModel] Selected deployment "${deploymentName}" not found in available deployments. ` +
        `Available: ${JSON.stringify(providerConfig.azureDeploymentNames)}. Using the model anyway.`,
    );
  }

  // Extract instance name from the endpoint URL
  const instanceName = extractInstanceNameFromUrl(providerConfig.baseUrl);
  if (!instanceName) {
    throw new Error(
      `Could not extract Instance Name from Azure Endpoint URL: ${providerConfig.baseUrl}. Expected format like https://<your-instance-name>.openai.azure.com/`,
    );
  }

  // Check if the Azure deployment is using an "o" series model (GPT-4o, etc.)
  const isOSeriesModel = isOpenAIReasoningModel(deploymentName);

  // Use AzureChatOpenAI with specific parameters
  const args = {
    azureOpenAIApiInstanceName: instanceName, // Derived from endpoint
    azureOpenAIApiDeploymentName: deploymentName,
    azureOpenAIApiKey: providerConfig.apiKey,
    azureOpenAIApiVersion: providerConfig.azureApiVersion,
    // For Azure, the model name should be the deployment name itself
    model: deploymentName, // Set model = deployment name to fix Azure requests
    // For O series models, use modelKwargs instead of temperature/topP
    ...(isOSeriesModel
      ? {
          modelKwargs: {
            max_completion_tokens: maxTokens,
            // Add reasoning_effort parameter for Azure o-series models if specified
            ...(modelConfig.reasoningEffort ? { reasoning_effort: modelConfig.reasoningEffort } : {}),
          },
        }
      : {
          temperature,
          topP,
          maxTokens,
        }),
    // DO NOT pass baseUrl or configuration here
  };
  // console.log('[createChatModel] Azure args passed to AzureChatOpenAI:', args);
  return new AzureChatOpenAI(args);
}

// create a chat model based on the agent name, the model name and provider
export function createChatModel(
  providerConfig: ProviderConfig,
  modelConfig: ModelConfig,
  options: ChatModelOptions = {},
): BaseChatModel {
  const temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
  const topP = (modelConfig.parameters?.topP ?? 0.1) as number;

  // Check if the provider is an Azure provider with a custom ID (e.g. azure_openai_2)
  const isAzure = isAzureProvider(modelConfig.provider);

  // If this is any type of Azure provider, handle it with the dedicated function
  if (isAzure) {
    return createAzureChatModel(providerConfig, modelConfig);
  }

  switch (modelConfig.provider) {
    case ProviderTypeEnum.OpenAI: {
      // Call helper without extra options
      return createOpenAIChatModel(providerConfig, modelConfig, undefined);
    }
    case ProviderTypeEnum.Anthropic: {
      if (isAnthropicAdaptiveThinkingModel(modelConfig.modelName)) {
        return new ChatAnthropicAdaptiveThinking({
          model: modelConfig.modelName,
          apiKey: providerConfig.apiKey,
          maxTokens: adaptiveThinkingMaxTokens,
          clientOptions: {},
        });
      }
      // For Opus models, only support temperature, not topP
      // For 4.5 models, only support either temperature or topP, not both, so we only use temperature to align with Opus
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        maxTokens,
        temperature,
        clientOptions: {},
      };
      return new ChatAnthropic(args);
    }
    case ProviderTypeEnum.DeepSeek: {
      const level = chosenThinkingLevel(modelConfig);
      if (level ? level !== 'off' : options.thinking) {
        return new ChatDeepSeekThinking({
          model: modelConfig.modelName,
          apiKey: providerConfig.apiKey,
          // DeepSeek takes low, high and max, and reads medium as high
          ...(level ? { modelKwargs: { reasoning_effort: level } } : {}),
        }) as BaseChatModel;
      }
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        modelKwargs: {
          thinking: { type: 'disabled' },
        },
      };
      return new ChatDeepSeek(args) as BaseChatModel;
    }
    case ProviderTypeEnum.Gemini: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
      };
      return new ChatGoogleGenerativeAI(args);
    }
    case ProviderTypeEnum.Grok: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
        configuration: {},
      };
      return new ChatXAI(args) as BaseChatModel;
    }
    case ProviderTypeEnum.Groq: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
      };
      return new ChatGroq(args);
    }
    case ProviderTypeEnum.Cerebras: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
      };
      return new ChatCerebras(args);
    }
    case ProviderTypeEnum.Ollama: {
      const args: {
        model: string;
        apiKey?: string;
        baseUrl: string;
        modelKwargs?: { max_completion_tokens: number };
        topP?: number;
        temperature?: number;
        maxTokens?: number;
        numCtx: number;
      } = {
        model: modelConfig.modelName,
        // required but ignored by ollama
        apiKey: providerConfig.apiKey === '' ? 'ollama' : providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl ?? 'http://localhost:11434',
        topP,
        temperature,
        maxTokens,
        // ollama usually has a very small context window, so we need to set a large number for agent to work
        // It was set to 128000 in the original code, but it will cause ollama reload the models frequently if you have multiple models working together
        // not sure why, but setting it to 64000 seems to work fine
        // TODO: configure the context window size in model config
        numCtx: 64000,
      };
      return new ChatOllama(args);
    }
    case ProviderTypeEnum.OpenRouter: {
      // Call the helper function, passing OpenRouter headers via the third argument
      console.log('[createChatModel] Calling createOpenAIChatModel for OpenRouter');
      return createOpenAIChatModel(providerConfig, modelConfig, {
        headers: {
          'HTTP-Referer': 'https://nanobrowser.ai',
          'X-Title': 'Nanobrowser',
        },
      });
    }
    case ProviderTypeEnum.Llama: {
      // Llama API has a different response format, use custom ChatLlama class
      const args: {
        model: string;
        apiKey?: string;
        configuration?: Record<string, unknown>;
        topP?: number;
        temperature?: number;
        maxTokens?: number;
      } = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        topP: (modelConfig.parameters?.topP ?? 0.1) as number,
        temperature: (modelConfig.parameters?.temperature ?? 0.1) as number,
        maxTokens,
      };

      const configuration: Record<string, unknown> = {};
      if (providerConfig.baseUrl) {
        configuration.baseURL = providerConfig.baseUrl;
      }
      args.configuration = configuration;

      return new ChatLlama(args);
    }
    default: {
      // by default, we think it's a openai-compatible provider
      // Pass undefined for extraFetchOptions for default/custom cases
      return createOpenAIChatModel(providerConfig, modelConfig, undefined);
    }
  }
}
