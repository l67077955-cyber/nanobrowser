import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type PageType from '../page';
import type BrowserContextType from '../context';

vi.mock('webextension-polyfill', () => ({}));
vi.mock('../../services/analytics', () => ({ analytics: { trackDomainVisit: async () => {} } }));

const puppeteer = vi.hoisted(() => ({
  connectTab: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js', () => ({
  connect: puppeteer.connect,
  ExtensionTransport: { connectTab: puppeteer.connectTab },
}));

let Page: typeof PageType;
let BrowserContext: typeof BrowserContextType;
beforeAll(async () => {
  ({ default: Page } = await import('../page'));
  ({ default: BrowserContext } = await import('../context'));
});

function fakePuppeteerPage() {
  return {
    evaluateOnNewDocument: vi.fn(async () => {}),
    frames: () => [],
    on: vi.fn(),
  };
}

describe('Page.attachPuppeteer', () => {
  const transport = { close: vi.fn(async () => {}) };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', { debugger: { sendCommand: vi.fn(async () => ({})) } });
    puppeteer.connectTab.mockResolvedValue(transport);
  });

  it('closes the transport when connect fails, so a second attach can succeed', async () => {
    puppeteer.connect.mockRejectedValueOnce(new Error('Network.enable timed out'));
    const page = new Page(1, 'https://a.example.com/', 't');
    await expect(page.attachPuppeteer()).rejects.toThrow(/could not be attached[\s\S]*will not help/);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(page.attached).toBe(false);

    const browser = { pages: async () => [fakePuppeteerPage()], disconnect: vi.fn(async () => {}) };
    puppeteer.connect.mockResolvedValueOnce(browser);
    await expect(page.attachPuppeteer()).resolves.toBe(true);
    expect(page.attached).toBe(true);
  });

  it('disconnects the browser when pages() fails', async () => {
    const browser = {
      pages: async () => {
        throw new Error('boom');
      },
      disconnect: vi.fn(async () => {}),
    };
    puppeteer.connect.mockResolvedValueOnce(browser);
    const page = new Page(1, 'https://a.example.com/', 't');
    await expect(page.attachPuppeteer()).rejects.toThrow(/could not be attached/);
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
    expect(page.attached).toBe(false);
  });

  it('wakes the tab before connecting and sets a protocol timeout', async () => {
    const browser = { pages: async () => [fakePuppeteerPage()], disconnect: vi.fn(async () => {}) };
    puppeteer.connect.mockResolvedValueOnce(browser);
    await new Page(1, 'https://a.example.com/', 't').attachPuppeteer();
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.setWebLifecycleState', {
      state: 'active',
    });
    expect(puppeteer.connect).toHaveBeenCalledWith(expect.objectContaining({ protocolTimeout: 30_000 }));
  });

  it('drops its puppeteer refs even when disconnect throws', async () => {
    const browser = {
      pages: async () => [fakePuppeteerPage()],
      disconnect: vi.fn(async () => {
        throw new Error('already gone');
      }),
    };
    puppeteer.connect.mockResolvedValueOnce(browser);
    const page = new Page(1, 'https://a.example.com/', 't');
    await page.attachPuppeteer();
    await expect(page.detachPuppeteer()).rejects.toThrow('already gone');
    expect(page.attached).toBe(false);
  });
});

describe('Page screenshot', () => {
  it('removes the animation-disabling style when the screenshot fails', async () => {
    const page = new Page(1, 'https://a.example.com/', 't');
    const evaluate = vi.fn(async () => {});
    const screenshot = vi.fn(async () => {
      throw new Error('no paint');
    });
    (page as unknown as { _puppeteerPage: unknown })._puppeteerPage = { evaluate, screenshot };
    await expect(page.takeScreenshot()).rejects.toThrow('no paint');
    // style added, then removed
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

/** A context with fake pages, to see what attaches and detaches */
describe('BrowserContext attach lifecycle', () => {
  const pages: Record<number, { detach: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> }> = {};
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, url: `https://t${id}.example.com/`, title: 't', status: 'complete' })),
        query: vi.fn(async () => []),
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
      },
      windows: { getLastFocused: async () => ({ id: 1 }) },
    });
  });

  /** Inject pages in place of real ones by seeding the context's map */
  function seed(context: BrowserContextType, tabId: number, opts: { detachFails?: boolean } = {}) {
    const page = {
      tabId,
      removeHighlight: vi.fn(async () => {}),
      clearAgentMark: vi.fn(async () => {}),
      detachPuppeteer: vi.fn(async () => {
        if (opts.detachFails) throw new Error('detach failed');
      }),
      forgetPuppeteer: vi.fn(),
    };
    (context as unknown as { _attachedPages: Map<number, unknown> })._attachedPages.set(tabId, page);
    return page;
  }

  it('cleanup detaches every page even if one throws, and clears the map', async () => {
    const context = new BrowserContext({});
    const a = seed(context, 1, { detachFails: true });
    const b = seed(context, 2);
    context.updateCurrentTabId(1);
    await expect(context.cleanup()).resolves.toBeUndefined();
    expect(a.detachPuppeteer).toHaveBeenCalled();
    expect(b.detachPuppeteer).toHaveBeenCalled();
    expect((context as unknown as { _attachedPages: Map<number, unknown> })._attachedPages.size).toBe(0);
    expect(context.currentTabId).toBeNull();
  });

  it('cleanup does not attach a tab just to remove highlights', async () => {
    const context = new BrowserContext({});
    context.updateCurrentTabId(5);
    await context.cleanup();
    expect(puppeteer.connectTab).not.toHaveBeenCalled();
  });

  it('forgetAttachedPage forgets the page without detaching it', () => {
    const context = new BrowserContext({});
    const a = seed(context, 1);
    context.forgetAttachedPage(1);
    expect(a.forgetPuppeteer).toHaveBeenCalled();
    expect(a.detachPuppeteer).not.toHaveBeenCalled();
    expect((context as unknown as { _attachedPages: Map<number, unknown> })._attachedPages.has(1)).toBe(false);
    expect(() => context.forgetAttachedPage(99)).not.toThrow();
  });

  it('concurrent switchTab to the same tab attaches once', async () => {
    const browser = { pages: async () => [fakePuppeteerPage()], disconnect: vi.fn(async () => {}) };
    puppeteer.connectTab.mockResolvedValue({ close: vi.fn() });
    puppeteer.connect.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      return browser;
    });
    (chrome.debugger as unknown) = { sendCommand: vi.fn(async () => ({})) };
    const context = new BrowserContext({});
    const [p1, p2] = await Promise.all([context.switchTab(7), context.switchTab(7)]);
    expect(p1).toBe(p2);
    expect(puppeteer.connectTab).toHaveBeenCalledTimes(1);
  });

  it('a failed switchTab keeps the old tab and a retry can attach', async () => {
    puppeteer.connectTab.mockResolvedValue({ close: vi.fn(async () => {}) });
    puppeteer.connect.mockRejectedValueOnce(new Error('hang'));
    const browser = { pages: async () => [fakePuppeteerPage()], disconnect: vi.fn(async () => {}) };
    puppeteer.connect.mockResolvedValueOnce(browser);
    vi.stubGlobal('chrome', { ...chrome, debugger: { sendCommand: vi.fn(async () => ({})) } });
    const context = new BrowserContext({});
    context.updateCurrentTabId(3);
    await expect(context.switchTab(8)).rejects.toThrow(/could not be attached/);
    expect(context.currentTabId).toBe(3);
    await expect(context.switchTab(8)).resolves.toBeDefined();
    expect(context.currentTabId).toBe(8);
  });
});
