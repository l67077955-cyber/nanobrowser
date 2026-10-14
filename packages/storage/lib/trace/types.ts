/**
 * The debug trace of a chat: everything that happened while its agent worked, for the user (or a developer) to
 * see how a task went in every detail. Kept apart from the chat itself, which holds only what the side panel shows.
 */

/** A message sent to a model or received from it, as the provider got it */
export interface TraceMessage {
  /** system, human, ai, tool */
  type: string;
  /** text, or parts (text, images) for a message that has several */
  content: unknown;
  name?: string;
  tool_calls?: unknown[];
  invalid_tool_calls?: unknown[];
  tool_call_id?: string;
  /** what providers send besides the content: reasoning, refusals */
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
  usage_metadata?: Record<string, unknown>;
}

interface TraceBase {
  /** Unix time in milliseconds */
  t: number;
  sessionId: string;
}

/** A task (or a follow-up) began: what was asked and the settings it ran with, without any key */
export interface TraceTaskEntry extends TraceBase {
  kind: 'task';
  task: string;
  /** why this run started: a new task, a follow-up, a bridge's task, a schedule, a replay */
  trigger: string;
  config: Record<string, unknown>;
}

/** A call to a chat model began */
export interface TraceLLMStartEntry extends TraceBase {
  kind: 'llm_start';
  runId: string;
  /** who called: navigator, planner, captcha, memory... (the call's tags) */
  caller: string;
  model: string;
  provider?: string;
  /** what was sent besides the messages: tools and their schemas, response format, temperature... */
  params: Record<string, unknown>;
  /** the messages sent, by their key in the session's blobs */
  messages: string[];
}

/** A call to a chat model ended, with what the model answered or why it failed */
export interface TraceLLMEndEntry extends TraceBase {
  kind: 'llm_end';
  runId: string;
  latencyMs: number;
  /** the model's reply, by its key in the session's blobs */
  response?: string;
  /** tokens in and out, as the provider counts them */
  usage?: Record<string, unknown>;
  error?: string;
}

/** A request to a service other than a chat model (Jev) */
export interface TraceHttpEntry extends TraceBase {
  kind: 'http';
  service: string;
  url: string;
  /** the request body, by its key in the session's blobs */
  request?: string;
  status?: number;
  /** the response body, by its key in the session's blobs */
  response?: string;
  latencyMs: number;
  error?: string;
}

/** Something the agents reported, with all of it: the page text a step read included */
export interface TraceEventEntry extends TraceBase {
  kind: 'event';
  actor: string;
  state: string;
  step: number;
  maxSteps: number;
  details: string;
  meta?: unknown;
}

export type TraceEntry = TraceTaskEntry | TraceLLMStartEntry | TraceLLMEndEntry | TraceHttpEntry | TraceEventEntry;

/** A body kept once per session however often it is sent again: each model call sends the history before it */
export interface TraceBlob {
  hash: string;
  value: unknown;
}

export interface TraceSessionInfo {
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  entries: number;
}

export interface TraceStore {
  /**
   * Adds to the session's trace. With `continuing` (the writer has written to it before) nothing is written
   * when the trace is gone, deleted with its chat or cleared, and false is returned.
   */
  append(sessionId: string, entries: TraceEntry[], blobs: TraceBlob[], continuing?: boolean): Promise<boolean>;
  /** the session's entries, oldest first */
  getEntries(sessionId: string): Promise<TraceEntry[]>;
  /** the session's bodies, by hash */
  getBlobs(sessionId: string): Promise<Record<string, unknown>>;
  listSessions(): Promise<TraceSessionInfo[]>;
  deleteSession(sessionId: string): Promise<void>;
  /** drops the oldest traces past the newest `keep` */
  prune(keep: number): Promise<void>;
  clear(): Promise<void>;
}
