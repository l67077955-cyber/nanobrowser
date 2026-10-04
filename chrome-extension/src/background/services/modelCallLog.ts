import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { createLogger, describeError } from '@src/background/log';
import { isAbortedError } from '../agent/agents/errors';

const logger = createLogger('LLM');

const PREVIEW_LENGTH = 300;

interface CallStart {
  started: number;
  who: string;
}

const preview = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
};

/** What a prompt holds, without its text: the count of messages, characters and pictures */
function describeInput(messages: BaseMessage[]) {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') chars += String(part.text).length;
      else if (part.type === 'image_url' || part.type === 'image') images++;
    }
  }
  return { messages: messages.length, chars, images };
}

/**
 * Logs every call of one chat model: who made it, what went in, how long it took, the tokens it used, how it
 * ended and what came back, or the error with its HTTP status. Agents name themselves through a run tag.
 */
export class ModelCallLogger extends BaseCallbackHandler {
  name = 'ModelCallLogger';
  private readonly calls = new Map<string, CallStart>();

  /** @param model e.g. "deepseek-flash @ OpenRouter" */
  constructor(private readonly model: string) {
    super();
  }

  handleChatModelStart(
    _llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
  ) {
    const who = tags?.find(tag => !tag.includes(':')) ?? 'llm';
    this.calls.set(runId, { started: performance.now(), who });
    logger.info(`→ ${who} · ${this.model}`, describeInput(messages[0] ?? []));
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    const call = this.take(runId);
    const generation = output.generations[0]?.[0] as
      | { text?: string; generationInfo?: Record<string, unknown>; message?: BaseMessage }
      | undefined;
    const message = generation?.message as
      | (BaseMessage & {
          usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
          tool_calls?: Array<{ name?: string }>;
          response_metadata?: Record<string, unknown>;
        })
      | undefined;
    const usage = message?.usage_metadata;
    const tokenUsage = output.llmOutput?.tokenUsage as { promptTokens?: number; completionTokens?: number } | undefined;
    const finish =
      generation?.generationInfo?.finish_reason ??
      message?.response_metadata?.finish_reason ??
      message?.response_metadata?.stop_reason;
    const text = generation?.text ?? (typeof message?.content === 'string' ? message.content : '');
    const toolCalls = message?.tool_calls?.map(toolCall => toolCall.name).filter(Boolean) ?? [];
    logger.info(`✓ ${call.who} · ${this.model} · ${call.ms}ms`, {
      tokensIn: usage?.input_tokens ?? tokenUsage?.promptTokens,
      tokensOut: usage?.output_tokens ?? tokenUsage?.completionTokens,
      finish,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reply: text ? preview(text) : '(no text)',
    });
  }

  handleLLMError(error: unknown, runId: string) {
    const call = this.take(runId);
    // a call called off on purpose: the task stopped, or the fast engine decided the step first
    if (isAbortedError(error)) {
      logger.info(`⊘ ${call.who} · ${this.model} · ${call.ms}ms · called off`);
      return;
    }
    logger.error(`✗ ${call.who} · ${this.model} · ${call.ms}ms · ${describeError(error)}`);
  }

  private take(runId: string) {
    const call = this.calls.get(runId);
    this.calls.delete(runId);
    return { who: call?.who ?? 'llm', ms: call ? Math.round(performance.now() - call.started) : -1 };
  }
}
