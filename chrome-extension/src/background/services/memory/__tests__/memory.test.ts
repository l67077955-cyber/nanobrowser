import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { MemoryEntry } from '@extension/storage';

const store = vi.hoisted(() => ({ entries: [] as MemoryEntry[], max: 3 }));

vi.mock('@extension/storage', async () => {
  const { looksSecret } = (await vi.importActual('../../../../../../packages/storage/lib/memory/secrets')) as {
    looksSecret: (text: string) => boolean;
  };
  let nextId = 100;
  return {
    looksSecret,
    get MAX_MEMORIES() {
      return store.max;
    },
    memoryStore: {
      getAll: async () => [...store.entries],
      add: async (content: string) => {
        const entry = { id: String(nextId++), content, createdAt: 0, updatedAt: Date.now() };
        store.entries.push(entry);
        return entry;
      },
      update: async (id: string, content: string) => {
        store.entries = store.entries.map(e => (e.id === id ? { ...e, content } : e));
        return true;
      },
      remove: async (id: string) => {
        store.entries = store.entries.filter(e => e.id !== id);
      },
    },
  };
});

import {
  formatMemoryContext,
  memoryInstructions,
  parseCandidates,
  rememberFromMessages,
  rememberFromText,
} from '../index';
import { buildCurationRequest, interpretCuration } from '../curator';

const entry = (id: string, content: string, updatedAt = 0): MemoryEntry => ({ id, content, createdAt: 0, updatedAt });

/** An LLM that answers each call with the next reply */
function llm(...replies: string[]) {
  const invoke = vi.fn(async () => ({ content: replies.shift() ?? '{}' }));
  return { model: { invoke } as unknown as BaseChatModel, invoke };
}

/** What the first call, the extraction, handed to the model */
function extractorInput(invoke: ReturnType<typeof llm>['invoke']) {
  const [messages] = invoke.mock.calls[0] as unknown as [{ content: string }[]];
  return JSON.parse(messages[1].content);
}

/** A Jev endpoint that picks the given key for each question */
function jev(picks: Record<string, string>) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions)) {
      const ids = Object.keys(question.criteria);
      const probabilities = Object.fromEntries(ids.map(id => [id, id === picks[name] ? 1 : 0]));
      answers[name] = { choice: picks[name], probabilities, confidence: 1 };
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  store.entries = [];
  store.max = 3;
});

describe('parseCandidates', () => {
  it('keeps new facts and drops secrets, duplicates and non-strings', () => {
    const reply = `Here you go: ${JSON.stringify({
      memories: [
        'The user lives in Berlin.',
        'the user  lives in berlin.',
        'The user already known.',
        "The user's GitHub password is hunter2.",
        'The user has the key sk-or-v1-abcdef0123456789abcdef.',
        'The user pays with card 4111 1111 1111 1111.',
        42,
      ],
    })}`;
    expect(parseCandidates(reply, [entry('1', 'The user already known.')])).toEqual(['The user lives in Berlin.']);
  });

  it('keeps a fact that only mentions a project named like a secret word', () => {
    const reply = JSON.stringify({ memories: ['The user works on the token-hub project.'] });
    expect(parseCandidates(reply, [])).toEqual(['The user works on the token-hub project.']);
  });

  it('returns nothing for a reply that is not the expected JSON', () => {
    expect(parseCandidates('nothing to remember', [])).toEqual([]);
    expect(parseCandidates('{"memories": "x"}', [])).toEqual([]);
    expect(parseCandidates('{broken', [])).toEqual([]);
  });
});

describe('formatMemoryContext', () => {
  it('is empty without memories', () => {
    expect(formatMemoryContext([])).toBe('');
  });

  it('lists the most recently updated first and stays within the budget', () => {
    const memories = Array.from({ length: 40 }, (_, i) => entry(String(i), `fact ${i} ${'x'.repeat(90)}`, i));
    const context = formatMemoryContext(memories);
    expect(context.indexOf('fact 39 ')).toBeLessThan(context.indexOf('fact 38 '));
    expect(context).not.toContain('fact 0 ');
    expect(context.length).toBeLessThan(2400);
  });
});

describe('curation', () => {
  const memories = [entry('a', 'lives in Berlin'), entry('b', 'prefers dark mode')];

  it('numbers the memories and asks which to delete only when full', () => {
    const open = buildCurationRequest('speaks German', memories, false);
    expect(open.state.current_memories).toEqual(['1# lives in Berlin', '2# prefers dark mode']);
    expect(Object.keys(open.questions.decision.criteria)).toEqual(['add', 'skip', 'replace_1', 'replace_2']);
    expect(open.questions.evict).toBeUndefined();

    const full = buildCurationRequest('speaks German', memories, true);
    expect(Object.keys(full.questions.evict!.criteria)).toEqual(['1', '2', 'none']);
  });

  it('maps choices back to memory ids', () => {
    expect(interpretCuration({ decision: 'add' }, memories, false)).toEqual({ action: 'add' });
    expect(interpretCuration({ decision: 'replace_2' }, memories, false)).toEqual({ action: 'replace', id: 'b' });
    expect(interpretCuration({ decision: 'add', evict: '1' }, memories, true)).toEqual({ action: 'add', evictId: 'a' });
  });

  it('changes nothing when full and nothing is given up, or on an answer that was not offered', () => {
    expect(interpretCuration({ decision: 'add', evict: 'none' }, memories, true)).toEqual({ action: 'skip' });
    expect(interpretCuration({ decision: 'add', evict: '7' }, memories, true)).toEqual({ action: 'skip' });
    expect(interpretCuration({ decision: 'replace_9' }, memories, false)).toEqual({ action: 'skip' });
    expect(interpretCuration({ decision: 'sure!' }, memories, false)).toEqual({ action: 'skip' });
    expect(interpretCuration({}, memories, false)).toEqual({ action: 'skip' });
  });
});

describe('rememberFromMessages', () => {
  it('does not call the model for empty messages', async () => {
    const { model, invoke } = llm();
    expect(await rememberFromMessages(['  '], { llm: model })).toEqual({
      added: [],
      updated: [],
      removed: [],
      asked: false,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stores what Jev accepts and sends only the user messages to the extractor', async () => {
    const { model, invoke } = llm('{"memories": ["The user lives in Berlin."]}');
    const fetchImpl = jev({ decision: 'add' });
    const change = await rememberFromMessages(['I live in Berlin, find me a dentist'], {
      llm: model,
      jevApiKey: 'sk-or-test',
      fetchImpl,
    });
    expect(change.added).toEqual(['The user lives in Berlin.']);
    expect(store.entries.map(e => e.content)).toEqual(['The user lives in Berlin.']);
    // one extraction call; the decision came from Jev
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets Jev pick the memory that makes room when full', async () => {
    store.entries = [entry('a', 'one'), entry('b', 'two'), entry('c', 'three')];
    const { model } = llm('{"memories": ["The user speaks German."]}');
    const change = await rememberFromMessages(['ich spreche Deutsch'], {
      llm: model,
      jevApiKey: 'sk-or-test',
      fetchImpl: jev({ decision: 'add', evict: '2' }),
    });
    expect(change).toEqual({ added: ['The user speaks German.'], updated: [], removed: ['two'], asked: false });
    expect(store.entries.map(e => e.content)).toEqual(['one', 'three', 'The user speaks German.']);
  });

  it('keeps everything when full and Jev deletes nothing', async () => {
    store.entries = [entry('a', 'one'), entry('b', 'two'), entry('c', 'three')];
    const { model } = llm('{"memories": ["The user speaks German."]}');
    const change = await rememberFromMessages(['ich spreche Deutsch'], {
      llm: model,
      jevApiKey: 'sk-or-test',
      fetchImpl: jev({ decision: 'add', evict: 'none' }),
    });
    expect(change.added).toEqual([]);
    expect(store.entries.map(e => e.content)).toEqual(['one', 'two', 'three']);
  });

  it('rewrites the memory the new fact corrects', async () => {
    store.entries = [entry('a', 'The user lives in Berlin.')];
    const { model } = llm('{"memories": ["The user lives in Munich."]}');
    const change = await rememberFromMessages(['I moved to Munich'], {
      llm: model,
      jevApiKey: 'sk-or-test',
      fetchImpl: jev({ decision: 'replace_1' }),
    });
    expect(change.updated).toEqual(['The user lives in Munich.']);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ id: 'a', content: 'The user lives in Munich.' });
  });

  it('asks the LLM when there is no Jev key, and when Jev fails', async () => {
    const noKey = llm('{"memories": ["The user lives in Berlin."]}', '{"decision": "add"}');
    expect((await rememberFromMessages(['I live in Berlin'], { llm: noKey.model })).added).toHaveLength(1);
    expect(noKey.invoke).toHaveBeenCalledTimes(2);

    const jevDown = llm('{"memories": ["The user speaks German."]}', '{"decision": "add"}');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const change = await rememberFromMessages(['ich spreche Deutsch'], {
      llm: jevDown.model,
      jevApiKey: 'sk-or-test',
      fetchImpl,
    });
    expect(change.added).toEqual(['The user speaks German.']);
    expect(jevDown.invoke).toHaveBeenCalledTimes(2);
  });

  it('gives the extractor the earlier messages and attached files, and reports a request to remember', async () => {
    const { model, invoke } = llm(
      '{"asked": true, "memories": ["The user studied at TU Berlin."]}',
      '{"decision": "add"}',
    );
    const change = await rememberFromMessages(['remember this'], {
      llm: model,
      earlier: ['this is my resume'],
      attachments: 'Studied at TU Berlin',
    });
    expect(change).toEqual({ added: ['The user studied at TU Berlin.'], updated: [], removed: [], asked: true });
    const input = extractorInput(invoke);
    expect(input).toEqual({
      stored_memories: [],
      user_messages: ['remember this'],
      earlier_user_messages: ['this is my resume'],
      attached_files: 'Studied at TU Berlin',
    });
  });

  it('reports a request to remember that stored nothing', async () => {
    const { model } = llm('{"asked": true, "memories": []}');
    const change = await rememberFromMessages(['remember'], { llm: model });
    expect(change).toEqual({ added: [], updated: [], removed: [], asked: true });
  });
});

describe('rememberFromText', () => {
  it('stores the facts the model picks out, not the text', async () => {
    const { model, invoke } = llm(
      '{"memories": ["The user studied at TU Berlin.", "The user knows Rust and Python."]}',
      '{"decision": "add"}',
      '{"decision": "add"}',
    );
    const text = '# Resume\n\n**Education:** TU Berlin\n**Skills:**\n- Rust\n- Python';
    const change = await rememberFromText(text, { llm: model });
    expect(change.added).toEqual(['The user studied at TU Berlin.', 'The user knows Rust and Python.']);
    expect(store.entries.map(e => e.content)).toEqual(change.added);
    expect(extractorInput(invoke)).toEqual({
      stored_memories: [],
      text,
    });
  });

  it('stores nothing when the model finds nothing, and does not call it for empty text', async () => {
    const nothing = llm('{"memories": []}');
    expect((await rememberFromText('asdf', { llm: nothing.model })).added).toEqual([]);
    const empty = llm();
    await rememberFromText('  ', { llm: empty.model });
    expect(empty.invoke).not.toHaveBeenCalled();
    expect(store.entries).toEqual([]);
  });
});

describe('memoryInstructions', () => {
  it('has the agents acknowledge without talking about the memory, and say when it is off', () => {
    expect(memoryInstructions(true, true)).toContain('Do not talk about the memory');
    expect(memoryInstructions(true, false)).toContain('"Remember automatically" is turned off');
    expect(memoryInstructions(false, true)).toContain('Memory is turned off');
  });
});
