import type { TraceBlob, TraceEntry, TraceSessionInfo, TraceStore } from './types';

/**
 * Traces live in IndexedDB rather than chrome.storage: a task's trace runs to megabytes (every model call
 * with its prompt), and IndexedDB adds entries without reading and writing back all that came before.
 * The service worker and the extension's pages share it, as they share an origin.
 */
const DB_NAME = 'nanobrowser-trace';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const BLOBS = 'blobs';
const SESSIONS = 'sessions';

type StoredEntry = TraceEntry & { seq?: number };
type StoredBlob = TraceBlob & { key: string };

const blobKey = (sessionId: string, hash: string) => `${sessionId}\u0000${hash}`;
const blobRange = (sessionId: string) => IDBKeyRange.bound(`${sessionId}\u0000`, `${sessionId}\u0000￿`);

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The trace transaction was aborted'));
  });
}

let opened: Promise<IDBDatabase> | null = null;

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  if (!opened) {
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const entries = db.createObjectStore(ENTRIES, { keyPath: 'seq', autoIncrement: true });
        entries.createIndex('sessionId', 'sessionId');
        db.createObjectStore(BLOBS, { keyPath: 'key' });
        db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // another context upgrading the database closes this one; the next call opens it again
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    opened.catch(() => {
      opened = null;
    });
  }
  return opened;
}

export function createTraceStore(factory: IDBFactory | undefined = globalThis.indexedDB): TraceStore {
  const db = () => {
    if (!factory) return Promise.reject(new Error('IndexedDB is not available here'));
    return openDb(factory);
  };

  async function deleteSessions(sessionIds: string[]): Promise<void> {
    if (!sessionIds.length) return;
    const tx = (await db()).transaction([ENTRIES, BLOBS, SESSIONS], 'readwrite');
    const index = tx.objectStore(ENTRIES).index('sessionId');
    for (const sessionId of sessionIds) {
      const keys = await request(index.getAllKeys(IDBKeyRange.only(sessionId)));
      for (const key of keys) tx.objectStore(ENTRIES).delete(key);
      tx.objectStore(BLOBS).delete(blobRange(sessionId));
      tx.objectStore(SESSIONS).delete(sessionId);
    }
    await done(tx);
  }

  return {
    async append(sessionId, entries, blobs, continuing = false) {
      if (!entries.length && !blobs.length) return true;
      const tx = (await db()).transaction([ENTRIES, BLOBS, SESSIONS], 'readwrite');
      const sessions = tx.objectStore(SESSIONS);
      const info = (await request(sessions.get(sessionId))) as TraceSessionInfo | undefined;
      if (continuing && !info) {
        tx.abort();
        return false;
      }
      for (const entry of entries) tx.objectStore(ENTRIES).add({ ...entry, sessionId });
      for (const blob of blobs) {
        tx.objectStore(BLOBS).put({ key: blobKey(sessionId, blob.hash), ...blob } satisfies StoredBlob);
      }
      const now = Date.now();
      sessions.put({
        sessionId,
        startedAt: info?.startedAt ?? entries[0]?.t ?? now,
        updatedAt: now,
        entries: (info?.entries ?? 0) + entries.length,
      } satisfies TraceSessionInfo);
      await done(tx);
      return true;
    },

    async getEntries(sessionId) {
      const tx = (await db()).transaction(ENTRIES, 'readonly');
      const entries = (await request(
        tx.objectStore(ENTRIES).index('sessionId').getAll(IDBKeyRange.only(sessionId)),
      )) as StoredEntry[];
      return entries
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .map(({ seq, ...entry }) => entry as TraceEntry);
    },

    async getBlobs(sessionId) {
      const tx = (await db()).transaction(BLOBS, 'readonly');
      const blobs = (await request(tx.objectStore(BLOBS).getAll(blobRange(sessionId)))) as StoredBlob[];
      return Object.fromEntries(blobs.map(blob => [blob.hash, blob.value]));
    },

    async listSessions() {
      const tx = (await db()).transaction(SESSIONS, 'readonly');
      const sessions = (await request(tx.objectStore(SESSIONS).getAll())) as TraceSessionInfo[];
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    deleteSession: sessionId => deleteSessions([sessionId]),

    async prune(keep) {
      const sessions = await this.listSessions();
      await deleteSessions(sessions.slice(keep).map(session => session.sessionId));
    },

    async clear() {
      const tx = (await db()).transaction([ENTRIES, BLOBS, SESSIONS], 'readwrite');
      for (const name of [ENTRIES, BLOBS, SESSIONS]) tx.objectStore(name).clear();
      await done(tx);
    },
  };
}

export const traceStore = createTraceStore();
