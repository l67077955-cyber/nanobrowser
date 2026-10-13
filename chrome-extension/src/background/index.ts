import 'webextension-polyfill';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
  analyticsSettingsStore,
  memoryStore,
  chatHistoryStore,
  captchaModelStore,
  remoteControlStore,
  traceStore,
  type GeneralSettingsConfig,
  type ScheduledTask,
  type ActionMode,
} from '@extension/storage';
import { t } from '@extension/i18n';
import BrowserContext from './browser/context';
import { setupStandaloneWindow } from './services/standaloneWindow';
import { noticeTask, setupTaskNotices } from './services/taskNotice';
import { Executor, type ExecutorSnapshot } from './agent/executor';
import { snapshotFromChat } from './agent/resume';
import { createLogger } from './log';
import { Actors, ExecutionState, type AgentEvent } from './agent/event/types';
import { createChatModel } from './agent/helper';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DEFAULT_AGENT_OPTIONS } from './agent/types';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { analytics } from './services/analytics';
import { formatMemoryContext, memoryInstructions, rememberFromMessages, rememberFromText } from './services/memory';
import { RemoteControl, type RemoteTaskEnd } from './services/remote';
import { Scheduler, type ScheduledRunEnd } from './services/scheduler';
import { saveUnattended, unattendedSaved } from './services/unattended';
import { MAX_TRACED_SESSIONS, TraceRecorder } from './services/trace/recorder';
import { exportChat, importChat, readChatFile } from './services/export';
import type { ExportFormat } from './services/export/formats';
import {
  type Instance,
  instances,
  MAX_RUNNING,
  newInstance,
  panels,
  placeInstance,
  pruneInstances,
  runningInstances,
  showIn,
  shownInstance,
} from './services/instances';

const logger = createLogger('background');

/** for the commands that need a page when no agent is at hand */
const spareContext = new BrowserContext({});

/** The window of Nanobrowser's own that shows the agent's task; a docked side panel has none */
function panelWindowOf(instance: Instance): number | undefined {
  return instance.viewer?.sender?.tab?.windowId;
}

/** The agent cannot start: as many as may run at once are running */
function tooManyAgents(): Error {
  return new Error(t('bg_errors_tooManyAgents', [String(MAX_RUNNING)]));
}

const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');
const OPTIONS_URL = chrome.runtime.getURL('options/index.html');

// The toolbar icon opens the side panel, or a window of its own if set so
setupStandaloneWindow();
setupTaskNotices();

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// Listen for debugger detached event
// if canceled_by_user, stop the agent that worked in the tab
chrome.debugger.onDetach.addListener(async (source, reason) => {
  logger.info('Debugger detached:', source, reason);
  if (!source.tabId) return;
  // whatever the reason, the page of that tab has no debugger any more
  for (const instance of instances.values()) instance.browserContext.forgetAttachedPage(source.tabId);
  spareContext.forgetAttachedPage(source.tabId);
  if (reason === 'canceled_by_user') {
    for (const instance of instances.values()) {
      if (instance.browserContext.currentTabId !== source.tabId) continue;
      instance.executor?.cancel();
      await instance.browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  for (const instance of instances.values()) instance.browserContext.removeAttachedPage(tabId);
  spareContext.removeAttachedPage(tabId);
});

// an agent whose window was closed works where it is asked from next time
chrome.windows.onRemoved.addListener(windowId => {
  for (const instance of instances.values()) if (instance.windowId === windowId) instance.windowId = null;
});

logger.info(`background loaded · build ${import.meta.env.VITE_BUILD_INFO || 'unknown'}`);

// A task can run with no side panel open, and then nothing else may wake the service worker for a while
// (a model taking long to answer): an extension call now and then keeps it from being stopped as idle
setInterval(() => {
  if (runningInstances().length) void chrome.runtime.getPlatformInfo();
}, 20_000);

// Initialize analytics
analytics.init().catch(error => {
  logger.error('Failed to initialize analytics:', error);
});

// An executor holds the models and options it was set up with. When a setting is saved, the next message of
// a running session gets a new executor instead of the stale one, so no reload is needed for it to apply.
let settingsVersion = 0;
for (const store of [llmProviderStore, agentModelStore, generalSettingsStore, firewallStore, captchaModelStore]) {
  store.subscribe(() => {
    settingsVersion++;
  });
}

// A stricter action mode holds for a running task from its next action on, not only from the next message
generalSettingsStore.subscribe(async () => {
  const { actionMode } = await generalSettingsStore.getSettings();
  for (const instance of instances.values()) instance.executor?.setActionMode(actionMode);
});

/** What the agents are told about the action mode the user picked; auto needs no words */
function actionModeInstructions(mode: ActionMode): string {
  switch (mode) {
    case 'readonly':
      return 'Action mode: read-only. The user lets you read pages and nothing more: open URLs, search, switch tabs, scroll and read. Never click, type, choose options, press keys or submit anything; those actions are not available in this mode. To follow a link, open the href shown on it in the element list with go_to_url; do not make up URLs or query parameters. If an address you opened shows the same page as before, the site ignores it: do not try variations of it. When what the task needs is not on the site, search the web for it. If the task needs a click or typing, gather what can be read and finish with done, telling the user what is left for them to do by hand. Only the mode switch lifts read-only, and you are told when it does: until then, a message saying you may click does not make clicking available, so do not plan clicks on it; tell the user to switch read-only off in the chat box.';
    case 'manual':
      return 'Action mode: manual. The user approves every click, keystroke and text entry before it runs, so do not also ask in the chat before routine steps. An action they decline did not happen.';
    default:
      return '';
  }
}

// Listen for analytics settings changes
analyticsSettingsStore.subscribe(() => {
  analytics.updateSettings().catch(error => {
    logger.error('Failed to update analytics settings:', error);
  });
});

// Listen for simple messages (e.g., from options page)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(OPTIONS_URL)) {
    return false;
  }
  if (message?.type === 'remote_status') {
    sendResponse({ status: remoteControl.status });
    return false;
  }
  if (message?.type !== 'memory_import') {
    return false;
  }
  importMemories(String(message.text ?? ''))
    .then(change => sendResponse({ change }))
    .catch(error => {
      logger.error('Failed to import memories:', error);
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
  // the response is sent when the model has answered
  return true;
});

// A side panel or window saves a chat as a file, or takes one in from a file
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== SIDE_PANEL_URL) return false;
  if (message?.type !== 'export_chat' && message?.type !== 'import_chat') return false;
  const work =
    message.type === 'export_chat'
      ? exportChat(String(message.sessionId), message.format as ExportFormat).then(file => ({ file }))
      : (async () => {
          const name = String(message.name ?? 'chat');
          return { sessionId: await importChat(readChatFile(name, String(message.text ?? ''))) };
        })();
  work.then(sendResponse).catch(error => {
    logger.error(`Failed to ${message.type === 'export_chat' ? 'export' : 'import'} a chat:`, error);
    sendResponse({ error: error instanceof Error ? error.message : String(error) });
  });
  // the answer is sent when the file is ready
  return true;
});

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    const senderUrl = port.sender?.url;
    const senderId = port.sender?.id;

    if (!senderUrl || senderId !== chrome.runtime.id || senderUrl !== SIDE_PANEL_URL) {
      logger.warning('Blocked unauthorized side-panel-connection', senderId, senderUrl);
      port.disconnect();
      return;
    }

    panels.set(port, null);
    // the dot on the toolbar icon says a task has finished since the panel was last open
    void chrome.action.setBadgeText({ text: '' });
    void attachPanel(port).catch(error => logger.error('Failed to show the running task:', error));

    port.onMessage.addListener(async message => {
      try {
        switch (message.type) {
          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });

            logger.info('new_task', message.tabId, message.task);
            // a new chat in this panel replaces the task it showed; the agents of other panels go on
            const before = shownInstance(port);
            if (before?.source === 'panel' && before.active) await before.executor?.cancel();
            if (runningInstances().length >= MAX_RUNNING) throw tooManyAgents();
            const instance = instances.get(message.taskId) ?? newInstance(message.taskId, 'panel');
            await instance.executor?.cancel();
            await startForPanel(instance, port, async () => {
              await placeInstance(instance, message.tabId);
              return setupExecutor(instance, message.task, null, { trigger: 'new task' });
            });
            logger.info('new_task execution result', message.tabId);
            break;
          }

          case 'steer': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            // a message sent while the task runs is taken in by it, as the next thing to consider
            const running = instances.get(message.taskId);
            if (running?.active && running.executor?.steer(message.task)) {
              logger.info('steer', message.task);
              break;
            }
            // the task ended in the meantime: once it has wound down, the message is a follow-up
            await running?.run?.catch(() => {});
          }
          // falls through
          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });

            // "keep going" after the run ran out of steps: the goal stays the one it was working on
            const continues = message.continues === true;
            logger.info('follow_up_task', message.tabId, message.task, continues ? '(continues)' : '');

            const instance = instances.get(message.taskId) ?? newInstance(message.taskId, 'panel');
            if (!instance.active && runningInstances().length >= MAX_RUNNING) throw tooManyAgents();
            await startForPanel(instance, port, async () => {
              const context = instance.browserContext;
              await context.resumeLastTab().catch(error => logger.warning('resumeLastTab failed', error));
              await placeInstance(instance, message.tabId);
              const executor = instance.executor;
              if (executor && !executor.stopped && instance.settingsVersion === settingsVersion) {
                if (continues) executor.continueTask(message.task);
                else executor.addFollowUpTask(message.task);
                instance.trace?.task(message.task, continues ? 'keep going' : 'follow-up', {});
                return executor;
              }
              // The executor of this session is gone (service worker restarted, dropped while idle), was
              // cancelled, or was set up before the settings changed: a new one, built from the settings as they
              // are now, goes on from what that one knew
              const snapshot = executor
                ? executor.snapshot()
                : await loadSessionSnapshot(message.taskId, message.sentAt);
              logger.info('follow_up_task: reloading the session context', snapshot?.messages.length ?? 0);
              await executor?.cancel();
              return setupExecutor(instance, message.task, snapshot, {
                continues,
                trigger: continues ? 'keep going' : 'follow-up, with a new executor',
              });
            });
            logger.info('follow_up_task execution result', message.tabId);
            break;
          }

          case 'cancel_task': {
            // the panel names its chat; a bridge's task it shows has an id of its own
            const instance = instances.get(message.taskId) ?? shownInstance(port);
            if (!instance?.executor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            if (!instance.active) {
              logger.info('cancel_task for a task no longer running, ignored', message.taskId);
              break;
            }
            logger.info('cancel_task: the user stopped the task in the side panel', instance.taskId);
            await instance.executor.cancel();
            break;
          }

          case 'resume_task': {
            const executor = shownInstance(port)?.executor;
            if (!executor) return port.postMessage({ type: 'error', error: t('bg_cmd_resumeTask_noTask') });
            await executor.resume();
            return port.postMessage({ type: 'success' });
          }

          case 'confirm_action': {
            const executor = shownInstance(port)?.executor;
            if (!executor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            executor.confirmAction(message.approved === true);
            return port.postMessage({ type: 'success' });
          }

          case 'reveal_ask': {
            // the user wants to see what the question is about: its tab, with the field in view
            await shownInstance(port)?.executor?.revealAsked(
              typeof message.field === 'number' ? message.field : undefined,
            );
            break;
          }

          case 'ask_captcha': {
            const field = Number(message.field);
            const image = await shownInstance(port)
              ?.executor?.askedCaptcha(field, message.refresh === true)
              .catch(error => {
                logger.warning('Failed to show the captcha the user is asked for:', error);
                return null;
              });
            return port.postMessage({ type: 'ask_captcha', field, image: image ?? null });
          }

          case 'pause_task': {
            const executor = shownInstance(port)?.executor;
            if (!executor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await executor.pause();
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            const page = await (shownInstance(port)?.browserContext ?? spareContext).switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              const browserState = await (shownInstance(port)?.browserContext ?? spareContext).getState(true);
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: t('bg_cmd_state_printed') });
            } catch (error) {
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: t('bg_cmd_state_failed') });
            }
          }

          case 'nohighlight': {
            const page = await (shownInstance(port)?.browserContext ?? spareContext).getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: t('bg_cmd_nohighlight_ok') });
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            if (!message.historySessionId)
              return port.postMessage({ type: 'error', error: t('bg_cmd_replay_noHistory') });
            logger.info('replay', message.tabId, message.taskId, message.historySessionId);
            if (runningInstances().length >= MAX_RUNNING) throw tooManyAgents();

            const instance = instances.get(message.taskId) ?? newInstance(message.taskId, 'panel');
            try {
              // Switch to the specified tab
              await instance.browserContext.switchTab(message.tabId);
              // Setup executor with the new taskId and a dummy task description
              await instance.executor?.cancel();
              const executor = await setupExecutor(instance, message.task, null, { trigger: 'replay' });
              instance.executor = executor;
              showIn(port, instance);
              subscribeToExecutorEvents(instance, executor);

              // Run replayHistory with the history session ID
              const result = await executor.replayHistory(message.historySessionId);
              logger.debug('replay execution result', message.tabId, result);
            } catch (error) {
              logger.error('Replay failed:', error);
              return port.postMessage({
                type: 'error',
                error: error instanceof Error ? error.message : t('bg_cmd_replay_failed'),
              });
            }
            break;
          }

          default:
            return port.postMessage({ type: 'error', error: t('errors_cmd_unknown', [message.type]) });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : t('errors_unknown'),
        });
      }
    });

    port.onDisconnect.addListener(() => {
      // also when the side panel or its window is closed: a task goes on without it
      const shown = shownInstance(port);
      logger.info('Side panel disconnected', shown?.active ? `(task from ${shown.source})` : '(no task)');
      panels.delete(port);
      for (const instance of instances.values()) if (instance.viewer === port) instance.viewer = null;
      pruneInstances();
    });
  }
});

/**
 * A side panel that opens while a task runs that no panel shows takes it over: the chat of a panel's task as
 * saved so far, then the steps as they come, and the question or approval the task waits for. A panel that
 * opens with every running task shown elsewhere starts a chat of its own.
 */
async function attachPanel(port: chrome.runtime.Port): Promise<void> {
  const unseen = runningInstances()
    .filter(instance => !instance.viewer && instance.source !== 'scheduled')
    .reverse();
  const instance = unseen.find(other => other.source === 'panel') ?? unseen[0];
  if (!instance) return;
  if (instance.source === 'remote') {
    showIn(port, instance);
    const waiting = instance.executor?.waitingForUser ? instance.waitingFor : null;
    port.postMessage({ type: 'remote_task', taskId: instance.taskId, task: instance.remoteTask, waitingFor: waiting });
    return;
  }
  await unattendedSaved();
  // the panel closed again, another one took the task, or the task ended while the steps were saved
  if (!instance.active || instance.viewer || !panels.has(port)) return;
  showIn(port, instance);
  logger.info('Side panel shows the running task', instance.taskId);
  // the planner goes on reporting while a question waits, so the last step says nothing about whether it does
  const waiting = instance.executor?.waitingForUser ? instance.waitingFor : null;
  port.postMessage({ type: 'task_attached', taskId: instance.taskId, waitingFor: waiting });
}

/**
 * Run a task a side panel asked for, in the agent of its chat, shown in that panel. `prepare` places the agent
 * and gives the executor to run; it runs once the agent counts as running, so that agents started together
 * each take a window of their own.
 */
async function startForPanel(
  instance: Instance,
  port: chrome.runtime.Port,
  prepare: () => Promise<Executor>,
): Promise<void> {
  instance.source = 'panel';
  instance.active = true;
  showIn(port, instance);
  instance.waitingFor = null;
  let executor: Executor;
  try {
    executor = await prepare();
  } catch (error) {
    instance.active = false;
    throw error;
  }
  instance.executor = executor;
  subscribeToExecutorEvents(instance, executor);
  const run = executor.execute().finally(() => {
    if (instance.run === run) {
      instance.run = null;
      instance.active = false;
      pruneInstances();
    }
  });
  instance.run = run;
  await run;
  void updateMemories(instance, executor);
}

/**
 * A window for a task to work in: Chrome started by the bridge runs with none, and so does one whose windows
 * were all closed while it keeps running in the background
 */
async function ensureBrowserWindow(instance: Instance): Promise<void> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length > 0) return;
  const window = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' });
  const tabId = window?.tabs?.[0]?.id;
  if (tabId) instance.browserContext.updateCurrentTabId(tabId);
}

/** How long a remote task waits for the user to answer or approve before it goes on without them */
const REMOTE_USER_WAIT_MS = 10 * 60_000;

/** What the page of a task waiting for the user shows, or nothing when it cannot be taken in a few seconds */
async function waitingScreenshot(context: BrowserContext): Promise<string | undefined> {
  try {
    const page = await context.getCurrentPage();
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 3000));
    return (await Promise.race([page.takeScreenshot(), timeout])) ?? undefined;
  } catch (error) {
    logger.warning('remote task: no screenshot for the user', error);
    return undefined;
  }
}

/** A side panel showing no running task, the latest opened first, for a bridge's task to show in */
function idlePanel(): chrome.runtime.Port | null {
  const idle = [...panels.keys()].filter(port => !shownInstance(port)?.active);
  return idle[idle.length - 1] ?? null;
}

/**
 * Start a task for an agent on the bridge and return its id; the task goes on after that and its end is
 * reported to the bridge. It runs beside the user's own tasks, in a window of its own when one of theirs
 * works in the window it would use.
 */
async function startRemoteTask(task: string): Promise<string> {
  if (runningInstances().length >= MAX_RUNNING) throw tooManyAgents();
  const taskId = `remote-${crypto.randomUUID()}`;
  const instance = newInstance(taskId, 'remote');
  instance.remoteTask = task;
  instance.active = true;
  let executor: Executor;
  try {
    await ensureBrowserWindow(instance);
    await placeInstance(instance);
    executor = await setupExecutor(instance, task, null, { trigger: 'bridge' });
  } catch (error) {
    instances.delete(taskId);
    throw error;
  }
  instance.executor = executor;
  subscribeToExecutorEvents(instance, executor);
  // a side panel with nothing running shows the task like one of its own, with its stop button
  const port = idlePanel();
  if (port) {
    showIn(port, instance);
    port.postMessage({ type: 'remote_task', taskId, task });
  }

  // A question or an approval waits for the user, who is told wherever they are; nobody answering in time
  // lets the task go on: a question is left to the navigator, an action is not taken
  let userWait: ReturnType<typeof setTimeout> | null = null;
  const stopWaiting = () => {
    if (userWait) clearTimeout(userWait);
    userWait = null;
  };
  const waitForUser = (giveUp: () => void) => {
    stopWaiting();
    userWait = setTimeout(() => {
      userWait = null;
      if (!executor.waitingForUser) return;
      logger.info('remote task: the user did not answer in time', taskId);
      giveUp();
    }, REMOTE_USER_WAIT_MS);
  };

  const end: RemoteTaskEnd = { taskId, status: 'failed', result: 'The task stopped before it was finished' };
  executor.subscribeExecutionEvents(async (event: AgentEvent) => {
    // the user may be far from this browser: a question or an approval goes out with what the page shows
    const waiting = event.state === ExecutionState.ACT_ASK || event.state === ExecutionState.ACT_CONFIRM;
    const screenshot = waiting ? await waitingScreenshot(instance.browserContext) : undefined;
    const meta = event.data.meta;
    const fields = meta?.kind === 'question' ? meta.fields?.map(field => field.label) : undefined;
    remoteControl.sendEvent({
      taskId,
      actor: event.actor,
      state: event.state,
      step: event.data.step,
      details: event.data.details,
      timestamp: event.timestamp,
      ...(screenshot ? { screenshot } : {}),
      ...(fields?.length ? { fields } : {}),
    });
    switch (event.state) {
      case ExecutionState.TASK_OK:
        end.status = 'completed';
        // a task that ends without an answer reports its id as the details
        end.result = event.data.details === taskId ? '' : event.data.details;
        break;
      case ExecutionState.TASK_FAIL:
      case ExecutionState.TASK_PAUSE:
        end.status = 'failed';
        end.result = event.data.details;
        break;
      case ExecutionState.TASK_CANCEL:
        end.status = 'cancelled';
        end.result = event.data.details;
        break;
      case ExecutionState.ACT_CONFIRM:
      case ExecutionState.ACT_ASK:
        instance.waitingFor = { state: event.state, details: event.data.details, meta: event.data.meta };
        void noticeTask('waiting', event.data.details, instance.browserContext.currentTabId, {
          evenInFront: !instance.viewer,
          panelWindowId: panelWindowOf(instance),
        });
        waitForUser(() =>
          event.state === ExecutionState.ACT_ASK ? executor.answerQuestion(null) : executor.confirmAction(false),
        );
        break;
    }
  });

  logger.info('remote task', taskId, task);
  const run = executor
    .execute()
    .catch(error => {
      end.status = 'failed';
      end.result = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      stopWaiting();
      instance.run = null;
      instance.active = false;
      instance.waitingFor = null;
      if (!instance.viewer) instances.delete(taskId);
      remoteControl.sendTaskEnd(end);
    });
  instance.run = run;
  return taskId;
}

/**
 * Run a scheduled task in a window of its own, behind the user's, so it neither takes over the tab they
 * are using nor stalls the way a hidden tab does. The run is written to a chat of its own, where its
 * answer can be read and the conversation carried on. Returns null when as many agents run as may.
 */
async function runScheduledTask(entry: ScheduledTask): Promise<ScheduledRunEnd | null> {
  if (runningInstances().length >= MAX_RUNNING) return null;
  const session = await chatHistoryStore.createSession(`Scheduled · ${entry.task}`.slice(0, 60));
  const taskId = session.id;
  const instance = newInstance(taskId, 'scheduled');
  instance.active = true;
  const end: ScheduledRunEnd = {
    status: 'failed',
    result: 'The task stopped before it was finished',
    sessionId: taskId,
  };
  let executor: Executor | null = null;
  try {
    const window = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' });
    instance.windowId = window?.id ?? null;
    const tabId = window?.tabs?.[0]?.id;
    if (!tabId) throw new Error('Could not open a window for the scheduled task');
    executor = await setupExecutor(instance, entry.task, null, { scheduled: true, trigger: 'schedule' });
    instance.browserContext.updateCurrentTabId(tabId);
    instance.executor = executor;
    const scheduled = executor;
    scheduled.clearExecutionEvents();
    scheduled.subscribeExecutionEvents(async (event: AgentEvent) => {
      switch (event.state) {
        case ExecutionState.TASK_OK:
          end.status = 'completed';
          end.result = event.data.details === taskId ? '' : event.data.details;
          void noticeTask('done', end.result, instance.browserContext.currentTabId);
          break;
        case ExecutionState.TASK_FAIL:
          end.status = 'failed';
          end.result = event.data.details;
          void noticeTask('failed', end.result, instance.browserContext.currentTabId);
          break;
        case ExecutionState.TASK_CANCEL:
          end.status = 'cancelled';
          end.result = event.data.details;
          break;
        case ExecutionState.ACT_CONFIRM:
          // nobody is there to approve: a step that needs approval is left for the user
          scheduled.confirmAction(false);
          break;
        case ExecutionState.ACT_ASK:
          scheduled.answerQuestion(null);
          break;
      }
    });
    await chatHistoryStore.addMessage(taskId, { actor: Actors.USER, content: entry.task, timestamp: Date.now() });
    logger.info('scheduled task', entry.id, entry.task);
    await scheduled.execute();
    void updateMemories(instance, scheduled);
  } catch (error) {
    end.result = error instanceof Error ? error.message : String(error);
  } finally {
    instance.active = false;
    instances.delete(taskId);
    await executor?.cleanup();
    if (instance.windowId !== null) await chrome.windows.remove(instance.windowId).catch(() => {});
  }
  // the answer, or what went wrong, as the panel shows it in that chat
  await chatHistoryStore
    .addMessage(
      taskId,
      end.status === 'completed'
        ? {
            actor: Actors.PLANNER,
            content: end.result || 'Done.',
            timestamp: Date.now(),
            meta: { kind: 'planner', model: '', latencyMs: 0, done: true },
          }
        : { actor: Actors.SYSTEM, content: end.result, timestamp: Date.now(), failed: end.status === 'failed' },
    )
    .catch(error => logger.error('Failed to save the scheduled run:', error));
  if (!panels.size) void chrome.action.setBadgeText({ text: '•' });
  return end;
}

new Scheduler(runScheduledTask).start();

/** The running agent of a task the bridge started */
function remoteInstance(taskId: unknown): Instance {
  const instance = typeof taskId === 'string' ? instances.get(taskId) : undefined;
  if (instance?.source !== 'remote' || !instance.active || !instance.executor) {
    throw new Error(t('bg_errors_noRunningTask'));
  }
  return instance;
}

const remoteControl = new RemoteControl(
  {
    run_task: async params => {
      const task = typeof params.task === 'string' ? params.task.trim() : '';
      if (!task) throw new Error(t('bg_cmd_newTask_noTask'));
      return { taskId: await startRemoteTask(task) };
    },
    cancel_task: async params => {
      await remoteInstance(params.taskId).executor?.cancel();
      return { cancelled: true };
    },
    // the user's reply to what a remote task waits for, passed on by the bridge from wherever they are
    answer_task: async params => {
      const instance = remoteInstance(params.taskId);
      const executor = instance.executor as Executor;
      const waiting = executor.waitingForUser ? instance.waitingFor : null;
      if (!waiting) throw new Error('The task is not waiting for the user');
      instance.waitingFor = null;
      const answer = typeof params.answer === 'string' ? params.answer.trim() : '';
      if (waiting.state === ExecutionState.ACT_CONFIRM) {
        const approved =
          typeof params.approve === 'boolean' ? params.approve : /^(y|yes|ok|approve|是|好|确认|同意)/i.test(answer);
        executor.confirmAction(approved);
        return { answered: true, approved };
      }
      executor.answerQuestion(answer);
      return { answered: true };
    },
    status: async () => {
      const running = runningInstances();
      return {
        version: chrome.runtime.getManifest().version,
        // busy: no other task can start until one of those running ends
        busy: running.length >= MAX_RUNNING,
        running: running.length,
        maxRunning: MAX_RUNNING,
        // a task of the user's own is none of the agent's business
        taskIds: running.filter(instance => instance.source === 'remote').map(instance => instance.taskId),
      };
    },
  },
  chrome.runtime.getManifest().version,
);

// The bridge connection follows the settings. The alarm outlives the service worker, so a connection lost
// while nothing else keeps the worker awake is made again.
const REMOTE_ALARM = 'remote-control';
// A bridge installed on this computer (cli.mjs install) pairs by handing over its address and token through
// native messaging. It is asked once each time the worker starts, and only while no bridge is set.
const PAIRING_HOST = 'com.nanobrowser.bridge';
let pairingAsked = false;

async function pairWithLocalBridge(): Promise<boolean> {
  if (pairingAsked) return false;
  pairingAsked = true;
  try {
    const reply = (await chrome.runtime.sendNativeMessage(PAIRING_HOST, { type: 'pair' })) as
      | { url?: unknown; token?: unknown }
      | undefined;
    if (typeof reply?.url !== 'string' || typeof reply.token !== 'string' || reply.token.length < 16) return false;
    await remoteControlStore.updateConfig({ enabled: true, url: reply.url, token: reply.token });
    logger.info('paired with the bridge on this computer');
    return true;
  } catch {
    // no bridge installed on this computer
    return false;
  }
}

let remoteApplied = Promise.resolve();
/** Settings change in quick succession: each change is applied after the one before */
function applyRemoteControl(): Promise<void> {
  remoteApplied = remoteApplied.then(applyRemoteSettings, applyRemoteSettings);
  return remoteApplied;
}

async function applyRemoteSettings() {
  let config = await remoteControlStore.getConfig();
  if (!config.token && (await pairWithLocalBridge())) config = await remoteControlStore.getConfig();
  if (config.enabled && !config.browserId) {
    await remoteControlStore.updateConfig({ browserId: crypto.randomUUID().slice(0, 8) });
    config = await remoteControlStore.getConfig();
  }
  remoteControl.apply(config);
  if (config.enabled) {
    await chrome.alarms.create(REMOTE_ALARM, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(REMOTE_ALARM);
  }
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== REMOTE_ALARM) return;
  // a worker woken by the alarm has not read the settings yet
  if (remoteControl.enabled) remoteControl.ensureConnected();
  else void applyRemoteControl();
});
remoteControlStore.subscribe(() => void applyRemoteControl());
void applyRemoteControl().catch(error => logger.error('Failed to set up remote control:', error));

/**
 * What the agents of a session knew when its last task ended; for a session without a stored context,
 * what its chat up to the message sent at `before` tells.
 */
async function loadSessionSnapshot(sessionId: string, before = Date.now()): Promise<ExecutorSnapshot | null> {
  try {
    const stored = await chatHistoryStore.loadAgentContext(sessionId);
    if (stored) return JSON.parse(stored) as ExecutorSnapshot;
    const session = await chatHistoryStore.getSession(sessionId);
    return session ? snapshotFromChat(session.messages.filter(message => message.timestamp < before)) : null;
  } catch (error) {
    logger.error('Failed to load the session context:', error);
    return null;
  }
}

/** The chat's trace recorder while traces are kept: one per chat, made at its first run */
function traceFor(instance: Instance, settings: GeneralSettingsConfig): TraceRecorder | null {
  if (!settings.debugTrace) {
    instance.trace = null;
    return null;
  }
  if (!instance.trace) {
    instance.trace = new TraceRecorder(instance.taskId);
    traceStore.prune(MAX_TRACED_SESSIONS).catch(error => logger.warning('Failed to drop old traces:', error));
  }
  instance.trace.screenshots = settings.debugTraceScreenshots;
  return instance.trace;
}

async function setupExecutor(
  instance: Instance,
  task: string,
  snapshot: ExecutorSnapshot | null = null,
  {
    scheduled = false,
    continues = false,
    trigger = 'task',
  }: {
    scheduled?: boolean;
    continues?: boolean;
    /** why the run starts, for the trace: a new task, a follow-up, a bridge's task, a schedule, a replay */
    trigger?: string;
  } = {},
) {
  const { taskId, browserContext } = instance;
  // settings saved while the executor is set up make it stale already
  const version = settingsVersion;
  const providers = await llmProviderStore.getAllProviders();
  // if no providers, need to display the options page
  if (Object.keys(providers).length === 0) {
    throw new Error(t('bg_setup_noApiKeys'));
  }

  // Clean up any legacy validator settings for backward compatibility
  await agentModelStore.cleanupLegacyValidatorSettings();

  const agentModels = await agentModelStore.getAllAgentModels();
  // verify if every provider used in the agent models exists in the providers
  for (const agentModel of Object.values(agentModels)) {
    if (!providers[agentModel.provider]) {
      throw new Error(t('bg_setup_noProvider', [agentModel.provider]));
    }
  }

  const navigatorModel = agentModels[AgentNameEnum.Navigator];
  if (!navigatorModel) {
    throw new Error(t('bg_setup_noNavigatorModel'));
  }
  // Log the provider config being used for the navigator
  const navigatorProviderConfig = providers[navigatorModel.provider];
  const navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);

  let plannerLLM: BaseChatModel | null = null;
  const plannerModel = agentModels[AgentNameEnum.Planner];
  if (plannerModel) {
    // Log the provider config being used for the planner
    const plannerProviderConfig = providers[plannerModel.provider];
    plannerLLM = createChatModel(plannerProviderConfig, plannerModel, { thinking: true });
  }

  // Apply firewall settings to browser context
  const firewall = await firewallStore.getFirewall();
  if (firewall.enabled) {
    browserContext.updateConfig({
      allowedUrls: firewall.allowList,
      deniedUrls: firewall.denyList,
    });
  } else {
    browserContext.updateConfig({
      allowedUrls: [],
      deniedUrls: [],
    });
  }

  const generalSettings = await generalSettingsStore.getSettings();
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    displayHighlights: generalSettings.displayHighlights,
  });

  // Image captchas are read by a model of their own when one is chosen in Settings; without one the navigator
  // asks the user to type them
  const captchaModel = await captchaModelStore.getCaptchaModel();
  const captchaProviderConfig = captchaModel ? providers[captchaModel.provider] : undefined;
  let captchaLLM: BaseChatModel | null = null;
  if (captchaModel && captchaProviderConfig) {
    captchaLLM = createChatModel(captchaProviderConfig, {
      ...captchaModel,
      parameters: { temperature: 0, topP: 0.1 },
      // reading a few characters needs no thinking
      reasoningEffort: 'minimal',
    });
  }
  logger.info('task setup', {
    navigator: `${navigatorModel.modelName} @ ${navigatorProviderConfig.name || navigatorModel.provider}`,
    planner: plannerModel
      ? `${plannerModel.modelName} @ ${providers[plannerModel.provider].name || plannerModel.provider}`
      : 'navigator',
    captcha: captchaModel && captchaProviderConfig ? captchaModel.modelName : 'none: the user types it',
    vision: generalSettings.useVision,
    actionMode: generalSettings.actionMode,
    fastMode: generalSettings.fastMode,
    maxSteps: generalSettings.maxSteps,
    maxFailures: generalSettings.maxFailures,
    planningInterval: generalSettings.planningInterval,
    firewall: firewall.enabled,
  });

  instance.memoryLLM = plannerLLM ?? navigatorLLM;
  const memoryContext = [
    generalSettings.memoryEnabled ? formatMemoryContext(await memoryStore.getAll()) : '',
    memoryInstructions(generalSettings.memoryEnabled, generalSettings.memoryAutoExtract),
    actionModeInstructions(generalSettings.actionMode),
  ]
    .filter(Boolean)
    .join('\n\n');

  const trace = traceFor(instance, generalSettings);
  if (trace) {
    for (const llm of [navigatorLLM, plannerLLM, captchaLLM]) if (llm) llm.callbacks = [trace.handler];
    trace.task(task, trigger, {
      source: instance.source,
      extension: chrome.runtime.getManifest().version,
      build: import.meta.env.VITE_BUILD_INFO || 'unknown',
      navigator: { ...navigatorModel, providerName: navigatorProviderConfig.name || navigatorModel.provider },
      planner: plannerModel
        ? { ...plannerModel, providerName: providers[plannerModel.provider].name || plannerModel.provider }
        : 'navigator',
      captcha: captchaModel && captchaProviderConfig ? captchaModel : null,
      settings: generalSettings,
      firewall,
      memories: generalSettings.memoryEnabled,
      resumedFrom: snapshot ? { tasks: snapshot.tasks, messages: snapshot.messages.length } : null,
    });
  }

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    trace: trace ?? undefined,
    plannerLLM: plannerLLM ?? navigatorLLM,
    captchaLLM,
    memoryContext,
    snapshot: snapshot ?? undefined,
    allowScheduling: !scheduled,
    continues,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
      actionMode: generalSettings.actionMode,
    },
    generalSettings: generalSettings,
  });

  instance.settingsVersion = version;
  return executor;
}

/** Text given in the memory settings: the Planner model picks the facts out of it, as it does for chat messages */
async function importMemories(text: string) {
  const providers = await llmProviderStore.getAllProviders();
  const agentModels = await agentModelStore.getAllAgentModels();
  const model = agentModels[AgentNameEnum.Planner] ?? agentModels[AgentNameEnum.Navigator];
  if (!model || !providers[model.provider]) throw new Error(t('bg_setup_noApiKeys'));
  const settings = await generalSettingsStore.getSettings();
  return rememberFromText(text, {
    llm: createChatModel(providers[model.provider], model, { thinking: true }),
    jevApiKey: settings.fastMode ? settings.fastModeApiKey : undefined,
  });
}

/** After a task, keep what it taught about the user, quietly: the memory shows in Settings, not in the chat */
async function updateMemories(instance: Instance, executor: Executor) {
  const { messages, earlier, attachments } = executor.takeUserMessagesToRemember();
  const work = executor.takeWorkToRemember();
  const llm = instance.memoryLLM;
  try {
    const settings = await generalSettingsStore.getSettings();
    if (!llm || !settings.memoryEnabled || !settings.memoryAutoExtract) return;
    const change = await rememberFromMessages(messages, {
      llm,
      ...(instance.trace ? { fetchImpl: instance.trace.fetch } : {}),
      jevApiKey: settings.fastMode ? settings.fastModeApiKey : undefined,
      earlier,
      attachments,
      work,
    });
    if (change.added.length + change.updated.length + change.removed.length > 0)
      logger.info('memories updated', change);
  } catch (error) {
    logger.error('Failed to update memories:', error);
  }
}

/** Passes what an agent does on to the panel that shows it, or saves it to its chat when none does */
function subscribeToExecutorEvents(instance: Instance, executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  executor.subscribeExecutionEvents(async event => {
    // An executor that was taken over winds down on its own time: its late "stopped" must not land in the chat
    // of the task that replaced it, nor its cleanup detach the pages that task now works on
    if (executor !== instance.executor) return;
    const panelTask = instance.source === 'panel';
    if (panelTask && (event.state === ExecutionState.ACT_CONFIRM || event.state === ExecutionState.ACT_ASK)) {
      instance.waitingFor = { state: event.state, details: event.data.details, meta: event.data.meta };
    }
    try {
      if (panelTask && !instance.viewer) {
        saveUnattended(instance.taskId, event);
        if (event.state === ExecutionState.TASK_OK || event.state === ExecutionState.TASK_FAIL) {
          void chrome.action.setBadgeText({ text: '•' });
        }
      } else {
        instance.viewer?.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    // a task from another agent reports back to that agent, which also answers its questions
    if (panelTask) {
      const tabId = instance.browserContext.currentTabId;
      switch (event.state) {
        case ExecutionState.TASK_OK:
          // a task that ends without an answer reports its id as the details
          void noticeTask('done', event.data.details === instance.taskId ? '' : event.data.details, tabId, {
            panelWindowId: panelWindowOf(instance),
          });
          break;
        case ExecutionState.TASK_FAIL:
          void noticeTask('failed', event.data.details, tabId, { panelWindowId: panelWindowOf(instance) });
          break;
        case ExecutionState.ACT_ASK:
        case ExecutionState.ACT_CONFIRM:
          // with the side panel closed nothing on screen says the task waits, even in the browser's own window
          void noticeTask('waiting', event.data.details, tabId, {
            evenInFront: !instance.viewer,
            panelWindowId: panelWindowOf(instance),
          });
          break;
      }
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      await executor.cleanup();
      void instance.trace?.flush();
    }
  });
}
