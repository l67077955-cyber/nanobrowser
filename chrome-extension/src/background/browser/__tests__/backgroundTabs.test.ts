import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type BrowserContextType from '../context';

vi.mock('webextension-polyfill', () => ({}));
vi.mock('../../services/analytics', () => ({ analytics: { trackDomainVisit: async () => {} } }));
vi.mock('../page', () => ({
  default: class {
    attached = true;
    navigateTo = vi.fn(async () => {});
    constructor(
      public tabId: number,
      public url: string,
    ) {}
    async attachPuppeteer() {
      return true;
    }
    async detachPuppeteer() {}
    async removeHighlight() {}
    async clearAgentMark() {}
  },
  build_initial_state: () => ({}),
}));

type Tab = { id: number; url: string; title: string; active: boolean; windowId: number; index: number; status: string };

/** A browser window with tabs, as far as BrowserContext uses chrome.tabs */
function fakeBrowser(tabs: Omit<Tab, 'windowId' | 'index' | 'title' | 'status'>[]) {
  const all: Tab[] = tabs.map((t, index) => ({ ...t, windowId: 1, index, title: 't', status: 'complete' }));
  let nextId = 100;
  const listeners = { addListener: () => {}, removeListener: () => {} };
  const api = {
    query: vi.fn(async ({ active }: { active?: boolean }) =>
      all.filter(t => active === undefined || t.active === active),
    ),
    get: vi.fn(async (id: number) => {
      const tab = all.find(t => t.id === id);
      if (!tab) throw new Error('no tab');
      return tab;
    }),
    create: vi.fn(async ({ url, active, index }: { url: string; active?: boolean; index?: number }) => {
      if (active !== false) all.forEach(t => (t.active = false));
      const tab = {
        id: nextId++,
        url,
        title: 't',
        active: active !== false,
        windowId: 1,
        index: index ?? all.length,
        status: 'complete',
      };
      all.push(tab);
      return tab;
    }),
    update: vi.fn(async (id: number, props: { active?: boolean; url?: string }) => {
      const tab = all.find(t => t.id === id)!;
      if (props.active) all.forEach(t => (t.active = t.id === id));
      if (props.url) tab.url = props.url;
      return tab;
    }),
    onUpdated: listeners,
    onActivated: listeners,
  };
  vi.stubGlobal('chrome', {
    tabs: api,
    windows: { getLastFocused: async () => ({ id: 1 }) },
  });
  return { all, api, front: () => all.find(t => t.active)?.id };
}

// imported once the mocks above are in place
let BrowserContext: typeof BrowserContextType;
beforeAll(async () => {
  ({ default: BrowserContext } = await import('../context'));
});

describe('BrowserContext working beside the user', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an address in a new tab behind the user instead of leaving a page the user had open', async () => {
    const browser = fakeBrowser([{ id: 1, url: 'https://mail.example.com/inbox', active: true }]);
    const context = new BrowserContext({});
    await context.navigateTo('https://www.bing.com/search?q=x');

    expect(browser.all.find(t => t.id === 1)?.url).toBe('https://mail.example.com/inbox');
    expect(browser.api.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://www.bing.com/search?q=x', active: false, index: 1 }),
    );
    expect(browser.front()).toBe(1);
    expect(context.currentTabId).toBe(100);
  });

  it('navigates in place in a tab it opened itself', async () => {
    const browser = fakeBrowser([{ id: 1, url: 'https://mail.example.com/inbox', active: true }]);
    const context = new BrowserContext({});
    await context.navigateTo('https://a.example.com/');
    await context.navigateTo('https://b.example.com/');
    expect(browser.api.create).toHaveBeenCalledTimes(1);
    expect(context.currentTabId).toBe(100);
  });

  it('uses a blank tab the user is on', async () => {
    const browser = fakeBrowser([{ id: 1, url: 'about:blank', active: true }]);
    const context = new BrowserContext({});
    await context.navigateTo('https://a.example.com/');
    expect(browser.api.create).not.toHaveBeenCalled();
    expect(context.currentTabId).toBe(1);
  });

  it('switches the tab it works on without bringing it to the front', async () => {
    const browser = fakeBrowser([
      { id: 1, url: 'https://mail.example.com/inbox', active: true },
      { id: 2, url: 'https://docs.example.com/', active: false },
    ]);
    const context = new BrowserContext({});
    await context.switchTab(2);
    expect(context.currentTabId).toBe(2);
    expect(browser.front()).toBe(1);
    expect(browser.api.update).not.toHaveBeenCalled();
  });

  it('gives the front back to the user when a link it clicked opened a tab there', async () => {
    const browser = fakeBrowser([
      { id: 1, url: 'https://mail.example.com/inbox', active: false },
      { id: 2, url: 'https://news.example.com/', active: true },
    ]);
    const context = new BrowserContext({});
    await context.adoptOpenedTab(2, 1);
    expect(browser.front()).toBe(1);
  });

  it('goes on with a follow-up in the tab it worked in while the user stayed on their page', async () => {
    const browser = fakeBrowser([{ id: 1, url: 'https://mail.example.com/inbox', active: true }]);
    const context = new BrowserContext({});
    await context.navigateTo('https://a.example.com/');
    await context.cleanup();

    await context.resumeLastTab();
    expect(context.currentTabId).toBe(100);
    expect(browser.front()).toBe(1);
  });

  it('takes a follow-up to be about the page the user went to after the task', async () => {
    const browser = fakeBrowser([
      { id: 1, url: 'https://mail.example.com/inbox', active: true },
      { id: 2, url: 'https://docs.example.com/', active: false },
    ]);
    const context = new BrowserContext({});
    await context.navigateTo('https://a.example.com/');
    await context.cleanup();
    await browser.api.update(2, { active: true });

    await context.resumeLastTab();
    expect(context.currentTabId).toBeNull();
  });

  it('works as before with both settings off', async () => {
    const browser = fakeBrowser([{ id: 1, url: 'https://mail.example.com/inbox', active: true }]);
    const context = new BrowserContext({ workInBackground: false, protectUserTabs: false });
    await context.navigateTo('https://a.example.com/');
    expect(browser.api.create).not.toHaveBeenCalled();
    await context.openTab('https://b.example.com/');
    expect(browser.api.create).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    expect(browser.front()).toBe(100);
  });
});
