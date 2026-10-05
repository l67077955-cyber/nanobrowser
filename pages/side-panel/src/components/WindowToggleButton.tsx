import { useEffect, useState } from 'react';
import { FiExternalLink, FiSidebar } from 'react-icons/fi';
import { t } from '@extension/i18n';

const HANDOFF_KEY = 'nb-handoff-session';
// a chat handed over longer ago than this was for a move that did not happen
const HANDOFF_TTL_MS = 15_000;

type Handoff = { sessionId: string; at: number; from: string };

// tells this page's own handoff apart from one meant for it: the page handing over must not take it back
const PAGE_ID = crypto.randomUUID();

/** Remembers which chat was open, for the panel that opens next to show it */
function handOff(sessionId: string | null): Promise<void> {
  if (!sessionId) return chrome.storage.session.remove(HANDOFF_KEY);
  return chrome.storage.session.set({ [HANDOFF_KEY]: { sessionId, at: Date.now(), from: PAGE_ID } satisfies Handoff });
}

/**
 * Calls `show` with the chat the side panel or window it replaced had open: once on opening, and again when
 * an already open window is brought to the front for another chat
 */
export function useHandedOffSession(show: (sessionId: string) => void): void {
  useEffect(() => {
    const take = (handoff: Handoff | undefined) => {
      if (!handoff || handoff.from === PAGE_ID || Date.now() - handoff.at > HANDOFF_TTL_MS) return;
      void chrome.storage.session.remove(HANDOFF_KEY);
      show(handoff.sessionId);
    };
    chrome.storage.session
      .get(HANDOFF_KEY)
      .then(stored => take(stored[HANDOFF_KEY] as Handoff | undefined))
      .catch(err => console.error('Failed to read the chat handed over:', err));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (HANDOFF_KEY in changes) take(changes[HANDOFF_KEY].newValue as Handoff | undefined);
    };
    chrome.storage.session.onChanged.addListener(onChanged);
    return () => chrome.storage.session.onChanged.removeListener(onChanged);
  }, [show]);
}

/**
 * Header button that moves Nanobrowser between the side panel and a window of its own, taking the open chat
 * along. A running task goes on through the move and shows up where Nanobrowser opens.
 */
export default function WindowToggleButton({
  sessionId,
  menuItem = false,
}: {
  sessionId: string | null;
  /** a row in the header's menu rather than an icon of its own */
  menuItem?: boolean;
}) {
  // null until known; a side panel is not a tab
  const [inWindow, setInWindow] = useState<boolean | null>(null);
  // the browser window the side panel goes back to, looked up ahead: opening it must happen in the click itself
  const [dockWindowId, setDockWindowId] = useState<number | null>(null);

  useEffect(() => {
    chrome.tabs
      .getCurrent()
      .then(tab => setInWindow(!!tab))
      .catch(err => console.error('Failed to tell where the panel is open:', err));
  }, []);

  useEffect(() => {
    if (!inWindow) return;
    const look = () =>
      chrome.windows
        .getLastFocused({ windowTypes: ['normal'] })
        .then(win => setDockWindowId(win.id ?? null))
        .catch(() => setDockWindowId(null));
    void look();
    chrome.windows.onFocusChanged.addListener(look);
    return () => chrome.windows.onFocusChanged.removeListener(look);
  }, [inWindow]);

  if (inWindow === null) return null;

  const label = inWindow ? t('nav_dockToSidePanel_a11y') : t('nav_openInWindow_a11y');
  const disabled = inWindow && dockWindowId === null;

  const handleClick = () => {
    if (inWindow) {
      if (dockWindowId === null) return;
      // first, while the click still counts as the user's: the side panel opens only on a user gesture
      const opened = chrome.sidePanel.open({ windowId: dockWindowId });
      Promise.all([opened, handOff(sessionId)])
        .then(() => window.close())
        .catch(err => console.error('Failed to move back to the side panel:', err));
      return;
    }
    handOff(sessionId)
      .then(() => chrome.runtime.sendMessage({ type: 'open_standalone_window' }))
      .then(() => window.close())
      .catch(err => console.error('Failed to open the separate window:', err));
  };

  const Icon = inWindow ? FiSidebar : FiExternalLink;
  if (menuItem) {
    return (
      <button type="button" role="menuitem" onClick={handleClick} disabled={disabled}>
        <span className="nb-menu-check">
          <Icon size={14} />
        </span>
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="header-icon disabled:cursor-not-allowed disabled:opacity-40"
      aria-label={label}
      title={label}>
      <Icon size={16} />
    </button>
  );
}
