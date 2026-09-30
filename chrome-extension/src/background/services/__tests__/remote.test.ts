import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CLOSE_UNAUTHORIZED, RemoteControl, type RemoteHandlers, type RemoteSocket } from '../remote';

class FakeSocket implements RemoteSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  /** what the bridge says */
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const CONFIG = { enabled: true, url: 'ws://localhost:8787/extension', token: 'secret-token' };

function setup(handlers: RemoteHandlers = {}) {
  const sockets: FakeSocket[] = [];
  const remote = new RemoteControl(handlers, '0.1.13', url => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  });
  return { remote, sockets };
}

/** Let the handlers the message set off run */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('RemoteControl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays off until it is enabled', () => {
    const { remote, sockets } = setup();
    remote.apply({ ...CONFIG, enabled: false });
    remote.ensureConnected();
    expect(sockets).toHaveLength(0);
    expect(remote.status).toBe('off');
  });

  it('presents the token and is connected once the bridge accepts it', () => {
    const { remote, sockets } = setup();
    remote.apply(CONFIG);
    expect(remote.status).toBe('connecting');
    sockets[0].onopen?.();
    expect(sockets[0].sent).toEqual([{ type: 'hello', token: 'secret-token', version: '0.1.13' }]);
    sockets[0].receive({ type: 'hello_ack' });
    expect(remote.status).toBe('connected');
  });

  it('does not connect without a token', () => {
    const { remote, sockets } = setup();
    remote.apply({ ...CONFIG, token: '' });
    expect(sockets).toHaveLength(0);
    expect(remote.status).toBe('rejected');
  });

  it('answers a request with what the handler returns, or with its error', async () => {
    const { remote, sockets } = setup({
      run_task: async params => ({ taskId: `id-for-${params.task}` }),
      cancel_task: async () => {
        throw new Error('No running task');
      },
    });
    remote.apply(CONFIG);
    sockets[0].receive({ type: 'hello_ack' });

    sockets[0].receive({ type: 'request', id: 1, method: 'run_task', params: { task: 'a' } });
    sockets[0].receive({ type: 'request', id: 2, method: 'cancel_task', params: {} });
    sockets[0].receive({ type: 'request', id: 3, method: 'toString' });
    await settle();
    // the unknown one is answered at once, the others when their handler is through
    expect([...sockets[0].sent].sort((a, b) => Number(a.id) - Number(b.id))).toEqual([
      { type: 'response', id: 1, result: { taskId: 'id-for-a' } },
      { type: 'response', id: 2, error: 'No running task' },
      { type: 'response', id: 3, error: 'Unknown request: toString' },
    ]);
  });

  it('runs nothing for a bridge that has not accepted the token', async () => {
    const run = vi.fn(async () => ({}));
    const { remote, sockets } = setup({ run_task: run });
    remote.apply(CONFIG);
    sockets[0].receive({ type: 'request', id: 1, method: 'run_task', params: { task: 'a' } });
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('answers pings', () => {
    const { remote, sockets } = setup();
    remote.apply(CONFIG);
    sockets[0].receive({ type: 'ping' });
    expect(sockets[0].sent).toEqual([{ type: 'pong' }]);
  });

  it('tells a refused token from an unreachable bridge, and tries again', () => {
    const { remote, sockets } = setup();
    remote.apply(CONFIG);
    sockets[0].onclose?.({ code: CLOSE_UNAUTHORIZED });
    expect(remote.status).toBe('rejected');

    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(2);
    sockets[1].onclose?.({ code: 1006 });
    expect(remote.status).toBe('unreachable');
  });

  it('reconnects to a bridge that went silent', () => {
    const { remote, sockets } = setup();
    remote.apply(CONFIG);
    sockets[0].receive({ type: 'hello_ack' });

    remote.ensureConnected(Date.now() + 30_000);
    expect(sockets).toHaveLength(1);
    remote.ensureConnected(Date.now() + 61_000);
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it('reconnects when the address or token changes, and disconnects when turned off', () => {
    const { remote, sockets } = setup();
    remote.apply(CONFIG);
    remote.apply({ ...CONFIG });
    expect(sockets).toHaveLength(1);

    remote.apply({ ...CONFIG, token: 'another-token' });
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);

    remote.apply({ ...CONFIG, enabled: false });
    expect(sockets[1].closed).toBe(true);
    expect(remote.status).toBe('off');
    // a late close of the old socket does not bring the connection back
    sockets[1].onclose?.({ code: 1000 });
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(2);
  });

  it('reports task events and ends to the bridge', () => {
    const { remote, sockets } = setup();
    remote.apply(CONFIG);
    sockets[0].receive({ type: 'hello_ack' });
    remote.sendEvent({ taskId: 't', actor: 'navigator', state: 'act.ok', step: 1, details: 'clicked', timestamp: 5 });
    remote.sendTaskEnd({ taskId: 't', status: 'completed', result: 'done' });
    expect(sockets[0].sent).toEqual([
      { type: 'event', taskId: 't', actor: 'navigator', state: 'act.ok', step: 1, details: 'clicked', timestamp: 5 },
      { type: 'task_end', taskId: 't', status: 'completed', result: 'done' },
    ]);
  });
});
