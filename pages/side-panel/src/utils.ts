export function generateNewTaskId(): string {
  /**
   * Generate a new task id based on the current timestamp and a random number.
   */
  return `${Date.now()}-${Math.floor(Math.random() * (999999 - 100000 + 1) + 100000)}`;
}

export function getCurrentTimestampStr(): string {
  /**
   * Get the current timestamp as a string in the format yyyy-MM-dd HH:mm:ss
   * using local timezone.
   *
   * @returns Formatted datetime string in local time
   */
  return new Date()
    .toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(',', '');
}

/**
 * The tab a task starts on: the one in front in the window the side panel is docked in. Opened in a window of
 * its own, the panel is the only tab of its window, and the tab is the one in front in the browser window
 * the user was last in.
 */
export async function getTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  if (!(await chrome.tabs.getCurrent())) {
    return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  }
  const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
  if (tabs.length <= 1) return tabs[0];
  const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return tabs.find(tab => tab.windowId === lastFocused?.id) ?? tabs[0];
}
