/**
 * Remote control: other agents run tasks in this browser through a bridge process.
 *
 * A service worker cannot listen on a port, so the extension dials out to the bridge over a WebSocket and
 * the bridge offers the tasks to agents as MCP tools. The bridge sends a ping every few seconds, which also
 * keeps the service worker alive while the connection is open.
 */
import type { RemoteControlConfig } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('remote');

/** close code the bridge uses for a wrong token */
export const CLOSE_UNAUTHORIZED = 4401;
const RETRY_DELAY_MS = 5000;
/** the bridge pings every 20 s; a connection silent for this long is taken for dead */
const SILENCE_LIMIT_MS = 60_000;

export type RemoteStatus = 'off' | 'connecting' | 'connected' | 'rejected' | 'unreachable';

/** How a task run for a remote agent ended */
export interface RemoteTaskEnd {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  /** the final answer of a completed task, or why it did not complete */
  result: string;
}

export interface RemoteTaskEvent {
  taskId: string;
  actor: string;
  state: string;
  step: number;
  details: string;
  timestamp: number;
  /** with a question or an approval: what the page shows (base64 JPEG), for the user away from this browser */
  screenshot?: string;
  /** with a question: the values it asks for */
  fields?: string[];
}

/** The operating system, as the bridge names a browser by default: win, mac, linux, cros, android */
export function platformOf(userAgent: string): string {
  if (/Windows/.test(userAgent)) return 'win';
  if (/CrOS/.test(userAgent)) return 'cros';
  if (/Android/.test(userAgent)) return 'android';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac';
  if (/Linux/.test(userAgent)) return 'linux';
  return 'other';
}

/** What the bridge may ask for. A handler that throws answers the request with its message as the error. */
export type RemoteHandlers = Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

/** the part of a WebSocket this module uses, so that tests can stand in for it */
export interface RemoteSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export class RemoteControl {
  private config: RemoteControlConfig = { enabled: false, url: '', token: '' };
  private socket: RemoteSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeen = 0;
  private _status: RemoteStatus = 'off';

  constructor(
    private readonly handlers: RemoteHandlers,
    private readonly version: string,
    private readonly createSocket: (url: string) => RemoteSocket = url => new WebSocket(url) as unknown as RemoteSocket,
    private readonly platform = platformOf(globalThis.navigator?.userAgent ?? ''),
  ) {}

  get status(): RemoteStatus {
    return this._status;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Take the settings as they are now: connect, reconnect to a changed bridge, or disconnect */
  apply(config: RemoteControlConfig): void {
    const unchanged =
      config.enabled === this.config.enabled && config.url === this.config.url && config.token === this.config.token;
    this.config = { ...config };
    if (unchanged && (this.socket || !config.enabled)) return;
    this.disconnect();
    if (config.enabled) this.connect();
  }

  /** Called on a timer that outlives the service worker: reconnect when the connection is gone or silent */
  ensureConnected(now = Date.now()): void {
    if (!this.config.enabled) return;
    if (this.socket && now - this.lastSeen > SILENCE_LIMIT_MS) {
      logger.warning('bridge silent, reconnecting');
      this.disconnect();
    }
    if (!this.socket) this.connect();
  }

  sendEvent(event: RemoteTaskEvent): void {
    this.send({ type: 'event', ...event });
  }

  sendTaskEnd(end: RemoteTaskEnd): void {
    this.send({ type: 'task_end', ...end });
  }

  private connect(): void {
    if (!this.config.url || !this.config.token) {
      this._status = 'rejected';
      return;
    }
    let socket: RemoteSocket;
    try {
      socket = this.createSocket(this.config.url);
    } catch (error) {
      // an address that is not a WebSocket one
      logger.warning('cannot open the bridge address', error);
      this._status = 'unreachable';
      return;
    }
    this.socket = socket;
    this._status = 'connecting';
    this.lastSeen = Date.now();

    socket.onopen = () => {
      if (this.socket !== socket) return;
      // the id keeps this browser apart from others on the same bridge; the name is how agents pick it
      this.send({
        type: 'hello',
        token: this.config.token,
        version: this.version,
        id: this.config.browserId || undefined,
        name: this.config.name?.trim() || this.platform,
        platform: this.platform,
      });
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      this.lastSeen = Date.now();
      void this.handleMessage(event.data);
    };
    socket.onerror = () => {
      // onclose follows and does the work
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null;
      this._status = event.code === CLOSE_UNAUTHORIZED ? 'rejected' : 'unreachable';
      logger.info('bridge connection closed', event.code);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.ensureConnected();
      }, RETRY_DELAY_MS);
    };
  }

  private disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    this._status = 'off';
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch (error) {
      logger.warning('failed to send to the bridge', error);
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    let message: { type?: string; id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (message.type) {
      case 'hello_ack':
        this._status = 'connected';
        logger.info('connected to the bridge');
        return;
      case 'ping':
        return this.send({ type: 'pong' });
      case 'request': {
        // only the methods given to the constructor, never an inherited property
        const handler = Object.hasOwn(this.handlers, String(message.method))
          ? this.handlers[String(message.method)]
          : undefined;
        if (this._status !== 'connected' || !handler) {
          return this.send({ type: 'response', id: message.id, error: `Unknown request: ${String(message.method)}` });
        }
        try {
          const params = message.params && typeof message.params === 'object' ? message.params : {};
          const result = await handler(params as Record<string, unknown>);
          return this.send({ type: 'response', id: message.id, result: result ?? null });
        } catch (error) {
          return this.send({
            type: 'response',
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
