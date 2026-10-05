import { useState } from 'react';
import { BsPinAngle, BsPinAngleFill } from 'react-icons/bs';
import { t } from '@extension/i18n';

// Document Picture-in-Picture: a small window the system keeps above all others, and that never takes focus
// from them; it lives as long as the page that opened it
type PipHost = { requestWindow(options?: { width?: number; height?: number }): Promise<Window> };
const pipHost = (window as Window & { documentPictureInPicture?: PipHost }).documentPictureInPicture;

const SIZE_KEY = 'nb-pinned-size';
const DEFAULT_SIZE = { width: 400, height: 620 };

function storedSize(): { width: number; height: number } {
  try {
    const size = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null');
    if (size?.width > 0 && size?.height > 0) return size;
  } catch {
    // no storage: the default size will do
  }
  return DEFAULT_SIZE;
}

function storeSize(win: Window): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: win.innerWidth, height: win.innerHeight }));
  } catch {
    // the size is only a convenience
  }
}

/** Gives the pinned window the page's stylesheets and the classes the theme hangs on */
function copyLook(from: Document, to: Document): void {
  for (const node of Array.from(from.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
    to.head.append(node.cloneNode(true));
  }
  for (const { name, value } of Array.from(from.documentElement.attributes)) {
    to.documentElement.setAttribute(name, value);
  }
  to.body.className = from.body.className;
  to.title = from.title;
}

/** What is left where Nanobrowser was while it is pinned: a way to bring it back */
function placeholder(onBack: () => void): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText =
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100vh;' +
    'font:13px system-ui,sans-serif;color:var(--nb-ink-2,#666);text-align:center;padding:16px';
  const text = document.createElement('div');
  text.textContent = t('nav_pinned_here');
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = t('nav_unpin_bringBack');
  back.style.cssText =
    'padding:6px 12px;border-radius:8px;border:1px solid currentColor;background:none;color:inherit;cursor:pointer';
  back.addEventListener('click', onBack);
  box.append(text, back);
  return box;
}

/**
 * Header button that pins Nanobrowser above every other window, the browser's and other apps' alike. Only
 * the pinned window floats: the others keep working as before, and clicking into them is never blocked.
 * The panel moves over as it is, so a running task and the open chat go along; closing the pinned window
 * or the button there brings it back.
 */
export default function PinButton({ onPinnedChange }: { onPinnedChange: (pinned: boolean) => void }) {
  const [pinWindow, setPinWindow] = useState<Window | null>(null);
  if (!pipHost) return null;

  const pin = async () => {
    const app = document.getElementById('app-container');
    if (!app) return;
    // first, while the click still counts as the user's
    const pip = await pipHost.requestWindow(storedSize());
    copyLook(document, pip.document);
    pip.document.body.append(app);
    const left = placeholder(() => pip.close());
    document.body.append(left);
    setPinWindow(pip);
    onPinnedChange(true);

    // a window of its own would sit there empty, so it gets out of the way; a side panel is not a tab
    const ownWindowId = (await chrome.tabs.getCurrent().catch(() => undefined))?.windowId;
    if (ownWindowId !== undefined) void chrome.windows.update(ownWindowId, { state: 'minimized' }).catch(() => {});

    let resizeTimer: number | undefined;
    pip.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => storeSize(pip), 300);
    });
    pip.addEventListener(
      'pagehide',
      () => {
        window.clearTimeout(resizeTimer);
        left.remove();
        document.body.append(app);
        setPinWindow(null);
        onPinnedChange(false);
        if (ownWindowId !== undefined) void chrome.windows.update(ownWindowId, { state: 'normal' }).catch(() => {});
      },
      { once: true },
    );
  };

  const pinned = pinWindow !== null;
  const label = pinned ? t('nav_unpin_a11y') : t('nav_pin_a11y');

  const handleClick = () => {
    if (pinWindow) {
      pinWindow.close();
      return;
    }
    pin().catch(err => console.error('Failed to pin Nanobrowser on top:', err));
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="header-icon"
      aria-pressed={pinned}
      aria-label={label}
      title={label}>
      {pinned ? <BsPinAngleFill size={15} /> : <BsPinAngle size={15} />}
    </button>
  );
}
