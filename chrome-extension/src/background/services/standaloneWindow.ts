import { generalSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('standaloneWindow');

const PANEL_URL = chrome.runtime.getURL('side-panel/index.html');
const BOUNDS_KEY = 'standalone-window-bounds';
const DEFAULT_SIZE = { width: 440, height: 760 };

type Bounds = { left?: number; top?: number; width?: number; height?: number };

/**
 * Bounds pulled inside the area of a browser window, which stands in for the screen: a window taller than the
 * screen, or one left on a screen that is gone, would put the input at its bottom out of sight
 */
export function fitBounds(bounds: Bounds, area: Bounds): Bounds {
  const { left: areaLeft = 0, top: areaTop = 0, width: areaWidth, height: areaHeight } = area;
  if (!areaWidth || !areaHeight) return bounds;
  const width = Math.min(bounds.width ?? DEFAULT_SIZE.width, areaWidth);
  const height = Math.min(bounds.height ?? DEFAULT_SIZE.height, areaHeight);
  const clamp = (value: number | undefined, start: number, room: number) =>
    value === undefined ? undefined : Math.min(Math.max(value, start), start + room);
  return {
    width,
    height,
    left: clamp(bounds.left, areaLeft, areaWidth - width),
    top: clamp(bounds.top, areaTop, areaHeight - height),
  };
}

/** The window Nanobrowser runs in when it is not docked in the side panel, if it is open */
export async function findStandaloneWindowId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ windowType: 'popup' });
  return tabs.find(tab => tab.url === PANEL_URL)?.windowId;
}

/** Opens Nanobrowser in a window of its own, where it was left the last time; an open one comes to the front */
export async function openStandaloneWindow(): Promise<void> {
  const openWindowId = await findStandaloneWindowId();
  if (openWindowId !== undefined) {
    await chrome.windows.update(openWindowId, { focused: true });
    return;
  }
  const stored = await chrome.storage.local.get(BOUNDS_KEY);
  let bounds: Bounds = { ...DEFAULT_SIZE, ...stored[BOUNDS_KEY] };
  const browser = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  if (browser) bounds = fitBounds(bounds, browser);
  try {
    await chrome.windows.create({ url: PANEL_URL, type: 'popup', ...bounds });
  } catch (error) {
    // the place it was left at can be on a screen that is gone
    logger.warning('Stored window bounds rejected, using the default size', error);
    await chrome.windows.create({ url: PANEL_URL, type: 'popup', ...DEFAULT_SIZE });
  }
}

async function applyActionBehavior(): Promise<void> {
  const { openInWindow } = await generalSettingsStore.getSettings();
  // with the side panel not opening on a click, chrome.action.onClicked fires instead
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !openInWindow });
}

/** The toolbar icon opens the side panel or the standalone window, as set; the side panel can ask for the window */
export function setupStandaloneWindow(): void {
  const apply = () => applyActionBehavior().catch(error => logger.error('Failed to set the action behavior:', error));
  apply();
  generalSettingsStore.subscribe(apply);

  chrome.action.onClicked.addListener(() => {
    openStandaloneWindow().catch(error => logger.error('Failed to open the standalone window:', error));
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'open_standalone_window' || sender.id !== chrome.runtime.id) return false;
    openStandaloneWindow().catch(error => logger.error('Failed to open the standalone window:', error));
    return false;
  });

  chrome.windows.onBoundsChanged.addListener(async win => {
    if (win.type !== 'popup' || win.state !== 'normal') return;
    if (win.id !== (await findStandaloneWindowId())) return;
    const { left, top, width, height } = win;
    await chrome.storage.local.set({ [BOUNDS_KEY]: { left, top, width, height } });
  });
}
