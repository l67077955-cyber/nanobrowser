import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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

/** Seeded PRNG (fast-check is not a dependency) */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const ITERATIONS = 200;
const BASE_SEED = 20261010;
const TABS = [1, 2, 3];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface FakeTransport {
  id: number;
  tabId: number;
  closed: boolean;
  /** the debugger went away by itself (tab closed, devtools): nothing is left to close */
  dead: boolean;
  close: () => Promise<void>;
}

/** A world of fake puppeteer whose steps fail or wait, decided by the seed; waiting steps are released by the test */
function world(rnd: () => number, rates: { connectTab: number; connect: number; pages: number; setup: number }) {
  const transports: FakeTransport[] = [];
  const pending: (() => void)[] = [];
  const log: string[] = [];
  const gate = (label: string, failRate: number): Promise<void> => {
    const fail = rnd() < failRate;
    const delayed = rnd() < 0.5;
    log.push(`${label}:${fail ? 'fail' : 'ok'}${delayed ? ',late' : ''}`);
    return new Promise<void>((resolve, reject) => {
      const fire = () => (fail ? reject(new Error(`${label} failed`)) : resolve());
      if (delayed) pending.push(fire);
      else fire();
    });
  };
  puppeteer.connectTab.mockImplementation(async (tabId: number) => {
    await gate(`connectTab(${tabId})`, rates.connectTab);
    const transport: FakeTransport = {
      id: transports.length,
      tabId,
      closed: false,
      dead: false,
      close: async () => {
        transport.closed = true;
      },
    };
    transports.push(transport);
    return transport;
  });
  puppeteer.connect.mockImplementation(async (opts: { transport: FakeTransport }) => {
    await gate(`connect(${opts.transport.tabId})`, rates.connect);
    return {
      transport: opts.transport,
      pages: async () => {
        await gate(`pages(${opts.transport.tabId})`, rates.pages);
        return [
          {
            evaluateOnNewDocument: vi.fn(async () => {
              await gate(`setup(${opts.transport.tabId})`, rates.setup);
            }),
            frames: () => [],
            on: vi.fn(),
          },
        ];
      },
      disconnect: async () => {
        opts.transport.closed = true;
      },
    };
  });
  return {
    transports,
    log,
    pendingCount: () => pending.length,
    releaseOne: () => {
      if (pending.length === 0) return;
      pending.splice(int(rnd, 0, pending.length - 1), 1)[0]();
    },
  };
}

type Internals = {
  _attachedPages: Map<number, { tabId: number; _browser: { transport: FakeTransport } | null }>;
  _attaching: Map<number, Promise<unknown>>;
};

function stubChrome() {
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: `https://t${id}.example.com/`, title: 't', status: 'complete' })),
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: () => {}, removeListener: () => {} },
    },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    debugger: { sendCommand: vi.fn(async () => ({})) },
  });
}

/** The invariants that hold at every quiet moment; returns the first one broken */
function brokenInvariant(context: BrowserContextType, transports: FakeTransport[]): string | null {
  const internals = context as unknown as Internals;
  const pages = [...internals._attachedPages.entries()];
  for (const [key, page] of pages) {
    if (page.tabId !== key) return `map key ${key} holds the page of tab ${page.tabId}`;
    const transport = page._browser?.transport;
    if (!transport) return `page of tab ${key} is in the map but not attached`;
    if (transport.closed) return `page of tab ${key} is in the map with a closed transport`;
  }
  for (const tr of transports) {
    if (tr.closed || tr.dead) continue;
    const owners = pages.filter(([, page]) => page._browser?.transport === tr).length;
    if (owners !== 1) return `transport #${tr.id} of tab ${tr.tabId} is open and has ${owners} owners (leaked attachment)`;
  }
  for (const tabId of TABS) {
    const live = transports.filter(tr => tr.tabId === tabId && !tr.closed && !tr.dead).length;
    if (live > 1) return `tab ${tabId} has ${live} live attachments`;
  }
  return null;
}

type Op = { kind: 'switch'; tabId: number } | { kind: 'cleanup' } | { kind: 'forget'; tabId: number };

describe('BrowserContext attach lifecycle (random interleavings)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubChrome();
  });

  /** setup failures (the tab dies right after the connection) are tried on their own, see below */
  const RATES = { connectTab: 0.2, connect: 0.2, pages: 0.2, setup: 0 };

  it(`serial random ops: a failed switchTab never moves the current tab (${ITERATIONS} runs)`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + i;
      const rnd = mulberry32(seed);
      const w = world(rnd, { ...RATES, setup: 0 });
      const context = new BrowserContext({ workInBackground: true } as never);
      const history: string[] = [];
      const where = () => `seed=${seed} ops=[${history.join(' ')}] steps=[${w.log.join(' ')}]`;
      // gates that wait are released right away, in this mode
      const settle = async <T>(p: Promise<T>) => {
        let done = false;
        const watched = p.finally(() => (done = true));
        watched.catch(() => {});
        while (!done) {
          w.releaseOne();
          await tick();
        }
        return watched;
      };
      const n = int(rnd, 3, 12);
      for (let k = 0; k < n; k++) {
        const r = rnd();
        if (r < 0.6) {
          const tabId = TABS[int(rnd, 0, TABS.length - 1)];
          const before = context.currentTabId;
          history.push(`switch(${tabId})`);
          let ok = true;
          await settle(context.switchTab(tabId)).catch(() => (ok = false));
          history[history.length - 1] += ok ? '=ok' : '=fail';
          expect(context.currentTabId, `${ok ? 'switch moves' : 'failed switch moved'} the tab: ${where()}`).toBe(
            ok ? tabId : before,
          );
        } else if (r < 0.8) {
          history.push('cleanup');
          await settle(context.cleanup());
          expect((context as unknown as Internals)._attachedPages.size, `cleanup left pages: ${where()}`).toBe(0);
          expect(w.transports.every(tr => tr.closed || tr.dead), `cleanup left transports open: ${where()}`).toBe(true);
          expect(context.currentTabId, `cleanup kept a current tab: ${where()}`).toBeNull();
        } else {
          const tabId = TABS[int(rnd, 0, TABS.length - 1)];
          history.push(`forget(${tabId})`);
          const page = (context as unknown as Internals)._attachedPages.get(tabId);
          if (page?._browser) page._browser.transport.dead = true;
          context.forgetAttachedPage(tabId);
        }
        const broken = brokenInvariant(context, w.transports);
        expect(broken, `${broken}: ${where()}`).toBeNull();
      }
    }
  }, 60_000);

  it(`concurrent random ops settle without leaks (${ITERATIONS} runs)`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + 1000 + i;
      const rnd = mulberry32(seed);
      const w = world(rnd, RATES);
      const context = new BrowserContext({ workInBackground: true } as never);
      const internals = context as unknown as Internals;
      const history: string[] = [];
      const where = () => `seed=${seed} ops=[${history.join(' ')}] steps=[${w.log.join(' ')}]`;
      const succeeded = new Set<number>();
      const forgotten = new Set<number>();
      let sawCleanup = false;
      let inFlight = 0;
      const running: Promise<unknown>[] = [];
      const n = int(rnd, 3, 12);
      for (let k = 0; k < n; k++) {
        const r = rnd();
        const tabId = TABS[int(rnd, 0, TABS.length - 1)];
        const op: Op = r < 0.6 ? { kind: 'switch', tabId } : r < 0.8 ? { kind: 'cleanup' } : { kind: 'forget', tabId };
        if (op.kind === 'switch') {
          history.push(`switch(${tabId})`);
          inFlight++;
          running.push(
            context
              .switchTab(tabId)
              .then(() => succeeded.add(tabId))
              .catch(() => {})
              .finally(() => inFlight--),
          );
        } else if (op.kind === 'cleanup') {
          history.push('cleanup');
          sawCleanup = true;
          inFlight++;
          running.push(context.cleanup().finally(() => inFlight--));
        } else {
          history.push(`forget(${tabId})`);
          const page = internals._attachedPages.get(tabId);
          if (page?._browser) page._browser.transport.dead = true;
          forgotten.add(tabId);
          context.forgetAttachedPage(tabId);
        }
        for (let j = int(rnd, 0, 2); j > 0; j--) {
          w.releaseOne();
          await tick();
        }
      }
      let guard = 0;
      while (inFlight > 0 || w.pendingCount() > 0) {
        if (guard++ > 5000) throw new Error(`did not settle: ${where()}`);
        w.releaseOne();
        await tick();
      }
      await Promise.all(running);

      const broken = brokenInvariant(context, w.transports);
      expect(broken, `${broken}: ${where()}`).toBeNull();
      expect(internals._attaching.size, `attach left in the _attaching map: ${where()}`).toBe(0);

      // the current tab: nothing, or a tab that was switched to; and its page is there unless its debugger was forgotten
      const current = context.currentTabId;
      if (current !== null) {
        expect(succeeded.has(current), `current tab ${current} was never switched to successfully: ${where()}`).toBe(true);
        if (!forgotten.has(current)) {
          expect(internals._attachedPages.has(current), `current tab ${current} has no live page: ${where()}`).toBe(true);
        }
      }
      if (!sawCleanup && !forgotten.size) {
        // nothing ever clears a page: every tab switched to successfully is attached
        for (const t of succeeded) expect(internals._attachedPages.has(t), `tab ${t} lost its page: ${where()}`).toBe(true);
      }

      // cleanup at the end leaves nothing behind
      await context.cleanup();
      expect(internals._attachedPages.size, `pages left after cleanup: ${where()}`).toBe(0);
      expect(context.currentTabId, where()).toBeNull();
      const open = w.transports.filter(tr => !tr.closed && !tr.dead);
      expect(open.map(tr => tr.id), `transports open after cleanup: ${where()}`).toEqual([]);
    }
  }, 60_000);

  it('a tab whose forgotten debugger is asked for again attaches afresh (random)', async () => {
    for (let i = 0; i < 50; i++) {
      const seed = BASE_SEED + 2000 + i;
      const rnd = mulberry32(seed);
      const w = world(rnd, { connectTab: 0, connect: 0, pages: 0, setup: 0 });
      const context = new BrowserContext({ workInBackground: true } as never);
      const tabId = TABS[int(rnd, 0, TABS.length - 1)];
      const settle = async <T>(p: Promise<T>) => {
        let done = false;
        const watched = p.finally(() => (done = true));
        while (!done) {
          w.releaseOne();
          await tick();
        }
        return watched;
      };
      const rounds = int(rnd, 1, 5);
      for (let k = 0; k < rounds; k++) {
        await settle(context.switchTab(tabId));
        const page = (context as unknown as Internals)._attachedPages.get(tabId);
        page!._browser!.transport.dead = true;
        context.forgetAttachedPage(tabId);
        expect(brokenInvariant(context, w.transports), `seed=${seed} round=${k}`).toBeNull();
        // the current tab has no page now: the next read of the current page attaches it again
        const again = await settle(context.getCurrentPage());
        expect(again.attached, `seed=${seed} round=${k}`).toBe(true);
        expect(brokenInvariant(context, w.transports), `seed=${seed} round=${k}`).toBeNull();
        (context as unknown as Internals)._attachedPages.get(tabId)!._browser!.transport.dead = true;
        context.forgetAttachedPage(tabId);
      }
    }
  }, 60_000);

  // Found by this file: a failure right after the connection (the tab dies during the setup of the page) leaves the
  // connection open, owned by no one. Fixed: the setup now runs inside the cleanup try.
  it('setup failure after connect leaks no attachment (random)', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + 3000 + i;
      const rnd = mulberry32(seed);
      const w = world(rnd, { connectTab: 0, connect: 0, pages: 0, setup: 0.5 });
      const context = new BrowserContext({ workInBackground: true } as never);
      const history: string[] = [];
      for (let k = 0; k < int(rnd, 1, 6); k++) {
        const tabId = TABS[int(rnd, 0, TABS.length - 1)];
        history.push(`switch(${tabId})`);
        let done = false;
        const p = context.switchTab(tabId).catch(() => {}).finally(() => (done = true));
        while (!done) {
          w.releaseOne();
          await tick();
        }
        await p;
      }
      const broken = brokenInvariant(context, w.transports);
      expect(broken, `${broken}: seed=${seed} ops=[${history.join(' ')}] steps=[${w.log.join(' ')}]`).toBeNull();
    }
  }, 60_000);
});

describe('BrowserContext cleanup racing an attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubChrome();
  });

  // Found by this file while reasoning about interleavings (deterministic, no seed needed): cleanup() clears
  // _attachedPages while a switchTab is still attaching; the attach then adds its page to the emptied map and
  // sets _currentTabId, so the debugger stays on the user's tab after the task ended. Arguable severity (the next
  // cleanup() closes it); fixed by the cleanup generation in context.ts.
  it('a switchTab still attaching when cleanup runs leaves nothing attached afterwards', async () => {
    const w = world(() => 0.1, { connectTab: 0, connect: 0, pages: 0, setup: 0 }); // rnd .1: no step fails, every one waits
    const context = new BrowserContext({ workInBackground: true } as never);
    const switching = context.switchTab(1).catch(() => {});
    for (let k = 0; k < 3; k++) {
      await tick();
      w.releaseOne();
    }
    await tick();
    // connectTab and connect are through; pages() is what the attach waits for
    const cleaning = context.cleanup();
    await cleaning;
    while (w.pendingCount() > 0) {
      w.releaseOne();
      await tick();
    }
    await switching;
    expect((context as unknown as Internals)._attachedPages.size).toBe(0);
    expect(w.transports.filter(tr => !tr.closed && !tr.dead).length).toBe(0);
    expect(context.currentTabId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('Page screenshot style cleanup (random failures and timeouts)', () => {
  const STYLE_ID = 'puppeteer-disable-animations';
  let styles: Set<string>;
  beforeEach(() => {
    styles = new Set();
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      getElementById: (id: string) => (styles.has(id) ? { remove: () => styles.delete(id) } : null),
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (el: { id: string }) => styles.add(el.id) },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never leaves the style injected, whatever fails, stalls or times out (200 runs)', async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + 4000 + i;
      const rnd = mulberry32(seed);
      const injectMode = (['ok', 'fail', 'late'] as const)[int(rnd, 0, 2)];
      const shotMode = (['ok', 'fail', 'hang-then-ok', 'hang-then-fail'] as const)[int(rnd, 0, 3)];
      const withMarkWrapper = rnd() < 0.5; // through the model's path (5 s timeout) or the plain call
      const trace: string[] = [];
      const where = () => `seed=${seed} trace=${trace.join("|")} inject=${injectMode} shot=${shotMode} viaModelPath=${withMarkWrapper}`;

      const release: (() => void)[] = [];
      const evaluate = vi.fn(async (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => {
        if (!String(fn).includes(STYLE_ID)) return undefined; // the agent mark and the like
        const injects = String(fn).includes('createElement');
        trace.push(injects ? 'inject' : 'remove');
        if (injects && injectMode === 'fail') throw new Error('evaluate failed');
        if (injects && injectMode === 'late') await new Promise<void>(resolve => release.push(resolve));
        return fn(...args);
      });
      const screenshot = vi.fn(async () => {
        if (shotMode === 'fail') throw new Error('no paint');
        if (shotMode === 'ok') return 'data';
        await new Promise<void>(resolve => release.push(resolve));
        if (shotMode === 'hang-then-fail') throw new Error('late failure');
        return 'late data';
      });
      const page = new Page(1, 'https://a.example.com/', 't');
      (page as unknown as { _puppeteerPage: unknown })._puppeteerPage = { evaluate, screenshot };

      const call = withMarkWrapper
        ? (page as unknown as { screenshotWithoutMark: () => Promise<string | null> }).screenshotWithoutMark()
        : page.takeScreenshot();
      let outcome: 'pending' | 'settled' = 'pending';
      const watched = call.then(
        () => (outcome = 'settled'),
        () => (outcome = 'settled'),
      );
      // time passes (and past the model's 5 s limit) with some steps still stalled, then everything is let go
      for (let step = 0; step < 4; step++) {
        await vi.advanceTimersByTimeAsync(rnd() < 0.5 ? 6000 : 10);
        if (rnd() < 0.5) release.shift()?.();
        for (let m = 0; m < 50; m++) await Promise.resolve();
      }
      for (let guard = 0; guard < 20 && (outcome === 'pending' || release.length > 0); guard++) {
        release.shift()?.();
        await vi.advanceTimersByTimeAsync(6000);
        for (let m = 0; m < 50; m++) await Promise.resolve();
      }
      await watched;
      await vi.advanceTimersByTimeAsync(10);
      expect(outcome, where()).toBe("settled");
      expect(styles.has(STYLE_ID), `style left injected: ${where()}`).toBe(false);
    }
  }, 60_000);
});
