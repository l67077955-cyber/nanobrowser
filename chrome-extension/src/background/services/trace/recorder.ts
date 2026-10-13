import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import {
  traceStore,
  type TraceBlob,
  type TraceEntry,
  type TraceMessage,
  type TraceStore,
  type TraceTaskEntry,
} from '@extension/storage';
import type { AgentEvent } from '../../agent/event/types';
import { createLogger } from '../../log';

const logger = createLogger('trace');

/** Entries are written this long after the first one waiting, in one transaction */
const FLUSH_DELAY_MS = 1000;
/** Traces of this many chats are kept; older ones are dropped when a newer one starts */
export const MAX_TRACED_SESSIONS = 100;

/** Field names whose values never go into a trace: keys and credentials a model or service is set up with */
const SECRET_KEY = /(api[_-]?key|authorization|secret|password|access[_-]?token|bearer)/i;

/** A fast hash of a body, to keep it once however often it is sent */
export function hashOf(text: string): string {
  // cyrb53
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}-${text.length}`;
}

/** A copy without keys or credentials, and without values that do not survive being stored (functions, cycles) */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    const copied = redact(item, seen);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

/** The parts of a message's content, with screenshots left out unless they are wanted */
function traceContent(content: unknown, screenshots: boolean): unknown {
  if (!Array.isArray(content) || screenshots) return content;
  return content.map(part => {
    if (!part || typeof part !== 'object' || (part as { type?: string }).type !== 'image_url') return part;
    const image = (part as { image_url?: string | { url?: string } }).image_url;
    const url = typeof image === 'string' ? image : (image?.url ?? '');
    return {
      type: 'image_url',
      omitted: `image of ${Math.round((url.length * 3) / 4 / 1024)} KB left out of the trace`,
    };
  });
}

/** A message as the provider got it or sent it, every field that says something included */
export function traceMessage(message: BaseMessage, screenshots: boolean): TraceMessage {
  const any = message as BaseMessage & {
    tool_calls?: unknown[];
    invalid_tool_calls?: unknown[];
    tool_call_id?: string;
    usage_metadata?: Record<string, unknown>;
  };
  const out: TraceMessage = { type: message._getType(), content: traceContent(message.content, screenshots) };
  if (message.name) out.name = message.name;
  if (any.tool_calls?.length) out.tool_calls = any.tool_calls;
  if (any.invalid_tool_calls?.length) out.invalid_tool_calls = any.invalid_tool_calls;
  if (any.tool_call_id) out.tool_call_id = any.tool_call_id;
  if (message.additional_kwargs && Object.keys(message.additional_kwargs).length) {
    out.additional_kwargs = redact(message.additional_kwargs) as Record<string, unknown>;
  }
  if (message.response_metadata && Object.keys(message.response_metadata).length) {
    out.response_metadata = redact(message.response_metadata) as Record<string, unknown>;
  }
  if (any.usage_metadata) out.usage_metadata = any.usage_metadata;
  return out;
}

/** The model name a serialized chat model was set up with */
function modelOf(llm: Serialized, params: Record<string, unknown>): string {
  const kwargs = (llm as { kwargs?: Record<string, unknown> }).kwargs ?? {};
  const name = params.model ?? params.modelName ?? kwargs.model ?? kwargs.model_name ?? kwargs.modelName;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * Records what the agent of one chat does into its trace: every model call (the messages sent, the tools and
 * options with them, the reply, tokens and time), every request to Jev, and every event the agents report.
 * Bodies sent again and again (the history in each prompt) are kept once.
 */
export class TraceRecorder {
  private entries: TraceEntry[] = [];
  private blobs: TraceBlob[] = [];
  /** bodies of this session already written or waiting to be */
  private known = new Set<string>();
  private starts = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** the LangChain handler to give the chat models of the chat's agent */
  readonly handler: BaseCallbackHandler;
  /** fetch for Jev's requests, recorded as they go */
  readonly fetch: typeof fetch;
  /** whether the screenshots sent to the models go into the trace */
  screenshots: boolean;

  constructor(
    readonly sessionId: string,
    private readonly options: { screenshots?: boolean; store?: TraceStore; fetchImpl?: typeof fetch } = {},
  ) {
    this.screenshots = options.screenshots ?? false;
    this.handler = this.createHandler();
    const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.fetch = (input, init) => this.tracedFetch(fetchImpl, input, init);
  }

  private get store(): TraceStore {
    return this.options.store ?? traceStore;
  }

  /** Keeps a body once and returns its key */
  private keep(value: unknown): string {
    const text = JSON.stringify(value) ?? 'null';
    const hash = hashOf(text);
    if (!this.known.has(hash)) {
      this.known.add(hash);
      this.blobs.push({ hash, value });
    }
    return hash;
  }

  private add(entry: TraceEntry): void {
    this.entries.push(entry);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
  }

  /** A task or a follow-up begins, with the settings it runs with */
  task(task: string, trigger: string, config: Record<string, unknown>): void {
    const entry: TraceTaskEntry = {
      kind: 'task',
      t: Date.now(),
      sessionId: this.sessionId,
      task,
      trigger,
      config: redact(config) as Record<string, unknown>,
    };
    this.add(entry);
  }

  /** An event the agents reported, the page text of a step included */
  event(event: AgentEvent): void {
    this.add({
      kind: 'event',
      t: event.timestamp,
      sessionId: this.sessionId,
      actor: event.actor,
      state: event.state,
      step: event.data.step,
      maxSteps: event.data.maxSteps,
      details: event.data.details,
      ...(event.data.meta ? { meta: redact(event.data.meta) } : {}),
    });
  }

  /** Writes what is waiting; the writes of one recorder go one after another */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const entries = this.entries;
    const blobs = this.blobs;
    this.entries = [];
    this.blobs = [];
    if (!entries.length && !blobs.length) return this.writing;
    this.writing = this.writing
      .then(() => this.store.append(this.sessionId, entries, blobs))
      .catch(error => {
        // a body that was not written is written again with the next entry that refers to it
        for (const blob of blobs) this.known.delete(blob.hash);
        logger.warning('Failed to write the debug trace:', error);
      });
    return this.writing;
  }

  private createHandler(): BaseCallbackHandler {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const recorder = this;
    const handler = BaseCallbackHandler.fromMethods({
      handleChatModelStart(
        llm: Serialized,
        messages: BaseMessage[][],
        runId: string,
        _parentRunId?: string,
        extraParams?: Record<string, unknown>,
        tags?: string[],
        metadata?: Record<string, unknown>,
      ) {
        const params = (redact(extraParams?.invocation_params ?? {}) ?? {}) as Record<string, unknown>;
        recorder.starts.set(runId, Date.now());
        recorder.add({
          kind: 'llm_start',
          t: Date.now(),
          sessionId: recorder.sessionId,
          runId,
          caller: tags?.filter(tag => !tag.startsWith('seq:')).join(',') || 'model',
          model: modelOf(llm, params),
          ...(typeof metadata?.ls_provider === 'string' ? { provider: metadata.ls_provider } : {}),
          params,
          messages: (messages[0] ?? []).map(message => recorder.keep(traceMessage(message, recorder.screenshots))),
        });
      },
      handleLLMEnd(output: LLMResult, runId: string) {
        const generation = output.generations?.[0]?.[0] as { message?: BaseMessage; text?: string } | undefined;
        const reply = generation?.message ? traceMessage(generation.message, recorder.screenshots) : generation?.text;
        const usage =
          (generation?.message as { usage_metadata?: Record<string, unknown> } | undefined)?.usage_metadata ??
          (output.llmOutput?.tokenUsage as Record<string, unknown> | undefined);
        recorder.add({
          kind: 'llm_end',
          t: Date.now(),
          sessionId: recorder.sessionId,
          runId,
          latencyMs: Date.now() - (recorder.starts.get(runId) ?? Date.now()),
          ...(reply !== undefined ? { response: recorder.keep(reply) } : {}),
          ...(usage ? { usage } : {}),
        });
        recorder.starts.delete(runId);
      },
      handleLLMError(error: Error, runId: string) {
        recorder.add({
          kind: 'llm_end',
          t: Date.now(),
          sessionId: recorder.sessionId,
          runId,
          latencyMs: Date.now() - (recorder.starts.get(runId) ?? Date.now()),
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        recorder.starts.delete(runId);
      },
    });
    // the agents must not wait on the trace being written
    handler.awaitHandlers = false;
    return handler;
  }

  private async tracedFetch(
    fetchImpl: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const started = Date.now();
    let request: string | undefined;
    if (typeof init?.body === 'string') {
      try {
        request = this.keep(redact(JSON.parse(init.body)));
      } catch {
        request = this.keep(init.body);
      }
    }
    const base = { kind: 'http' as const, t: started, sessionId: this.sessionId, service: 'jev', url };
    try {
      const response = await fetchImpl(input, init);
      // the body is read from a copy, so that the caller still reads the response
      const text = await response
        .clone()
        .text()
        .catch(() => '');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: kept as text
      }
      this.add({
        ...base,
        ...(request ? { request } : {}),
        status: response.status,
        response: this.keep(redact(body)),
        latencyMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      this.add({
        ...base,
        ...(request ? { request } : {}),
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
