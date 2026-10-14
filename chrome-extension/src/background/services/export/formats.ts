import type { ExportFormat } from '@extension/shared';
import type { ChatMessage, ChatSession, Message, StepMeta, TraceEntry } from '@extension/storage';
import { Actors } from '../../agent/event/types';

/**
 * Turning a chat into a file and a file back into a chat. Everything here is plain data in, plain data out:
 * reading the stores, printing a PDF and saving files happen in ./index.ts.
 */

export type { ExportFormat };

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; mime: string }> = {
  debug: { extension: 'debug.json', mime: 'application/json' },
  log: { extension: 'json', mime: 'application/json' },
  txt: { extension: 'txt', mime: 'text/plain' },
  md: { extension: 'md', mime: 'text/markdown' },
  html: { extension: 'html', mime: 'text/html' },
  pdf: { extension: 'pdf', mime: 'application/pdf' },
};

export const CHAT_LOG_FORMAT = 'nanobrowser-chat';
export const DEBUG_BUNDLE_FORMAT = 'nanobrowser-debug';
const VERSION = 1;

/** The whole chat as kept: what the side panel shows and what the agents knew, enough to go on with it */
export interface ChatLog {
  format: typeof CHAT_LOG_FORMAT;
  version: number;
  exportedAt: string;
  extension?: { version: string; build: string };
  session: ChatSession;
  /** what the agents knew when the last task ended (an executor snapshot) */
  agentContext: unknown;
  /** the steps of the last task, for replaying it */
  stepHistory: { task: string; history: unknown; timestamp: number } | null;
}

/** One model call as the debug bundle sums it up: when, who, which model, how long, how many tokens */
export interface CallSummary {
  runId: string;
  caller: string;
  model: string;
  startedAt: string;
  latencyMs: number | null;
  messages: number;
  /** characters sent: the prompt's size, as a model sees it before it counts tokens */
  promptChars: number;
  usage?: Record<string, unknown>;
  error?: string;
}

/** The chat log with everything the agents did: every model call with its prompt and reply, every event */
export interface DebugBundle extends Omit<ChatLog, 'format'> {
  format: typeof DEBUG_BUNDLE_FORMAT;
  summary: {
    tasks: number;
    events: number;
    modelCalls: number;
    failedCalls: number;
    httpRequests: number;
    /** input and output tokens by model, as the providers counted them */
    tokens: Record<string, { input: number; output: number; calls: number }>;
    modelTimeMs: number;
  };
  calls: CallSummary[];
  /** in order; bodies (prompts, replies, request bodies) are referenced by their key in `blobs` */
  trace: TraceEntry[];
  blobs: Record<string, unknown>;
  /** how to read the trace: llm_start.messages and llm_end.response hold keys of `blobs` */
  readme: string;
}

const DEBUG_README =
  'trace lists, in order: task (a run began, with its settings), llm_start / llm_end (a model call: caller, ' +
  'model, params with the tools offered, messages sent, reply, usage, latency, error), http (a Jev request) ' +
  'and event (what the agents reported; navigator steps carry meta.view.text, the page as the model read it). ' +
  'messages, response, request: keys of blobs, which hold each body once. calls sums up every model call.';

export function buildChatLog(
  session: ChatSession,
  agentContext: unknown,
  stepHistory: ChatLog['stepHistory'],
  extension?: ChatLog['extension'],
  now = new Date(),
): ChatLog {
  return {
    format: CHAT_LOG_FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    ...(extension ? { extension } : {}),
    session,
    agentContext,
    stepHistory,
  };
}

/** Text a body holds, as long as a model reads it: the prompt size of a call */
function bodyChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value && typeof value === 'object' && 'content' in value) {
    const content = (value as { content: unknown }).content;
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
      return content.reduce((sum: number, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0);
    }
  }
  return JSON.stringify(value ?? '').length;
}

function tokenCount(usage: Record<string, unknown> | undefined, ...names: string[]): number {
  for (const name of names) {
    const value = usage?.[name];
    if (typeof value === 'number') return value;
  }
  return 0;
}

export function buildDebugBundle(log: ChatLog, trace: TraceEntry[], blobs: Record<string, unknown>): DebugBundle {
  const ends = new Map(trace.flatMap(entry => (entry.kind === 'llm_end' ? [[entry.runId, entry] as const] : [])));
  const calls: CallSummary[] = [];
  const tokens: DebugBundle['summary']['tokens'] = {};
  let modelTimeMs = 0;
  for (const entry of trace) {
    if (entry.kind !== 'llm_start') continue;
    const end = ends.get(entry.runId);
    const usage = end?.usage;
    calls.push({
      runId: entry.runId,
      caller: entry.caller,
      model: entry.model,
      startedAt: new Date(entry.t).toISOString(),
      latencyMs: end?.latencyMs ?? null,
      messages: entry.messages.length,
      promptChars: entry.messages.reduce((sum, key) => sum + bodyChars(blobs[key]), 0),
      ...(usage ? { usage } : {}),
      ...(end?.error ? { error: end.error } : {}),
    });
    const counted = (tokens[entry.model] ??= { input: 0, output: 0, calls: 0 });
    counted.calls++;
    counted.input += tokenCount(usage, 'input_tokens', 'promptTokens', 'prompt_tokens');
    counted.output += tokenCount(usage, 'output_tokens', 'completionTokens', 'completion_tokens');
    modelTimeMs += end?.latencyMs ?? 0;
  }
  const { format: _format, ...rest } = log;
  void _format;
  return {
    format: DEBUG_BUNDLE_FORMAT,
    ...rest,
    readme: DEBUG_README,
    summary: {
      tasks: trace.filter(entry => entry.kind === 'task').length,
      events: trace.filter(entry => entry.kind === 'event').length,
      modelCalls: calls.length,
      failedCalls: calls.filter(call => call.error).length,
      httpRequests: trace.filter(entry => entry.kind === 'http').length,
      tokens,
      modelTimeMs,
    },
    calls,
    trace,
    blobs,
  };
}

/** What a row of the chat is in the conversation, or null for a step of the agents' work */
type Turn = { who: 'you' | 'agent' | 'question' | 'failed' | 'notice'; text: string };

function turnOf(message: Message): Turn | null {
  if (!message.content) return null;
  switch (message.actor) {
    case Actors.USER:
      return { who: 'you', text: message.content };
    case Actors.PLANNER:
      // a plan on the way is a step; the answer it ends with is the reply
      if (message.meta?.kind === 'planner' && !message.meta.done) return null;
      return { who: 'agent', text: message.content };
    case Actors.NAVIGATOR:
      return message.meta?.kind === 'question' ? { who: 'question', text: message.content } : null;
    case Actors.SYSTEM:
      return { who: message.failed ? 'failed' : 'notice', text: message.content };
    default:
      return null;
  }
}

const TURN_LABEL: Record<Turn['who'], string> = {
  you: 'You',
  agent: 'Nanobrowser',
  question: 'Nanobrowser asks',
  failed: 'Failed',
  notice: 'Note',
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 2026-10-12 22:40, in the time zone of the browser that exports */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One step of the agents' work, in a line */
export function describeStep(message: Message): string {
  const meta = message.meta as StepMeta | undefined;
  if (meta?.kind === 'navigator') {
    const actions = meta.actions.map(action => {
      const what = [action.name, action.target, action.label ? `"${action.label}"` : '', action.value ?? '']
        .filter(Boolean)
        .join(' ');
      return action.ok ? what : `${what} — failed: ${action.error ?? 'unknown error'}`;
    });
    const how = [meta.engine === 'jev' ? 'Jev' : meta.model, `${(meta.latencyMs / 1000).toFixed(1)}s`]
      .filter(Boolean)
      .join(', ');
    const where = meta.view?.url ? ` on ${meta.view.url}` : '';
    return `${meta.goal ?? message.content}${where} (${how})${actions.length ? `: ${actions.join('; ')}` : ''}`;
  }
  if (meta?.kind === 'planner') {
    return `Plan (${meta.model}, ${(meta.latencyMs / 1000).toFixed(1)}s): ${message.content}`;
  }
  return message.content;
}

function header(session: ChatSession, now: Date): string[] {
  return [
    session.title || 'Nanobrowser chat',
    `Started ${formatTime(session.createdAt)} · exported ${formatTime(now.getTime())} · ${session.messages.length} rows`,
  ];
}

/** The conversation alone: what you said and what Nanobrowser answered or asked */
export function toText(session: ChatSession, now = new Date()): string {
  const lines = header(session, now);
  lines.push('');
  for (const message of session.messages) {
    const turn = turnOf(message);
    if (!turn) continue;
    lines.push(`[${formatTime(message.timestamp)}] ${TURN_LABEL[turn.who]}:`, turn.text, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** The conversation, with the steps that led to each answer listed under it */
export function toMarkdown(session: ChatSession, now = new Date()): string {
  const [title, sub] = header(session, now);
  const lines = [`# ${title}`, '', `_${sub}_`, ''];
  let steps: string[] = [];
  const flushSteps = () => {
    if (!steps.length) return;
    lines.push('<details><summary>Steps</summary>', '', ...steps.map(step => `- ${step}`), '', '</details>', '');
    steps = [];
  };
  for (const message of session.messages) {
    const turn = turnOf(message);
    if (!turn) {
      steps.push(`\`${formatTime(message.timestamp).slice(11)}\` ${describeStep(message).replace(/\n+/g, ' ')}`);
      continue;
    }
    flushSteps();
    lines.push(`### ${TURN_LABEL[turn.who]} · ${formatTime(message.timestamp)}`, '', turn.text, '');
  }
  flushSteps();
  return lines.join('\n').trimEnd() + '\n';
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

/**
 * A page of its own: the conversation, with the steps under each answer to unfold. `expanded` unfolds them all,
 * for a PDF, which cannot be clicked.
 */
export function toHtml(session: ChatSession, { expanded = false } = {}, now = new Date()): string {
  const [title, sub] = header(session, now);
  const parts: string[] = [];
  let steps: ChatMessage[] = [];
  const flushSteps = () => {
    if (!steps.length) return;
    const rows = steps
      .map(
        step =>
          `<li class="${step.failed ? 'fail' : ''}"><time>${formatTime(step.timestamp).slice(11)}</time> ${escapeHtml(describeStep(step))}</li>`,
      )
      .join('');
    parts.push(
      `<details${expanded ? ' open' : ''}><summary>${steps.length} step${steps.length === 1 ? '' : 's'}</summary><ol>${rows}</ol></details>`,
    );
    steps = [];
  };
  for (const message of session.messages) {
    const turn = turnOf(message);
    if (!turn) {
      steps.push(message);
      continue;
    }
    flushSteps();
    parts.push(
      `<section class="turn ${turn.who}"><header>${TURN_LABEL[turn.who]} · <time>${formatTime(message.timestamp)}</time></header><div class="text">${escapeHtml(turn.text)}</div></section>`,
    );
  }
  flushSteps();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg: #fbfbfa; --ink: #1f1f1e; --muted: #6b6b68; --line: #e4e3df; --you: #eef2fb; --agent: #ffffff; --fail: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --ink: #ececea; --muted: #9a9a96; --line: #2c2c2a; --you: #1e2633; --agent: #1d1d1c; --fail: #f2b8b5; } }
@media print { :root { --bg: #fff; --ink: #000; --muted: #555; --line: #ddd; --you: #f1f4fa; --agent: #fff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; font-size: 12.5px; }
.turn { border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin: 12px 0; background: var(--agent); break-inside: avoid; }
.turn.you { background: var(--you); }
.turn.failed header { color: var(--fail); }
.turn header { font-weight: 600; font-size: 12.5px; margin-bottom: 4px; }
.turn header time, li time { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
details { margin: 4px 0 4px 14px; color: var(--muted); font-size: 12.5px; }
summary { cursor: pointer; }
ol { margin: 6px 0; padding-left: 20px; }
li { margin: 3px 0; overflow-wrap: anywhere; }
li.fail { color: var(--fail); }
</style>
</head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
${parts.join('\n')}
</main></body>
</html>
`;
}

/** A chat taken from a file, to save as a new chat */
export interface ImportedChat {
  title: string;
  messages: Message[];
  agentContext?: unknown;
  stepHistory?: ChatLog['stepHistory'];
  /** the trace of a debug bundle, kept with the new chat */
  trace?: { entries: TraceEntry[]; blobs: Record<string, unknown> };
}

/**
 * Lines that start a turn in a conversation written out as text: ours ("[time] You:", "### You · time") and
 * those of other chat apps ("User: hello"). What follows the colon is the turn's first line.
 */
const SPEAKER =
  /^(\[[^\]]{4,30}\]\s*)?(#{1,6}\s*)?\**(You|User|Me|Human|Nanobrowser asks|Nanobrowser|Assistant|AI|ChatGPT|Claude|Gemini|Bot|Failed|Note)\**(\s*·.*|\s*:\s*(.*))?$/i;

/** The speaker and the text on the line, when the line starts a turn */
function speakerOf(line: string): { speaker: string; rest: string } | null {
  const match = line.match(SPEAKER);
  if (!match) return null;
  const [, time, heading, speaker, tail, rest] = match;
  // a word alone on a line is a speaker only as a heading or after a time
  if (!tail && !time && !heading) return null;
  return { speaker, rest: (tail?.trim().startsWith('·') ? '' : (rest ?? '')).trim() };
}

function whoOf(speaker: string): Turn['who'] {
  const name = speaker.toLowerCase();
  if (['you', 'user', 'me', 'human'].includes(name)) return 'you';
  if (name === 'nanobrowser asks') return 'question';
  if (name === 'failed') return 'failed';
  if (name === 'note') return 'notice';
  return 'agent';
}

function messageOf(who: Turn['who'], text: string, timestamp: number): Message {
  switch (who) {
    case 'you':
      return { actor: Actors.USER, content: text, timestamp };
    case 'question':
      return { actor: Actors.NAVIGATOR, content: text, timestamp, meta: { kind: 'question' } };
    case 'failed':
    case 'notice':
      return { actor: Actors.SYSTEM, content: text, timestamp, ...(who === 'failed' ? { failed: true } : {}) };
    default:
      // an answer, so that the agents read it as one when the chat goes on
      return {
        actor: Actors.PLANNER,
        content: text,
        timestamp,
        meta: { kind: 'planner', model: 'imported', latencyMs: 0, done: true },
      } as Message;
  }
}

/**
 * The turns of a conversation written out as text, ours (txt, md) or another app's ("User:", "Assistant:").
 * Text without such turns becomes one message of earlier context, which the agent reads before what comes next.
 */
export function parseConversationText(text: string, name: string, now = Date.now()): ImportedChat {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const turns: { who: Turn['who']; lines: string[] }[] = [];
  let title = '';
  let inSteps = false;
  // our page or PDF: the steps folded under "3 steps" run up to the next turn
  let inFoldedSteps = false;
  for (const line of lines) {
    // our own markdown: the steps under an answer are the agents' work, not the conversation
    if (/^<details>/.test(line.trim())) inSteps = true;
    if (inSteps) {
      if (/^<\/details>/.test(line.trim())) inSteps = false;
      continue;
    }
    if (/^\d+ steps?$/.test(line.trim())) {
      inFoldedSteps = true;
      continue;
    }
    const speaker = speakerOf(line);
    if (inFoldedSteps && !speaker) continue;
    inFoldedSteps = false;
    if (speaker) {
      turns.push({ who: whoOf(speaker.speaker), lines: speaker.rest ? [speaker.rest] : [] });
      continue;
    }
    if (!turns.length) {
      if (!title && line.trim()) title = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    turns[turns.length - 1].lines.push(line);
  }
  const found = turns.map(turn => ({ who: turn.who, text: turn.lines.join('\n').trim() })).filter(turn => turn.text);
  const base = name.replace(/\.[^.]+$/, '');
  if (!found.length) {
    const body = text.trim();
    return {
      title: `Imported · ${base}`.slice(0, 60),
      messages: body
        ? [{ actor: Actors.USER, content: `Earlier conversation, imported from ${name}:\n\n${body}`, timestamp: now }]
        : [],
    };
  }
  // the times written in the file are not reliable enough to sort by: the rows keep their order
  const start = now - found.length;
  return {
    title: (title || `Imported · ${base}`).slice(0, 60),
    messages: found.map((turn, i) => messageOf(turn.who, turn.text, start + i)),
  };
}

/** A chat of ours: a full log, or a debug bundle, which holds one */
export function parseChatJson(value: unknown): ImportedChat | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Omit<Partial<DebugBundle>, 'format'> & { format?: string };
  if (data.format !== CHAT_LOG_FORMAT && data.format !== DEBUG_BUNDLE_FORMAT) return null;
  const session = data.session;
  if (!session || !Array.isArray(session.messages)) throw new Error('The file has no chat in it');
  const messages: Message[] = session.messages
    .filter(message => message && typeof message.content === 'string' && typeof message.actor === 'string')
    .map(({ id: _id, ...message }) => {
      void _id;
      return message;
    });
  return {
    title: session.title || 'Imported chat',
    messages,
    agentContext: data.agentContext ?? undefined,
    stepHistory: data.stepHistory ?? undefined,
    ...(data.format === DEBUG_BUNDLE_FORMAT && Array.isArray(data.trace)
      ? { trace: { entries: data.trace, blobs: data.blobs ?? {} } }
      : {}),
  };
}

/** A file name a chat can be saved under */
export function fileName(title: string, format: ExportFormat, now = new Date()): string {
  const safe =
    title
      // control characters too, which no file system takes
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'chat';
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `nanobrowser-${safe}-${day}.${EXPORT_FORMATS[format].extension}`;
}
