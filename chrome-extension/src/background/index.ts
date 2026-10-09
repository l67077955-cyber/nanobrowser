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
  type ScheduledTask,
  type ActionMode,
  type StepMeta,
} from '@extension/storage';
import { t } from '@extension/i18n';
import BrowserContext from './browser/context';
import { setupStandaloneWindow } from './services/standaloneWindow';
import { noticeTask, setupTaskNotices } from './services/taskNotice';
import { Executor, type ExecutorSnapshot } from './agent/executor';
import { snapshotFromChat } from './agent/resume';
import { createLogger } from './log';
import { grantsPageActions } from './utils';
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

const logger = createLogger('background');

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
/** the Planner model of the current executor: it also reads the user's messages for things to remember */
let memoryLLM: BaseChatModel | null = null;
let currentPort: chrome.runtime.Port | null = null;
/** The task being worked on now and who asked for it: the side panel, or an agent through the bridge */
let activeTask: {
  taskId: string;
  source: 'panel' | 'remote' | 'scheduled';
} | null = null;
/**
 * The side panel that shows the task the panel asked for and saves its steps to the chat. The task goes on
 * when that panel is closed: until another one opens, the steps are saved here instead.
 */
let viewer: chrome.runtime.Port | null = null;
/** the question or approval that task asked for last, for a side panel opened while it still waits to ask again */
type WaitingFor = { state: ExecutionState; details: string; meta?: StepMeta };
let waitingFor: WaitingFor | null = null;
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
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  logger.info('Debugger detached:', source, reason);
  if (reason === 'canceled_by_user') {
    if (source.tabId) {
      currentExecutor?.cancel();
      await browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
});

logger.info(`background loaded · build ${import.meta.env.VITE_BUILD_INFO || 'unknown'}`);

// A task can run with no side panel open, and then nothing else may wake the service worker for a while
// (a model taking long to answer): an extension call now and then keeps it from being stopped as idle
setInterval(() => {
  if (activeTask) void chrome.runtime.getPlatformInfo();
}, 20_000);

// Initialize analytics
analytics.init().catch(error => {
  logger.error('Failed to initialize analytics:', error);
});

// An executor holds the models and options it was set up with. When a setting is saved, the next message of
// a running session gets a new executor instead of the stale one, so no reload is needed for it to apply.
let settingsChanged = false;
for (const store of [llmProviderStore, agentModelStore, generalSettingsStore, firewallStore, captchaModelStore]) {
  store.subscribe(() => {
    settingsChanged = true;
  });
}

// A stricter action mode holds for a running task from its next action on, not only from the next message
generalSettingsStore.subscribe(async () => {
  const { actionMode } = await generalSettingsStore.getSettings();
  currentExecutor?.setActionMode(actionMode);
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

    currentPort = port;
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

            logger.info('new_task', message.tabId, message.task);
            // Otherwise the previous executor keeps running unreachable and both fight over the same tab
            await currentExecutor?.cancel();
            currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
            subscribeToExecutorEvents(currentExecutor);

            const result = await executeForPanel(currentExecutor, message.taskId, port);
            logger.info('new_task execution result', message.tabId, result);
            void updateMemories(currentExecutor);
            break;
          }

          case 'steer': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            // a message sent while the task runs is taken in by it, as the next thing to consider
            if (activeTask?.taskId === message.taskId && currentExecutor) {
              // "you can click now" in a read-only run switches the mode, which the toggle in the chat box shows
              const { actionMode } = await generalSettingsStore.getSettings();
              if (actionMode === 'readonly' && grantsPageActions(message.task)) {
                currentExecutor.setActionMode('auto');
                await generalSettingsStore.updateSettings({ actionMode: 'auto' });
              }
            }
            if (activeTask?.taskId === message.taskId && currentExecutor?.steer(message.task)) {
              logger.info('steer', message.task);
              break;
            }
            // the task ended in the meantime: once it has wound down, the message is a follow-up
            await panelRun?.catch(() => {});
          }
          // falls through
          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });

            logger.info('follow_up_task', message.tabId, message.task);

            await browserContext.resumeLastTab().catch(error => logger.warning('resumeLastTab failed', error));
            const sameSession = currentExecutor && (await currentExecutor.getCurrentTaskId()) === message.taskId;
            if (currentExecutor && sameSession && !currentExecutor.stopped && !settingsChanged) {
              currentExecutor.addFollowUpTask(message.task);
            } else {
              // The executor of this session is gone (side panel closed, service worker restarted, another
              // session ran since), was cancelled, or was set up before the settings changed: a new one,
              // built from the settings as they are now, goes on from what that one knew
              const snapshot =
                currentExecutor && sameSession
                  ? currentExecutor.snapshot()
                  : await loadSessionSnapshot(message.taskId, message.sentAt);
              logger.info('follow_up_task: reloading the session context', snapshot?.messages.length ?? 0);
              await currentExecutor?.cancel();
              currentExecutor = await setupExecutor(message.taskId, message.task, browserContext, snapshot);
            }
            // Re-subscribe to events in case the previous subscription was cleaned up
            subscribeToExecutorEvents(currentExecutor);
            const result = await executeForPanel(currentExecutor, message.taskId, port);
            logger.info('follow_up_task execution result', message.tabId, result);
            void updateMemories(currentExecutor);
            break;
          }

          case 'cancel_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            // a stop meant for a task that has already given way to another one must not end that one
            if (message.taskId && activeTask?.source === 'panel' && activeTask.taskId !== message.taskId) {
              logger.info('cancel_task for a task no longer running, ignored', message.taskId);
              break;
            }
            logger.info('cancel_task: the user stopped the task in the side panel', message.taskId);
            await currentExecutor.cancel();
            break;
          }

          case 'resume_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_cmd_resumeTask_noTask') });
            await currentExecutor.resume();
            return port.postMessage({ type: 'success' });
          }

          case 'confirm_action': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            currentExecutor.confirmAction(message.approved === true);
            return port.postMessage({ type: 'success' });
          }

          case 'reveal_ask': {
            // the user wants to see what the question is about: its tab, with the field in view
            await currentExecutor?.revealAsked(typeof message.field === 'number' ? message.field : undefined);
            break;
          }

          case 'ask_captcha': {
            const field = Number(message.field);
            const image = await currentExecutor?.askedCaptcha(field, message.refresh === true).catch(error => {
              logger.warning('Failed to show the captcha the user is asked for:', error);
              return null;
            });
            return port.postMessage({ type: 'ask_captcha', field, image: image ?? null });
          }

          case 'pause_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await currentExecutor.pause();
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            const page = await browserContext.switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              const browserState = await browserContext.getState(true);
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
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: t('bg_cmd_nohighlight_ok') });
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            if (!message.historySessionId)
              return port.postMessage({ type: 'error', error: t('bg_cmd_replay_noHistory') });
            logger.info('replay', message.tabId, message.taskId, message.historySessionId);

            try {
              // Switch to the specified tab
              await browserContext.switchTab(message.tabId);
              // Setup executor with the new taskId and a dummy task description
              await currentExecutor?.cancel();
              currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
              subscribeToExecutorEvents(currentExecutor);

              // Run replayHistory with the history session ID
              const result = await currentExecutor.replayHistory(message.historySessionId);
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
      logger.info('Side panel disconnected', activeTask ? `(task from ${activeTask.source})` : '(no task)');
      if (currentPort === port) currentPort = null;
      if (viewer === port) viewer = null;
    });
  }
});

/**
 * A side panel that opens while a task the panel asked for runs shows that task: its chat as saved so far,
 * then the steps as they come, and the question or approval the task waits for
 */
async function attachPanel(port: chrome.runtime.Port): Promise<void> {
  const task = activeTask;
  if (task?.source === 'remote' && remoteTask?.taskId === task.taskId) {
    const waiting = currentExecutor?.waitingForUser ? remoteTask.waitingFor : null;
    port.postMessage({ type: 'remote_task', taskId: task.taskId, task: remoteTask.task, waitingFor: waiting });
    return;
  }
  if (task?.source !== 'panel' || viewer === port) return;
  await unattendedSaved();
  // the panel closed again, another one opened, or the task ended while the steps were saved
  if (activeTask !== task || currentPort !== port) return;
  viewer = port;
  logger.info('Side panel shows the running task', task.taskId);
  // the planner goes on reporting while a question waits, so the last step says nothing about whether it does
  const waiting = currentExecutor?.waitingForUser ? waitingFor : null;
  port.postMessage({ type: 'task_attached', taskId: task.taskId, waitingFor: waiting });
}

/** The run of the latest task the side panel asked for, until it has ended */
let panelRun: Promise<void> | null = null;

/** Run a task the side panel asked for. It takes over from whatever task was running. */
async function executeForPanel(executor: Executor, taskId: string, port: chrome.runtime.Port): Promise<void> {
  const claim = { taskId, source: 'panel' as const };
  activeTask = claim;
  viewer = port;
  waitingFor = null;
  const run = executor.execute().finally(() => {
    if (activeTask === claim) activeTask = null;
  });
  panelRun = run;
  await run;
}

/**
 * A window for a task to work in: Chrome started by the bridge runs with none, and so does one whose windows
 * were all closed while it keeps running in the background
 */
async function ensureBrowserWindow(): Promise<void> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length > 0) return;
  const window = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' });
  const tabId = window?.tabs?.[0]?.id;
  if (tabId) browserContext.updateCurrentTabId(tabId);
}

/** How long a remote task waits for the user to answer or approve before it goes on without them */
const REMOTE_USER_WAIT_MS = 10 * 60_000;
/** The remote task running now, and what it waits for from the user, for a side panel opened meanwhile */
let remoteTask: { taskId: string; task: string; waitingFor: WaitingFor | null } | null = null;

/**
 * Start a task for an agent on the bridge and return its id; the task goes on after that and its end is
 * reported to the bridge. The user comes first: a task of theirs is not interrupted, and one they start
 * from the side panel takes over.
 */
/** What the page of a task waiting for the user shows, or nothing when it cannot be taken in a few seconds */
async function waitingScreenshot(): Promise<string | undefined> {
  try {
    const page = await browserContext.getCurrentPage();
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 3000));
    return (await Promise.race([page.takeScreenshot(), timeout])) ?? undefined;
  } catch (error) {
    logger.warning('remote task: no screenshot for the user', error);
    return undefined;
  }
}

async function startRemoteTask(task: string): Promise<string> {
  if (activeTask) throw new Error('The browser is busy with another task');
  const taskId = `remote-${crypto.randomUUID()}`;
  const claim = { taskId, source: 'remote' as const };
  activeTask = claim;
  let executor: Executor;
  try {
    await currentExecutor?.cancel();
    await ensureBrowserWindow();
    executor = await setupExecutor(taskId, task, browserContext);
    if (activeTask !== claim) throw new Error('The user started a task of their own');
  } catch (error) {
    if (activeTask === claim) activeTask = null;
    throw error;
  }
  currentExecutor = executor;
  remoteTask = { taskId, task, waitingFor: null };
  subscribeToExecutorEvents(executor);
  // an open side panel shows the task like one of its own, with its stop button
  currentPort?.postMessage({ type: 'remote_task', taskId, task });

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
    const screenshot = waiting ? await waitingScreenshot() : undefined;
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
        if (remoteTask?.taskId === taskId) {
          remoteTask.waitingFor = { state: event.state, details: event.data.details, meta: event.data.meta };
        }
        void noticeTask('waiting', event.data.details, browserContext.currentTabId, { evenInFront: !currentPort });
        waitForUser(() =>
          event.state === ExecutionState.ACT_ASK ? executor.answerQuestion(null) : executor.confirmAction(false),
        );
        break;
    }
  });

  logger.info('remote task', taskId, task);
  void executor
    .execute()
    .catch(error => {
      end.status = 'failed';
      end.result = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      stopWaiting();
      if (remoteTask?.taskId === taskId) remoteTask = null;
      if (activeTask === claim) activeTask = null;
      remoteControl.sendTaskEnd(end);
    });
  return taskId;
}

/**
 * Run a scheduled task in a window of its own, behind the user's, so it neither takes over the tab they
 * are using nor stalls the way a hidden tab does. The run is written to a chat of its own, where its
 * answer can be read and the conversation carried on. Returns null when the browser is busy.
 */
async function runScheduledTask(entry: ScheduledTask): Promise<ScheduledRunEnd | null> {
  if (activeTask) return null;
  const session = await chatHistoryStore.createSession(`Scheduled · ${entry.task}`.slice(0, 60));
  const taskId = session.id;
  const claim = { taskId, source: 'scheduled' as const };
  activeTask = claim;
  let windowId: number | undefined;
  const end: ScheduledRunEnd = {
    status: 'failed',
    result: 'The task stopped before it was finished',
    sessionId: taskId,
  };
  try {
    await currentExecutor?.cancel();
    const window = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' });
    windowId = window?.id;
    const tabId = window?.tabs?.[0]?.id;
    if (!tabId) throw new Error('Could not open a window for the scheduled task');
    const executor = await setupExecutor(taskId, entry.task, browserContext, null, { scheduled: true });
    if (activeTask !== claim) throw new Error('The user started a task of their own');
    browserContext.updateCurrentTabId(tabId);
    currentExecutor = executor;
    executor.clearExecutionEvents();
    executor.subscribeExecutionEvents(async (event: AgentEvent) => {
      switch (event.state) {
        case ExecutionState.TASK_OK:
          end.status = 'completed';
          end.result = event.data.details === taskId ? '' : event.data.details;
          void noticeTask('done', end.result, browserContext.currentTabId);
          break;
        case ExecutionState.TASK_FAIL:
          end.status = 'failed';
          end.result = event.data.details;
          void noticeTask('failed', end.result, browserContext.currentTabId);
          break;
        case ExecutionState.TASK_CANCEL:
          end.status = 'cancelled';
          end.result = event.data.details;
          break;
        case ExecutionState.ACT_CONFIRM:
          // nobody is there to approve: a step that needs approval is left for the user
          executor.confirmAction(false);
          break;
        case ExecutionState.ACT_ASK:
          executor.answerQuestion(null);
          break;
      }
    });
    await chatHistoryStore.addMessage(taskId, { actor: Actors.USER, content: entry.task, timestamp: Date.now() });
    logger.info('scheduled task', entry.id, entry.task);
    await executor.execute();
    void updateMemories(executor);
  } catch (error) {
    end.result = error instanceof Error ? error.message : String(error);
  } finally {
    if (activeTask === claim) activeTask = null;
    await currentExecutor?.cleanup();
    if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => {});
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
  if (!currentPort) void chrome.action.setBadgeText({ text: '•' });
  return end;
}

new Scheduler(runScheduledTask).start();

const remoteControl = new RemoteControl(
  {
    run_task: async params => {
      const task = typeof params.task === 'string' ? params.task.trim() : '';
      if (!task) throw new Error(t('bg_cmd_newTask_noTask'));
      return { taskId: await startRemoteTask(task) };
    },
    cancel_task: async params => {
      if (activeTask?.source !== 'remote' || activeTask.taskId !== params.taskId || !currentExecutor) {
        throw new Error(t('bg_errors_noRunningTask'));
      }
      await currentExecutor.cancel();
      return { cancelled: true };
    },
    // the user's reply to what a remote task waits for, passed on by the bridge from wherever they are
    answer_task: async params => {
      if (activeTask?.source !== 'remote' || activeTask.taskId !== params.taskId || !currentExecutor) {
        throw new Error(t('bg_errors_noRunningTask'));
      }
      const waiting =
        currentExecutor.waitingForUser && remoteTask?.taskId === params.taskId ? remoteTask.waitingFor : null;
      if (!waiting || !remoteTask) throw new Error('The task is not waiting for the user');
      remoteTask.waitingFor = null;
      const answer = typeof params.answer === 'string' ? params.answer.trim() : '';
      if (waiting.state === ExecutionState.ACT_CONFIRM) {
        const approved =
          typeof params.approve === 'boolean' ? params.approve : /^(y|yes|ok|approve|是|好|确认|同意)/i.test(answer);
        currentExecutor.confirmAction(approved);
        return { answered: true, approved };
      }
      currentExecutor.answerQuestion(answer);
      return { answered: true };
    },
    status: async () => ({
      version: chrome.runtime.getManifest().version,
      busy: activeTask !== null,
      // a task of the user's own is none of the agent's business
      taskId: activeTask?.source === 'remote' ? activeTask.taskId : null,
    }),
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

async function setupExecutor(
  taskId: string,
  task: string,
  browserContext: BrowserContext,
  snapshot: ExecutorSnapshot | null = null,
  { scheduled = false } = {},
) {
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

  memoryLLM = plannerLLM ?? navigatorLLM;
  const memoryContext = [
    generalSettings.memoryEnabled ? formatMemoryContext(await memoryStore.getAll()) : '',
    memoryInstructions(generalSettings.memoryEnabled, generalSettings.memoryAutoExtract),
    actionModeInstructions(generalSettings.actionMode),
  ]
    .filter(Boolean)
    .join('\n\n');

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    captchaLLM,
    memoryContext,
    snapshot: snapshot ?? undefined,
    allowScheduling: !scheduled,
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

  // the executor was built from the settings as they are now, whatever was saved while it was set up
  settingsChanged = false;
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
async function updateMemories(executor: Executor) {
  const { messages, earlier, attachments } = executor.takeUserMessagesToRemember();
  const work = executor.takeWorkToRemember();
  const llm = memoryLLM;
  try {
    const settings = await generalSettingsStore.getSettings();
    if (!llm || !settings.memoryEnabled || !settings.memoryAutoExtract) return;
    const change = await rememberFromMessages(messages, {
      llm,
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

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    const panelTask = activeTask?.source === 'panel' ? activeTask : null;
    if (panelTask && (event.state === ExecutionState.ACT_CONFIRM || event.state === ExecutionState.ACT_ASK)) {
      waitingFor = { state: event.state, details: event.data.details, meta: event.data.meta };
    }
    try {
      if (panelTask && !viewer) {
        saveUnattended(panelTask.taskId, event);
        if (event.state === ExecutionState.TASK_OK || event.state === ExecutionState.TASK_FAIL) {
          void chrome.action.setBadgeText({ text: '•' });
        }
      } else {
        (panelTask ? viewer : currentPort)?.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    // a task from another agent reports back to that agent, which also answers its questions
    if (activeTask?.source === 'panel') {
      const tabId = browserContext.currentTabId;
      switch (event.state) {
        case ExecutionState.TASK_OK:
          // a task that ends without an answer reports its id as the details
          void noticeTask('done', event.data.details === activeTask.taskId ? '' : event.data.details, tabId);
          break;
        case ExecutionState.TASK_FAIL:
          void noticeTask('failed', event.data.details, tabId);
          break;
        case ExecutionState.ACT_ASK:
        case ExecutionState.ACT_CONFIRM:
          // with the side panel closed nothing on screen says the task waits, even in the browser's own window
          void noticeTask('waiting', event.data.details, tabId, { evenInFront: !viewer });
          break;
      }
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      await currentExecutor?.cleanup();
    }
  });
}
