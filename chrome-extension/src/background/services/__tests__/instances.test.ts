import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import type BrowserContext from '../../browser/context';
import type * as Instances from '../instances';

/** A browser of normal windows, each with its tabs; the first tab of the first window is in front */
type FakeTab = { id: number; windowId: number; url: string; active: boolean };
let tabs: FakeTab[] = [];
let nextId = 100;

vi.stubGlobal('chrome', {
  tabs: {
    get: vi.fn(async (tabId: number) => {
      const tab = tabs.find(each => each.id === tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      return tab;
    }),
  },
  windows: {
    get: vi.fn(async (windowId: number) => {
      const own = tabs.filter(tab => tab.windowId === windowId);
      if (!own.length) throw new Error(`No window with id ${windowId}`);
      return { id: windowId, tabs: own };
    }),
    create: vi.fn(async ({ url }: { url: string }) => {
      const windowId = nextId++;
      const tab = { id: nextId++, windowId, url, active: true };
      tabs.push(tab);
      return { id: windowId, tabs: [tab] };
    }),
  },
});
vi.mock('../../browser/context', () => ({
  default: class {},
  getActiveBrowserTab: async () => tabs.find(tab => tab.active),
}));
vi.mock('../../log', () => ({ createLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));

/** Stands in for a BrowserContext: only the tab the agent works in matters here */
function fakeContext(): BrowserContext {
  let current: number | null = null;
  return {
    get currentTabId() {
      return current;
    },
    updateCurrentTabId(tabId: number) {
      current = tabId;
    },
    adoptOpenedTab: vi.fn(async () => {}),
  } as unknown as BrowserContext;
}

// imported once the mocks above are in place
let mod: typeof Instances;
beforeAll(async () => {
  mod = await import('../instances');
});

beforeEach(() => {
  mod.instances.clear();
  mod.panels.clear();
  // window 1: the user's, with a page in front; window 2: another one of theirs
  tabs = [
    { id: 1, windowId: 1, url: 'https://shop.example/cart', active: true },
    { id: 2, windowId: 1, url: 'https://mail.example/', active: false },
    { id: 3, windowId: 2, url: 'https://news.example/', active: true },
  ];
  vi.mocked(chrome.windows.create).mockClear();
});

function agent(taskId: string, { active = true } = {}) {
  const instance = mod.newInstance(taskId, 'panel', fakeContext());
  instance.active = active;
  return instance;
}

describe('placeInstance', () => {
  it('lets the only agent work on the tab it was asked from', async () => {
    const first = agent('a');
    await mod.placeInstance(first, 1);
    expect(first.browserContext.currentTabId).toBe(1);
    expect(first.windowId).toBeNull();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('gives a second agent asked from the same window a window of its own, on the same page', async () => {
    const first = agent('a');
    await mod.placeInstance(first, 1);
    const second = agent('b');
    await mod.placeInstance(second, 1);
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://shop.example/cart' }));
    expect(second.windowId).not.toBeNull();
    const tab = await chrome.tabs.get(second.browserContext.currentTabId as number);
    expect(tab.windowId).toBe(second.windowId);
    expect(first.browserContext.currentTabId).toBe(1);
    expect(second.browserContext.adoptOpenedTab).toHaveBeenCalledWith(second.browserContext.currentTabId, undefined);
  });

  it('counts an agent still being set up as at work, so two started together do not share a window', async () => {
    const first = agent('a');
    const second = agent('b');
    await Promise.all([mod.placeInstance(first, 1), mod.placeInstance(second, 1)]);
    const windows = await Promise.all(
      [first, second].map(async each => (await chrome.tabs.get(each.browserContext.currentTabId as number)).windowId),
    );
    expect(new Set(windows).size).toBe(2);
  });

  it('lets a second agent work in another window of the user without opening one', async () => {
    await mod.placeInstance(agent('a'), 1);
    const second = agent('b');
    await mod.placeInstance(second, 3);
    expect(second.browserContext.currentTabId).toBe(3);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('does not keep a window from an agent whose task has ended', async () => {
    await mod.placeInstance(agent('a', { active: false }), 1);
    const second = agent('b');
    await mod.placeInstance(second, 1);
    expect(second.browserContext.currentTabId).toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('sends an agent back to its own window for a follow-up, whatever tab it is asked from', async () => {
    await mod.placeInstance(agent('a'), 1);
    const second = agent('b');
    await mod.placeInstance(second, 1);
    const own = second.windowId;
    second.browserContext.updateCurrentTabId(1);
    await mod.placeInstance(second, 1);
    expect(second.windowId).toBe(own);
    expect((await chrome.tabs.get(second.browserContext.currentTabId as number)).windowId).toBe(own);
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('opens a blank window for a page the agent cannot read again', async () => {
    tabs[0].url = 'chrome://extensions/';
    await mod.placeInstance(agent('a'), 1);
    await mod.placeInstance(agent('b'), 1);
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'about:blank' }));
  });
});

describe('panels and agents', () => {
  const port = (name: string) => ({ name }) as unknown as chrome.runtime.Port;

  it('moves a panel from one agent to another, leaving the first to go on unseen', () => {
    const panel = port('p');
    const first = agent('a');
    const second = agent('b');
    mod.showIn(panel, first);
    mod.showIn(panel, second);
    expect(mod.shownInstance(panel)).toBe(second);
    expect(first.viewer).toBeNull();
    expect(second.viewer).toBe(panel);
  });

  it('keeps running agents and those shown, and drops the oldest idle ones past the few kept', () => {
    const shown = agent('shown', { active: false });
    mod.showIn(port('p'), shown);
    const running = agent('running');
    const idle = Array.from({ length: mod.MAX_IDLE + 3 }, (_, i) => agent(`idle-${i}`, { active: false }));
    mod.pruneInstances();
    expect(mod.instances.has('shown')).toBe(true);
    expect(mod.instances.has(running.taskId)).toBe(true);
    expect(idle.filter(each => mod.instances.has(each.taskId)).map(each => each.taskId)).toEqual(
      idle.slice(3).map(each => each.taskId),
    );
  });

  it('counts only agents at work as running', () => {
    agent('a');
    agent('b', { active: false });
    expect(mod.runningInstances().map(each => each.taskId)).toEqual(['a']);
  });
});
