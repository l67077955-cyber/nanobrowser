import { generalSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { createLogger } from '../log';
import { findStandaloneWindowId } from './standaloneWindow';

const logger = createLogger('taskNotice');

const NOTICE_PREFIX = 'task-notice:';

export type TaskNoticeKind = 'done' | 'failed' | 'waiting';

/** Markdown out of an answer, so the notification reads as plain text */
function plainText(text: string): string {
  return text
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tells the user a task finished or waits for them while they look elsewhere: a system notification (a toast
 * on Windows) and the browser's taskbar button flashing until its window comes to the front. Nothing when a
 * window the task runs in is in front already, unless evenInFront: the side panel that would show it is closed.
 */
export async function noticeTask(
  kind: TaskNoticeKind,
  details: string,
  tabId: number | null,
  { evenInFront = false }: { evenInFront?: boolean } = {},
): Promise<void> {
  try {
    const { notifyOnFinish } = await generalSettingsStore.getSettings();
    if (!notifyOnFinish) return;

    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => undefined) : undefined;
    const windowIds = [tab?.windowId, await findStandaloneWindowId()].filter((id): id is number => id !== undefined);
    const focused = await chrome.windows.getLastFocused().catch(() => undefined);
    if (!evenInFront && focused?.focused && focused.id !== undefined && windowIds.includes(focused.id)) return;

    for (const windowId of windowIds) {
      await chrome.windows.update(windowId, { drawAttention: true }).catch(() => undefined);
    }

    const title = t(kind === 'done' ? 'bg_notice_done' : kind === 'failed' ? 'bg_notice_failed' : 'bg_notice_waiting');
    const message = plainText(details).slice(0, 240) || title;
    await chrome.notifications.create(`${NOTICE_PREFIX}${tabId ?? ''}:${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title,
      message,
      priority: kind === 'waiting' ? 2 : 0,
      // a question stays on screen until it is answered or dismissed
      requireInteraction: kind === 'waiting',
    });
  } catch (error) {
    logger.warning('Failed to notify the user:', error);
  }
}

/** A click on a notification brings the task's tab and Nanobrowser's window to the front */
export function setupTaskNotices(): void {
  chrome.notifications.onClicked.addListener(async notificationId => {
    if (!notificationId.startsWith(NOTICE_PREFIX)) return;
    chrome.notifications.clear(notificationId);
    try {
      const tabId = Number.parseInt(notificationId.slice(NOTICE_PREFIX.length), 10);
      const tab = Number.isNaN(tabId) ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.id !== undefined && tab.windowId !== undefined) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      const standaloneWindowId = await findStandaloneWindowId();
      if (standaloneWindowId !== undefined) await chrome.windows.update(standaloneWindowId, { focused: true });
      // the click is the user's gesture the side panel needs to be opened; when it is open already this does nothing
      else if (tab?.windowId !== undefined)
        await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    } catch (error) {
      logger.warning('Failed to bring the task to the front:', error);
    }
  });
}
