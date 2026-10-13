import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage, ChatSession, TraceEntry } from '@extension/storage';
import { Actors } from '../../../agent/event/types';
import {
  buildChatLog,
  buildDebugBundle,
  CHAT_LOG_FORMAT,
  DEBUG_BUNDLE_FORMAT,
  fileName,
  parseChatJson,
  parseConversationText,
  toHtml,
  toMarkdown,
  toText,
} from '../formats';

const T0 = new Date(2026, 9, 12, 22, 0).getTime();

function row(i: number, message: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage {
  return { id: `m${i}`, timestamp: T0 + i * 60_000, ...message } as ChatMessage;
}

/** A chat as the side panel saves it: a task, the steps, a question, the answer, a follow-up that failed */
const session: ChatSession = {
  id: 'chat-1',
  title: 'Cheapest flight',
  createdAt: T0,
  updatedAt: T0 + 600_000,
  messageCount: 7,
  messages: [
    row(0, { actor: Actors.USER, content: 'Find the cheapest flight to Lisbon' }),
    row(1, {
      actor: Actors.PLANNER,
      content: '1. Open the flights site',
      meta: { kind: 'planner', model: 'deepseek', latencyMs: 2100, done: false },
    }),
    row(2, {
      actor: Actors.NAVIGATOR,
      content: 'Opened the site',
      meta: {
        kind: 'navigator',
        engine: 'llm',
        model: 'deepseek',
        latencyMs: 1500,
        goal: 'Open the flights site',
        actions: [
          { name: 'go_to_url', value: 'https://flights.example', ok: true },
          { name: 'click_element', target: '[12]', label: 'Search', ok: false, error: 'not clickable' },
        ],
        view: { url: 'https://flights.example', title: 'Flights', elements: 40, screenshot: false, tabs: 1 },
      },
    }),
    row(3, { actor: Actors.NAVIGATOR, content: 'Which day?', meta: { kind: 'question' } }),
    row(4, { actor: Actors.USER, content: 'Friday' }),
    row(5, {
      actor: Actors.PLANNER,
      content: 'TAP, €89 <direct>',
      meta: { kind: 'planner', model: 'deepseek', latencyMs: 900, done: true },
    }),
    row(6, { actor: Actors.SYSTEM, content: 'The task failed: network', failed: true }),
  ],
};

describe('plain conversation', () => {
  it('keeps what was said, asked and answered, and leaves the steps out', () => {
    const text = toText(session, new Date(T0 + 3_600_000));
    expect(text).toContain('Cheapest flight');
    expect(text).toContain('[2026-10-12 22:00] You:\nFind the cheapest flight to Lisbon');
    expect(text).toContain('Nanobrowser asks:\nWhich day?');
    expect(text).toContain('Nanobrowser:\nTAP, €89 <direct>');
    expect(text).toContain('Failed:\nThe task failed: network');
    expect(text).not.toContain('Open the flights site');
  });

  it('comes back as the same turns when imported', () => {
    const chat = parseConversationText(toText(session), 'flight.txt');
    expect(chat.title).toBe('Cheapest flight');
    expect(chat.messages.map(message => [message.actor, message.content])).toEqual([
      [Actors.USER, 'Find the cheapest flight to Lisbon'],
      [Actors.NAVIGATOR, 'Which day?'],
      [Actors.USER, 'Friday'],
      [Actors.PLANNER, 'TAP, €89 <direct>'],
      [Actors.SYSTEM, 'The task failed: network'],
    ]);
    // an answer comes back as one, so the agents read it as their reply when the chat goes on
    expect(chat.messages[3].meta).toMatchObject({ kind: 'planner', done: true });
  });
});

describe('markdown', () => {
  it('lists the steps that led to each answer, failures included', () => {
    const md = toMarkdown(session);
    expect(md).toMatch(/^# Cheapest flight/);
    expect(md).toContain('### You · 2026-10-12 22:00');
    expect(md).toContain('<details><summary>Steps</summary>');
    expect(md).toContain('go_to_url https://flights.example');
    expect(md).toContain('click_element [12] "Search" — failed: not clickable');
    expect(md).toContain('on https://flights.example');
  });

  it('comes back without its steps when imported', () => {
    const chat = parseConversationText(toMarkdown(session), 'flight.md');
    expect(chat.messages.map(message => message.content)).toEqual([
      'Find the cheapest flight to Lisbon',
      'Which day?',
      'Friday',
      'TAP, €89 <direct>',
      'The task failed: network',
    ]);
  });
});

describe('html', () => {
  it('escapes what the chat says and folds the steps, unless they are to be unfolded', () => {
    const html = toHtml(session);
    expect(html).toContain('TAP, €89 &lt;direct&gt;');
    expect(html).not.toContain('<direct>');
    expect(html).toContain('<details><summary>2 steps</summary>');
    expect(toHtml(session, { expanded: true })).toContain('<details open><summary>2 steps</summary>');
    expect(html).toContain('prefers-color-scheme: dark');
  });
});

describe('conversations of other apps', () => {
  it('reads "User:" and "Assistant:" turns, with text on the same line', () => {
    const chat = parseConversationText(
      'User: how tall is the Eiffel tower?\nAssistant: About 330 m.\nIt grew with antennas.\nUser: thanks',
      'chatgpt.txt',
    );
    expect(chat.messages.map(message => [message.actor, message.content])).toEqual([
      [Actors.USER, 'how tall is the Eiffel tower?'],
      [Actors.PLANNER, 'About 330 m.\nIt grew with antennas.'],
      [Actors.USER, 'thanks'],
    ]);
    expect(chat.title).toBe('Imported · chatgpt');
  });

  it('takes text without turns as earlier context for the agent', () => {
    const chat = parseConversationText('Notes from the call: book the 9am slot.\nNote nothing else.', 'notes.txt');
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].actor).toBe(Actors.USER);
    expect(chat.messages[0].content).toContain('imported from notes.txt');
    expect(chat.messages[0].content).toContain('book the 9am slot');
  });

  it('does not take a word alone on a line for a speaker', () => {
    const chat = parseConversationText('User: list them\nAssistant: Here:\nMe\nYou\nAI', 'x.txt');
    expect(chat.messages[1].content).toBe('Here:\nMe\nYou\nAI');
  });
});

describe('full log and debug bundle', () => {
  const trace: TraceEntry[] = [
    { kind: 'task', t: T0, sessionId: 'chat-1', task: 'Find', trigger: 'new task', config: {} },
    {
      kind: 'llm_start',
      t: T0 + 1,
      sessionId: 'chat-1',
      runId: 'r1',
      caller: 'planner',
      model: 'deepseek',
      params: {},
      messages: ['a', 'b'],
    },
    {
      kind: 'llm_end',
      t: T0 + 2101,
      sessionId: 'chat-1',
      runId: 'r1',
      latencyMs: 2100,
      response: 'c',
      usage: { input_tokens: 1000, output_tokens: 50 },
    },
    {
      kind: 'llm_start',
      t: T0 + 3000,
      sessionId: 'chat-1',
      runId: 'r2',
      caller: 'navigator',
      model: 'deepseek',
      params: {},
      messages: ['a'],
    },
    { kind: 'llm_end', t: T0 + 3500, sessionId: 'chat-1', runId: 'r2', latencyMs: 500, error: 'Error: 529' },
  ];
  const blobs = {
    a: { type: 'system', content: 'You are the planner.' },
    b: { type: 'human', content: 'Find' },
    c: { type: 'ai', content: '{"done":false}' },
  };
  const log = buildChatLog(session, { tasks: ['Find'], messages: [] }, null, { version: '1', build: 'b' });

  it('sums up the model calls: tokens by model, time, failures', () => {
    const bundle = buildDebugBundle(log, trace, blobs);
    expect(bundle.format).toBe(DEBUG_BUNDLE_FORMAT);
    expect(bundle.summary).toMatchObject({
      tasks: 1,
      modelCalls: 2,
      failedCalls: 1,
      modelTimeMs: 2600,
      tokens: { deepseek: { input: 1000, output: 50, calls: 2 } },
    });
    expect(bundle.calls[0]).toMatchObject({ caller: 'planner', latencyMs: 2100, messages: 2, promptChars: 24 });
    expect(bundle.calls[1]).toMatchObject({ error: 'Error: 529' });
    expect(bundle.blobs).toBe(blobs);
  });

  it('comes back as the same chat, with what the agents knew and the trace', () => {
    const fromLog = parseChatJson(JSON.parse(JSON.stringify(log)));
    expect(log.format).toBe(CHAT_LOG_FORMAT);
    expect(fromLog?.messages).toHaveLength(session.messages.length);
    expect(fromLog?.messages[0]).not.toHaveProperty('id');
    expect(fromLog?.agentContext).toEqual({ tasks: ['Find'], messages: [] });
    expect(fromLog?.trace).toBeUndefined();

    const fromBundle = parseChatJson(JSON.parse(JSON.stringify(buildDebugBundle(log, trace, blobs))));
    expect(fromBundle?.messages[2].meta).toMatchObject({ kind: 'navigator', goal: 'Open the flights site' });
    expect(fromBundle?.trace?.entries).toHaveLength(trace.length);
    expect(fromBundle?.trace?.blobs).toEqual(blobs);
  });

  it('is not taken for a chat of ours when it is some other JSON', () => {
    expect(parseChatJson({ messages: [] })).toBeNull();
    expect(() => parseChatJson({ format: CHAT_LOG_FORMAT })).toThrow('no chat');
  });
});

describe('fileName', () => {
  it('makes a name every system takes', () => {
    expect(fileName('Flights: LIS/OPO? <cheap>', 'debug', new Date(2026, 9, 12))).toBe(
      'nanobrowser-Flights LIS OPO cheap-20261012.debug.json',
    );
    expect(fileName('', 'pdf', new Date(2026, 9, 12))).toBe('nanobrowser-chat-20261012.pdf');
  });
});

describe('our page and PDF, taken back in', () => {
  it('reads the turns of the page and leaves the folded steps out', async () => {
    vi.doMock('@extension/storage', () => ({ chatHistoryStore: {}, traceStore: {} }));
    vi.doMock('../../../log', () => ({ createLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));
    const { readChatFile } = await import('../index');
    const chat = readChatFile('flight.html', toHtml(session));
    expect(chat.title).toBe('Cheapest flight');
    expect(chat.messages.map(message => message.content)).toEqual([
      'Find the cheapest flight to Lisbon',
      'Which day?',
      'Friday',
      'TAP, €89 <direct>',
      'The task failed: network',
    ]);
  });

  it('reads the text of our PDF, as PDF.js gives it line by line', () => {
    // the page printed: headers, turns, "2 steps" with the steps unfolded under it
    const text = [
      'Cheapest flight',
      'Started 2026-10-12 22:00 · exported 2026-10-12 23:00 · 7 rows',
      'You · 2026-10-12 22:00',
      'Find the cheapest flight to Lisbon',
      '2 steps',
      '22:01 Plan (deepseek, 2.1s): 1. Open the flights site',
      '22:02 Open the flights site on https://flights.example (deepseek, 1.5s): go_to_url',
      'Nanobrowser asks · 2026-10-12 22:03',
      'Which day?',
      'You · 2026-10-12 22:04',
      'Friday',
      'Nanobrowser · 2026-10-12 22:05',
      'TAP, €89',
    ].join('\n');
    const chat = parseConversationText(text, 'flight.pdf');
    expect(chat.messages.map(message => [message.actor, message.content])).toEqual([
      [Actors.USER, 'Find the cheapest flight to Lisbon'],
      [Actors.NAVIGATOR, 'Which day?'],
      [Actors.USER, 'Friday'],
      [Actors.PLANNER, 'TAP, €89'],
    ]);
  });
});
