import { type ScheduledTask, nextRun, scheduleStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('Scheduler');

const ALARM_PREFIX = 'schedule:';
/** a run that finds the browser busy with another task is tried again this much later */
const BUSY_RETRY_MS = 2 * 60_000;

export interface ScheduledRunEnd {
  status: NonNullable<ScheduledTask['lastStatus']>;
  result: string;
  sessionId?: string;
}

/** Runs one scheduled task; resolves when it has ended, or with null when the browser is busy */
export type RunScheduled = (task: ScheduledTask) => Promise<ScheduledRunEnd | null>;

/**
 * Keeps one chrome alarm per enabled scheduled task, at its next run. Alarms are not guaranteed to
 * survive a browser restart, so they are set again from storage whenever the service worker starts;
 * a run missed while the browser was closed then happens once, soon after it opens.
 */
export class Scheduler {
  private readonly running = new Set<string>();

  constructor(private readonly run: RunScheduled) {}

  start(): void {
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name.startsWith(ALARM_PREFIX)) void this.fire(alarm.name.slice(ALARM_PREFIX.length));
    });
    scheduleStore.subscribe(() => void this.sync());
    void this.sync();
  }

  /** Make the alarms match the stored tasks */
  async sync(): Promise<void> {
    try {
      const tasks = await scheduleStore.getAll();
      const alarms = await chrome.alarms.getAll();
      const wanted = new Map<string, number>();
      for (const task of tasks) {
        if (!task.enabled || task.nextRunAt === null) continue;
        // a time already past (the browser was closed) runs a few seconds from now
        wanted.set(`${ALARM_PREFIX}${task.id}`, Math.max(task.nextRunAt, Date.now() + 5_000));
      }
      for (const alarm of alarms) {
        if (alarm.name.startsWith(ALARM_PREFIX) && !wanted.has(alarm.name)) await chrome.alarms.clear(alarm.name);
      }
      for (const [name, when] of wanted) {
        const existing = alarms.find(alarm => alarm.name === name);
        if (existing && Math.abs(existing.scheduledTime - when) < 1_000) continue;
        await chrome.alarms.create(name, { when });
      }
    } catch (error) {
      logger.error('Failed to set the alarms:', error);
    }
  }

  private async fire(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const task = await scheduleStore.get(id);
    if (!task || !task.enabled) return;
    this.running.add(id);
    try {
      const startedAt = Date.now();
      const end = await this.run(task);
      if (!end) {
        logger.info('Browser busy, trying again later', id);
        await scheduleStore.update(id, { nextRunAt: Date.now() + BUSY_RETRY_MS });
        return;
      }
      await scheduleStore.update(id, {
        lastRunAt: startedAt,
        lastStatus: end.status,
        lastResult: end.result.slice(0, 2000),
        lastSessionId: end.sessionId,
        nextRunAt: nextRun(task.repeat, Date.now()),
        // a one-off task that has run is kept, switched off, so its result can still be found
        ...(task.repeat.kind === 'once' ? { enabled: false } : {}),
      });
    } catch (error) {
      logger.error('Scheduled run failed:', error);
      await scheduleStore.update(id, {
        lastRunAt: Date.now(),
        lastStatus: 'failed',
        lastResult: error instanceof Error ? error.message : String(error),
        nextRunAt: nextRun(task.repeat, Date.now()),
      });
    } finally {
      this.running.delete(id);
    }
  }
}
