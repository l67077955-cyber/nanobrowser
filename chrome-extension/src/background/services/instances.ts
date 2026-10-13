import type { StepMeta } from '@extension/storage';
import BrowserContext, { getActiveBrowserTab } from '../browser/context';
import type { Executor } from '../agent/executor';
import type { TraceRecorder } from './trace/recorder';
import type { ExecutionState } from '../agent/event/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLogger } from '../log';

const logger = createLogger('instances');

/** the question or approval a task asked for last, for a side panel opened while it still waits to ask again */
export type WaitingFor = { state: ExecutionState; details: string; meta?: StepMeta };

/**
 * One agent at work on a chat: who asked for it (a side panel, an agent through the bridge, a schedule), the
 * executor running it and the tabs it works in. Several run side by side, each in tabs of its own.
 */
export type Instance = {
  taskId: string;
  source: 'panel' | 'remote' | 'scheduled';
  browserContext: BrowserContext;
  executor: Executor | null;
  /** the Planner model of the executor: it also reads the user's messages for things to remember */
  memoryLLM: BaseChatModel | null;
  /** the settings the executor was set up with, as counted by settingsVersion */
  settingsVersion: number;
  /**
   * The side panel or window that shows the task and, for a panel's task, saves its steps to the chat. The task
   * goes on when it is closed: until another one opens, the steps are saved here instead.
   */
  viewer: chrome.runtime.Port | null;
  waitingFor: WaitingFor | null;
  /** from the moment the task is asked for until its run has ended, set up included */
  active: boolean;
  /** the run under way, until it has ended */
  run: Promise<void> | null;
  /** a browser window opened for this agent alone, as another agent worked in the one it would have used */
  windowId: number | null;
  /** what an agent on the bridge asked for */
  remoteTask?: string;
  /** the chat's debug trace, while traces are kept */
  trace: TraceRecorder | null;
};

/** The agents, by the id of their task (the chat's id for a panel's task) */
export const instances = new Map<string, Instance>();
/** At most this many agents run at once: each one costs model calls and a browser window */
export const MAX_RUNNING = 4;
/** Ended agents of panel chats kept for a follow-up to go on with, besides those a panel shows */
export const MAX_IDLE = 8;
/** Side panels and windows connected, each with the task it shows */
export const panels = new Map<chrome.runtime.Port, string | null>();

export function newInstance(
  taskId: string,
  source: Instance['source'],
  browserContext: BrowserContext = new BrowserContext({}),
): Instance {
  const instance: Instance = {
    taskId,
    source,
    browserContext,
    executor: null,
    memoryLLM: null,
    settingsVersion: -1,
    viewer: null,
    waitingFor: null,
    active: false,
    run: null,
    windowId: null,
    trace: null,
  };
  instances.set(taskId, instance);
  return instance;
}

export function runningInstances(): Instance[] {
  return [...instances.values()].filter(instance => instance.active);
}

/** The agent of the task a side panel shows */
export function shownInstance(port: chrome.runtime.Port): Instance | undefined {
  const taskId = panels.get(port);
  return taskId ? instances.get(taskId) : undefined;
}

/** Shows the task in the panel; the agent it showed before goes on, now without it */
export function showIn(port: chrome.runtime.Port, instance: Instance): void {
  const before = shownInstance(port);
  if (before && before !== instance && before.viewer === port) before.viewer = null;
  instance.viewer = port;
  panels.set(port, instance.taskId);
}

/** Drops ended agents nothing shows, oldest first, past the few kept for a follow-up */
export function pruneInstances(): void {
  const idle = [...instances.values()].filter(instance => !instance.active && !instance.viewer);
  for (const instance of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) instances.delete(instance.taskId);
}

/** The windows the other running agents work in */
async function windowsInUse(except: Instance): Promise<Set<number>> {
  const windowIds = new Set<number>();
  for (const other of runningInstances()) {
    if (other === except) continue;
    if (other.windowId !== null) windowIds.add(other.windowId);
    const tabId = other.browserContext.currentTabId;
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (tab) windowIds.add(tab.windowId);
  }
  return windowIds;
}

/** placements one at a time: two at once would each find the other's window free */
let placing: Promise<unknown> = Promise.resolve();

/**
 * Where an agent works: in its own window while that is open; else on the tab it was asked from, or the one
 * in front, unless another agent works in that window. Two agents in one window would keep taking its tabs
 * from each other, so the second gets a window of its own, opened on the same page.
 */
export function placeInstance(instance: Instance, tabId?: number): Promise<void> {
  const placed = placing.then(() => place(instance, tabId));
  placing = placed.catch(() => {});
  return placed;
}

async function place(instance: Instance, tabId?: number): Promise<void> {
  const context = instance.browserContext;
  if (instance.windowId !== null) {
    const own = await chrome.windows.get(instance.windowId, { populate: true }).catch(() => null);
    if (own) {
      const current = context.currentTabId;
      if (!current || !own.tabs?.some(tab => tab.id === current)) {
        const front = own.tabs?.find(tab => tab.active) ?? own.tabs?.[0];
        if (front?.id) context.updateCurrentTabId(front.id);
      }
      return;
    }
    instance.windowId = null;
  }
  const busy = await windowsInUse(instance);
  const wanted = context.currentTabId ?? tabId ?? (await getActiveBrowserTab())?.id;
  const tab = wanted ? await chrome.tabs.get(wanted).catch(() => null) : null;
  if (!busy.size || (tab && !busy.has(tab.windowId))) {
    // the tab is taken now, before the agent first reads the page, so that an agent started meanwhile sees it in use
    if (tab?.id && !context.currentTabId) context.updateCurrentTabId(tab.id);
    return;
  }
  const url = tab?.url && /^https?:/i.test(tab.url) ? tab.url : 'about:blank';
  const window = await chrome.windows.create({ url, focused: false, state: 'normal' });
  instance.windowId = window?.id ?? null;
  const newTabId = window?.tabs?.[0]?.id;
  if (newTabId) {
    context.updateCurrentTabId(newTabId);
    // the window is the agent's: it may navigate its tab like one it opened itself
    await context.adoptOpenedTab(newTabId, undefined);
  }
  logger.info('agent', instance.taskId, 'works in a window of its own', instance.windowId);
}
