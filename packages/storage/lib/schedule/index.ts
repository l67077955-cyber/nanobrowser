import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/** When a scheduled task runs. Times are "HH:MM" in the browser's own time zone. */
export type Repeat =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  /** day: 0 is Sunday */
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'interval'; minutes: number };

export interface ScheduledTask {
  id: string;
  /** what the agent is asked to do, in the user's words */
  task: string;
  repeat: Repeat;
  enabled: boolean;
  createdAt: number;
  /** null once a one-off task has run */
  nextRunAt: number | null;
  lastRunAt?: number;
  lastStatus?: 'completed' | 'failed' | 'cancelled';
  /** the answer of the last run, or why it failed */
  lastResult?: string;
  /** the chat the last run was written into */
  lastSessionId?: string;
}

/** Shorter intervals would keep the browser busy for little gain */
export const MIN_INTERVAL_MINUTES = 5;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseTime(text: string): string | null {
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

function parseMinutes(text: string): number | null {
  const match = text.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2].startsWith('h') ? amount * 60 : amount;
}

/**
 * Read a schedule in the small grammar the planner writes:
 * "daily 09:00", "weekdays 08:30", "weekly mon 09:00", "every 30m", "every 2h", "in 20m",
 * "once 2026-10-02 09:00". Returns null for anything else.
 */
export function parseRepeat(text: string, now = Date.now()): Repeat | null {
  const words = text.trim().toLowerCase().split(/\s+/);
  const [kind, ...rest] = words;
  switch (kind) {
    case 'daily':
    case 'weekdays': {
      const time = parseTime(rest.join(''));
      return time ? { kind, time } : null;
    }
    case 'weekly': {
      const day = DAYS.indexOf((rest[0] ?? '').slice(0, 3));
      const time = parseTime(rest[1] ?? '');
      return day >= 0 && time ? { kind, day, time } : null;
    }
    case 'every': {
      const minutes = parseMinutes(rest.join(''));
      return minutes ? { kind: 'interval', minutes: Math.max(MIN_INTERVAL_MINUTES, minutes) } : null;
    }
    case 'in': {
      const minutes = parseMinutes(rest.join(''));
      return minutes ? { kind: 'once', at: now + minutes * 60_000 } : null;
    }
    case 'once': {
      const match = rest.join(' ').match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}:\d{2})$/);
      const time = match && parseTime(match[4]);
      if (!match || !time) return null;
      const [hours, minutes] = time.split(':').map(Number);
      const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hours, minutes).getTime();
      return Number.isNaN(at) ? null : { kind: 'once', at };
    }
    default:
      return null;
  }
}

/** The first time after `after` the task is due, or null when it never is again */
export function nextRun(repeat: Repeat, after = Date.now()): number | null {
  if (repeat.kind === 'once') return repeat.at > after ? repeat.at : null;
  if (repeat.kind === 'interval') return after + repeat.minutes * 60_000;
  const [hours, minutes] = repeat.time.split(':').map(Number);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setHours(hours, minutes);
  // eight days covers every weekly or weekday case
  for (let i = 0; i < 8; i++) {
    const day = candidate.getDay();
    const fits =
      repeat.kind === 'daily' ||
      (repeat.kind === 'weekdays' && day >= 1 && day <= 5) ||
      (repeat.kind === 'weekly' && day === repeat.day);
    if (fits && candidate.getTime() > after) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes);
  }
  return null;
}

/** "Every weekday at 08:30", in English for the settings and the chat */
export function describeRepeat(repeat: Repeat): string {
  switch (repeat.kind) {
    case 'once':
      return `Once, ${new Date(repeat.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    case 'daily':
      return `Every day at ${repeat.time}`;
    case 'weekdays':
      return `Every weekday at ${repeat.time}`;
    case 'weekly':
      return `Every ${DAY_NAMES[repeat.day]} at ${repeat.time}`;
    case 'interval':
      return repeat.minutes % 60 === 0
        ? `Every ${repeat.minutes === 60 ? 'hour' : `${repeat.minutes / 60} hours`}`
        : `Every ${repeat.minutes} minutes`;
  }
}

interface ScheduleState {
  tasks: ScheduledTask[];
}

const storage = createStorage<ScheduleState>(
  'scheduled-tasks',
  { tasks: [] },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const scheduleStore = {
  subscribe: storage.subscribe,

  async getAll(): Promise<ScheduledTask[]> {
    return (await storage.get())?.tasks ?? [];
  },

  async get(id: string): Promise<ScheduledTask | undefined> {
    return (await this.getAll()).find(task => task.id === id);
  },

  async add(task: string, repeat: Repeat): Promise<ScheduledTask> {
    const now = Date.now();
    const entry: ScheduledTask = {
      id: crypto.randomUUID(),
      task: task.trim(),
      repeat,
      enabled: true,
      createdAt: now,
      nextRunAt: nextRun(repeat, now),
    };
    await storage.set(prev => ({ tasks: [...(prev?.tasks ?? []), entry] }));
    return entry;
  },

  async update(id: string, change: Partial<Omit<ScheduledTask, 'id'>>): Promise<void> {
    await storage.set(prev => ({
      tasks: (prev?.tasks ?? []).map(task => (task.id === id ? { ...task, ...change } : task)),
    }));
  },

  async remove(id: string): Promise<void> {
    await storage.set(prev => ({ tasks: (prev?.tasks ?? []).filter(task => task.id !== id) }));
  },
};
