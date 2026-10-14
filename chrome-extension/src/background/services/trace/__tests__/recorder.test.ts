import { beforeAll, describe, it, expect, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { TraceBlob, TraceEntry, TraceStore } from '@extension/storage';
import type * as Recorder from '../recorder';
import type * as Events from '../../../agent/event/types';

vi.mock('@extension/storage', () => ({ traceStore: {} }));
vi.mock('../../../log', () => ({ createLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));

// imported once the mocks above are in place
let TraceRecorder: typeof Recorder.TraceRecorder;
let redact: typeof Recorder.redact;
let AgentEvent: typeof Events.AgentEvent;
let Actors: typeof Events.Actors;
let ExecutionState: typeof Events.ExecutionState;
beforeAll(async () => {
  ({ TraceRecorder, redact } = await import('../recorder'));
  ({ AgentEvent, Actors, ExecutionState } = await import('../../../agent/event/types'));
});

/** A trace store that keeps what it is given in memory */
function memoryStore() {
  const entries: TraceEntry[] = [];
  const blobs: TraceBlob[] = [];
  const store = {
    append: vi.fn(async (_sessionId: string, more: TraceEntry[], moreBlobs: TraceBlob[]) => {
      entries.push(...more);
      blobs.push(...moreBlobs);
      return true;
    }),
  } as unknown as TraceStore;
  return { store, entries, blobs };
}

const blobValue = (blobs: TraceBlob[], hash: string | undefined) => blobs.find(blob => blob.hash === hash)?.value;

describe('TraceRecorder', () => {
  it('records each model call with the messages sent and the reply, keeping a repeated message once', async () => {
    const { store, entries, blobs } = memoryStore();
    const recorder = new TraceRecorder('chat-1', { store });
    const llm = new FakeListChatModel({ responses: ['first answer', 'second answer'] });
    llm.callbacks = [recorder.handler];
    const system = new SystemMessage('You are the navigator.');

    await llm.invoke([system, new HumanMessage('step 1')], { tags: ['navigator'] });
    await llm.invoke([system, new HumanMessage('step 2')], { tags: ['navigator'] });
    // the handler does not hold the model call up: what it records lands a moment later
    await new Promise(resolve => setTimeout(resolve, 20));
    await recorder.flush();

    const starts = entries.filter(entry => entry.kind === 'llm_start');
    const ends = entries.filter(entry => entry.kind === 'llm_end');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0]).toMatchObject({ caller: 'navigator', sessionId: 'chat-1' });
    expect(blobValue(blobs, starts[1].kind === 'llm_start' ? starts[1].messages[1] : undefined)).toMatchObject({
      type: 'human',
      content: 'step 2',
    });
    expect(blobValue(blobs, ends[1].kind === 'llm_end' ? ends[1].response : undefined)).toMatchObject({
      type: 'ai',
      content: 'second answer',
    });
    // the system message went out twice and is kept once
    const systemBlobs = blobs.filter(
      blob => (blob.value as { content?: unknown }).content === 'You are the navigator.',
    );
    expect(systemBlobs).toHaveLength(1);
  });

  it('records a failed model call with its error', async () => {
    const { store, entries } = memoryStore();
    const recorder = new TraceRecorder('chat-1', { store });
    class FailingModel extends FakeListChatModel {
      async _generate(): Promise<never> {
        throw new Error('provider overloaded');
      }
    }
    const llm = new FailingModel({ responses: [] });
    llm.callbacks = [recorder.handler];
    await expect(llm.invoke([new HumanMessage('hi')])).rejects.toThrow('provider overloaded');
    await new Promise(resolve => setTimeout(resolve, 20));
    await recorder.flush();
    expect(entries.find(entry => entry.kind === 'llm_end')).toMatchObject({
      kind: 'llm_end',
      error: expect.stringContaining('provider overloaded'),
    });
  });

  it('leaves screenshots out unless they are wanted, saying how large they were', async () => {
    const { store, blobs } = memoryStore();
    const recorder = new TraceRecorder('chat-1', { store });
    const llm = new FakeListChatModel({ responses: ['ok', 'ok'] });
    llm.callbacks = [recorder.handler];
    const image = `data:image/jpeg;base64,${'A'.repeat(4096)}`;
    const withImage = () =>
      new HumanMessage({
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: image } },
        ],
      });

    await llm.invoke([withImage()]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await recorder.flush();
    expect(JSON.stringify(blobs)).not.toContain('AAAA');
    expect(JSON.stringify(blobs)).toContain('left out of the trace');

    recorder.screenshots = true;
    await llm.invoke([withImage()]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await recorder.flush();
    expect(JSON.stringify(blobs)).toContain(image);
  });

  it('records a request to Jev and its answer, without the key, and the caller still reads the answer', async () => {
    const { store, entries, blobs } = memoryStore();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ answers: { op: 'CLICK' } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const recorder = new TraceRecorder('chat-1', { store, fetchImpl });
    const response = await recorder.fetch('https://jev.example/v1', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-secret' },
      body: JSON.stringify({ question: 'which?', apiKey: 'sk-secret' }),
    });
    expect(await response.json()).toEqual({ answers: { op: 'CLICK' } });
    await recorder.flush();
    const http = entries.find(entry => entry.kind === 'http');
    expect(http).toMatchObject({ kind: 'http', service: 'jev', status: 200, url: 'https://jev.example/v1' });
    expect(JSON.stringify([entries, blobs])).not.toContain('sk-secret');
    expect(blobValue(blobs, http?.kind === 'http' ? http.response : undefined)).toEqual({ answers: { op: 'CLICK' } });
  });

  it('records a request that failed and lets the error through', async () => {
    const { store, entries } = memoryStore();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const recorder = new TraceRecorder('chat-1', { store, fetchImpl });
    await expect(recorder.fetch('https://jev.example/v1', { body: '{}' })).rejects.toThrow('network down');
    await recorder.flush();
    expect(entries.find(entry => entry.kind === 'http')).toMatchObject({ error: 'network down' });
  });

  it('records events with all their details, the page text a step read included', async () => {
    const { store, entries } = memoryStore();
    const recorder = new TraceRecorder('chat-1', { store });
    recorder.event(
      new AgentEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, {
        taskId: 'chat-1',
        step: 3,
        maxSteps: 100,
        details: 'Clicked',
        meta: {
          kind: 'navigator',
          engine: 'llm',
          model: 'm',
          latencyMs: 5,
          actions: [],
          view: { url: 'https://a.example', title: 'A', elements: 2, screenshot: false, tabs: 0, text: 'PAGE TEXT' },
        },
      }),
    );
    await recorder.flush();
    expect(entries[0]).toMatchObject({ kind: 'event', step: 3, meta: { view: { text: 'PAGE TEXT' } } });
  });

  it('writes nothing on its own before a second has passed, then all of it in one go', async () => {
    vi.useFakeTimers();
    try {
      const { store } = memoryStore();
      const recorder = new TraceRecorder('chat-1', { store });
      recorder.task('find a flight', 'new task', {});
      recorder.task('and a hotel', 'follow-up', {});
      expect(store.append).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1100);
      expect(store.append).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes again a body whose write failed, with the next entry', async () => {
    const { store, blobs } = memoryStore();
    vi.mocked(store.append).mockRejectedValueOnce(new Error('quota'));
    const fetchImpl = async () => new Response('{"a":1}');
    const recorder = new TraceRecorder('chat-1', { store, fetchImpl });
    await recorder.fetch('https://jev.example', { body: '{"q":1}' });
    await recorder.flush();
    expect(blobs).toHaveLength(0);
    await recorder.fetch('https://jev.example', { body: '{"q":1}' });
    await recorder.flush();
    expect(blobs.some(blob => JSON.stringify(blob.value) === '{"q":1}')).toBe(true);
  });

  it('stops once its trace was deleted elsewhere, instead of writing entries that point at bodies gone with it', async () => {
    const { store } = memoryStore();
    const recorder = new TraceRecorder('chat-1', { store });
    recorder.task('find a flight', 'new task', {});
    await recorder.flush();
    expect(vi.mocked(store.append).mock.calls[0][3]).toBe(false);

    // the chat was deleted, or its trace cleared in the settings
    vi.mocked(store.append).mockResolvedValueOnce(false);
    recorder.task('and a hotel', 'follow-up', {});
    await recorder.flush();
    expect(vi.mocked(store.append).mock.calls[1][3]).toBe(true);
    expect(recorder.stopped).toBe(true);

    recorder.task('and a car', 'follow-up', {});
    await recorder.flush();
    expect(store.append).toHaveBeenCalledTimes(2);
  });
});

describe('redact', () => {
  it('drops keys and credentials wherever they are, and keeps the rest', () => {
    expect(
      redact({
        model: 'gpt',
        apiKey: 'sk-1',
        nested: { Authorization: 'Bearer x', max_tokens: 10, fastModeApiKey: 'jev-key', list: [{ secret: 's' }] },
      }),
    ).toEqual({
      model: 'gpt',
      apiKey: '[redacted]',
      nested: {
        Authorization: '[redacted]',
        max_tokens: 10,
        fastModeApiKey: '[redacted]',
        list: [{ secret: '[redacted]' }],
      },
    });
  });

  it('survives cycles and leaves functions out', () => {
    const value: Record<string, unknown> = { a: 1, run: () => 1 };
    value.self = value;
    expect(redact(value)).toEqual({ a: 1, self: '[circular]' });
  });
});
