import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import { looksSecret } from './secrets';

export { looksSecret };

/** A fact about the user, kept across tasks and given to the agents at the start of every task */
export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface MemoryState {
  entries: MemoryEntry[];
}

/** Once this many are stored, a new memory has to replace an old one */
export const MAX_MEMORIES = 50;

const storage = createStorage<MemoryState>(
  'user-memories',
  { entries: [] },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const memoryStore = {
  subscribe: storage.subscribe,

  async getAll(): Promise<MemoryEntry[]> {
    return (await storage.get())?.entries ?? [];
  },

  /** Returns null without storing when the text looks like a credential */
  async add(content: string): Promise<MemoryEntry | null> {
    if (looksSecret(content)) return null;
    const now = Date.now();
    const entry: MemoryEntry = { id: crypto.randomUUID(), content: content.trim(), createdAt: now, updatedAt: now };
    await storage.set(prev => ({ entries: [...(prev?.entries ?? []), entry] }));
    return entry;
  },

  /** Returns false without storing when the text looks like a credential */
  async update(id: string, content: string): Promise<boolean> {
    if (looksSecret(content)) return false;
    await storage.set(prev => ({
      entries: (prev?.entries ?? []).map(e =>
        e.id === id ? { ...e, content: content.trim(), updatedAt: Date.now() } : e,
      ),
    }));
    return true;
  },

  async remove(id: string): Promise<void> {
    await storage.set(prev => ({ entries: (prev?.entries ?? []).filter(e => e.id !== id) }));
  },

  async clear(): Promise<void> {
    await storage.set({ entries: [] });
  },
};
