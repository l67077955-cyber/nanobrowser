import type { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { convertInputMessages, extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { repairJsonString } from '@src/background/utils';
import { isAbortedError, ModelTimeoutError, ResponseParseError, withModelTimeout } from './errors';
import { ProviderTypeEnum } from '@extension/storage';

const logger = createLogger('agent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallOptions = Record<string, any>;

// Update options to use Zod schema
export interface BaseAgentOptions {
  chatLLM: BaseChatModel;
  context: AgentContext;
  prompt: BasePrompt;
  provider?: string;
}
export interface ExtraAgentOptions {
  id?: string;
  toolCallingMethod?: string;
  callOptions?: CallOptions;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: BaseChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected toolCallingMethod: string | null;
  protected chatModelLibrary: string;
  protected modelName: string;
  protected provider: string;
  protected withStructuredOutput: boolean;
  protected callOptions?: CallOptions;
  protected modelOutputToolName: string;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = options.provider || '';
    // TODO: fix this, the name is not correct in production environment
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName();
    this.withStructuredOutput = this.setWithStructuredOutput();
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.toolCallingMethod = this.setToolCallingMethod(extraOptions?.toolCallingMethod);
    this.callOptions = extraOptions?.callOptions;
    this.modelOutputToolName = `${this.id}_output`;
  }

  // Set the model name
  private getModelName(): string {
    if ('modelName' in this.chatLLM) {
      return this.chatLLM.modelName as string;
    }
    if ('model_name' in this.chatLLM) {
      return this.chatLLM.model_name as string;
    }
    if ('model' in this.chatLLM) {
      return this.chatLLM.model as string;
    }
    return 'Unknown';
  }

  // Set the tool calling method
  private setToolCallingMethod(toolCallingMethod?: string): string | null {
    if (toolCallingMethod === 'auto') {
      switch (this.chatModelLibrary) {
        case 'ChatGoogleGenerativeAI':
          return null;
        case 'ChatOpenAI':
        case 'AzureChatOpenAI':
        case 'ChatGroq':
        case 'ChatXAI':
          return 'function_calling';
        default:
          return null;
      }
    }
    return toolCallingMethod || null;
  }

  // Check if model is a Llama model (only for Llama-specific handling)
  private isLlamaModel(modelName: string): boolean {
    return modelName.includes('Llama-4') || modelName.includes('Llama-3.3') || modelName.includes('llama-3.3');
  }

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    return true;
  }

  async invoke(
    inputMessages: BaseMessage[],
    signal: AbortSignal = this.context.controller.signal,
  ): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      logger.debug(`[${this.modelName}] Preparing structured output call with schema:`, {
        schemaName: this.modelOutputToolName,
        messageCount: inputMessages.length,
        modelProvider: this.provider,
      });

      const structuredLlm = this.chatLLM.withStructuredOutput(this.modelOutputSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        logger.debug(`[${this.modelName}] Invoking LLM with structured output...`);
        response = await withModelTimeout(this.modelName, signal, callSignal =>
          structuredLlm.invoke(inputMessages, {
            signal: callSignal,
            ...this.callOptions,
          }),
        );

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
        });

        if (response.parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
          return response.parsed;
        }

        const recovered = this.parseRawStructuredResponse(response.raw);
        if (recovered) {
          logger.warning(`[${this.modelName}] Recovered structured output from raw response`);
          return recovered;
        }

        logger.error('Failed to parse response', response);
        throw new Error(
          `Could not parse response with structured output (${this.getRawResponseDebugInfo(response.raw)})`,
        );
      } catch (error) {
        if (isAbortedError(error) || error instanceof ModelTimeoutError) {
          throw error;
        }

        // Try to extract JSON from raw response manually if possible
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            return parsed;
          }
        }

        const recovered = this.parseRawStructuredResponse(response?.raw);
        if (recovered) {
          logger.warning(
            `[${this.modelName}] Recovered structured output from raw response after error: ${errorMessage}`,
          );
          return recovered;
        }

        logger.error(`[${this.modelName}] LLM call failed with error: \n${errorMessage}`);
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }
    }

    // Fallback: Without structured output support, need to extract JSON from model output manually
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    try {
      const response = await withModelTimeout(this.modelName, signal, callSignal =>
        this.chatLLM.invoke(convertedInputMessages, {
          signal: callSignal,
          ...this.callOptions,
        }),
      );

      if (typeof response.content === 'string') {
        const parsed = this.manuallyParseResponse(response.content);
        if (parsed) {
          return parsed;
        }
      }
    } catch (error) {
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }
    const errorMessage = `Failed to parse response from ${this.modelName}`;
    logger.error(errorMessage);
    throw new ResponseParseError('Could not parse response');
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    try {
      return this.modelOutputSchema.parse(data);
    } catch (error) {
      logger.error('validateModelOutput', error);
      throw new ResponseParseError('Could not validate model output');
    }
  }

  // Helper method to manually parse the response content
  protected manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const cleanedContent = removeThinkTags(content);
    try {
      const extractedJson = extractJsonFromModelOutput(cleanedContent);
      return this.validateModelOutput(extractedJson);
    } catch (error) {
      logger.warning('manuallyParseResponse failed', error);
      return undefined;
    }
  }

  // Helper method to recover structured output from the raw message when the structured parser returns nothing
  protected parseRawStructuredResponse(raw: BaseMessage | undefined): this['ModelOutput'] | undefined {
    if (!raw) {
      return undefined;
    }

    if (typeof raw.content === 'string') {
      if (raw.content.trim().length > 0) {
        const parsed = this.manuallyParseResponse(raw.content);
        if (parsed) {
          return parsed;
        }
      }
    } else if (Array.isArray(raw.content)) {
      const text = raw.content
        .map(item =>
          typeof item === 'object' && item !== null && 'text' in item ? ((item as { text?: string }).text ?? '') : '',
        )
        .join('');
      if (text.trim().length > 0) {
        const parsed = this.manuallyParseResponse(text);
        if (parsed) {
          return parsed;
        }
      }
    }

    const rawWithToolCalls = raw as BaseMessage & {
      tool_calls?: Array<{ args?: unknown }>;
      invalid_tool_calls?: Array<{ args?: unknown }>;
    };

    for (const toolCall of rawWithToolCalls.tool_calls ?? []) {
      const parsed = this.tryParseToolCallArgs(toolCall.args);
      if (parsed) {
        return parsed;
      }
    }

    for (const toolCall of rawWithToolCalls.invalid_tool_calls ?? []) {
      const parsed = this.tryParseToolCallArgs(toolCall.args);
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  private tryParseToolCallArgs(args: unknown): this['ModelOutput'] | undefined {
    if (args === undefined || args === null) {
      return undefined;
    }
    try {
      const candidate = typeof args === 'string' ? JSON.parse(repairJsonString(args)) : args;
      const result = this.modelOutputSchema.safeParse(candidate);
      if (result.success) {
        return result.data;
      }
      const patched = fillMissingStrings(candidate, result.error);
      if (!patched) {
        return undefined;
      }
      const retry = this.modelOutputSchema.safeParse(patched);
      if (retry.success) {
        logger.warning(`[${this.modelName}] Filled null/missing string fields in tool call args`);
        return retry.data;
      }
      return undefined;
    } catch (error) {
      return undefined;
    }
  }

  // Schema transforms may throw instead of reporting an issue, so safeParse is guarded here
  private describeSchemaIssues(args: unknown): string {
    try {
      const result = this.modelOutputSchema.safeParse(args);
      return result.success
        ? ''
        : ` schema: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`;
    } catch (error) {
      return ` schema: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Helper method to describe the raw message for error reporting
  protected getRawResponseDebugInfo(raw: BaseMessage | undefined): string {
    if (!raw) {
      return 'no raw response';
    }
    const rawWithToolCalls = raw as BaseMessage & {
      tool_calls?: Array<{ name?: string; args?: unknown }>;
      invalid_tool_calls?: Array<{ name?: string; args?: unknown; error?: string }>;
    };
    const parts: string[] = [];
    if (typeof raw.content === 'string' && raw.content.trim().length > 0) {
      parts.push(`content=${raw.content.slice(0, 500)}`);
    }
    if (rawWithToolCalls.tool_calls?.length) {
      parts.push(
        `tool_calls=${rawWithToolCalls.tool_calls
          .map(toolCall => {
            const issues = this.describeSchemaIssues(toolCall.args);
            return `${toolCall.name ?? 'unknown'}: ${JSON.stringify(toolCall.args)?.slice(0, 300)}${issues}`;
          })
          .join('; ')}`,
      );
    }
    if (rawWithToolCalls.invalid_tool_calls?.length) {
      parts.push(
        `invalid_tool_calls=${rawWithToolCalls.invalid_tool_calls
          .map(toolCall => {
            const argsText = typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args);
            return `${toolCall.name ?? 'unknown'}: ${argsText?.slice(0, 300)} (${toolCall.error ?? ''})`;
          })
          .join('; ')}`,
      );
    }
    return parts.length > 0 ? parts.join(' | ') : 'empty response';
  }
}

// Models often send null or omit top-level text fields that are empty for the current step
// (e.g. the planner's final_answer before the task is done). Replace those with '' so the args validate.
function fillMissingStrings(candidate: unknown, error: z.ZodError): Record<string, unknown> | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const patched: Record<string, unknown> = { ...(candidate as Record<string, unknown>) };
  let changed = false;
  for (const issue of error.issues) {
    if (
      issue.code === 'invalid_type' &&
      issue.expected === 'string' &&
      (issue.received === 'null' || issue.received === 'undefined') &&
      issue.path.length === 1
    ) {
      patched[issue.path[0]] = '';
      changed = true;
    }
  }
  return changed ? patched : undefined;
}
