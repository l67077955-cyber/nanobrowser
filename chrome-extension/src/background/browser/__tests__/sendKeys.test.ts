import { describe, it, expect, vi, beforeAll } from 'vitest';
import type PageType from '../page';

vi.mock('webextension-polyfill', () => ({}));
vi.mock('../../services/analytics', () => ({ analytics: { trackDomainVisit: async () => {} } }));
vi.mock('puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js', () => ({
  connect: vi.fn(),
  ExtensionTransport: { connectTab: vi.fn() },
}));

let Page: typeof PageType;
beforeAll(async () => {
  ({ default: Page } = await import('../page'));
});

/** A page whose text reads as `texts` in turn, the last one from then on */
function pageReading(texts: string[]) {
  let read = 0;
  const puppeteerPage = {
    keyboard: { press: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) },
    evaluate: vi.fn(async () => {
      const sig = texts[Math.min(read++, texts.length - 1)];
      return { url: 'https://mail.google.com/mail/u/0/#search/contabo', sig, modals: 0, errors: '' };
    }),
  };
  const page = new Page(1, 'https://mail.google.com/mail/u/0/#inbox', 'Gmail');
  (page as unknown as { _puppeteerPage: unknown })._puppeteerPage = puppeteerPage;
  vi.spyOn(page, 'waitForPageAndFramesLoad').mockResolvedValue();
  return { page, puppeteerPage };
}

describe('Page.sendKeys', () => {
  it('after Enter, waits for the page that a single-page app shows late (a Gmail search)', async () => {
    // read before the key, then the inbox twice more before the results show and hold
    const { page, puppeteerPage } = pageReading(['inbox', 'inbox', 'inbox', 'results', 'results', 'later']);
    await page.sendKeys('Enter');
    expect(puppeteerPage.keyboard.press).toHaveBeenCalledWith('Enter');
    expect(puppeteerPage.evaluate).toHaveBeenCalledTimes(5);
  });

  it('gives up waiting when the page never changes', async () => {
    const { page, puppeteerPage } = pageReading(['same']);
    const start = Date.now();
    await page.sendKeys('Enter');
    expect(Date.now() - start).toBeLessThan(4000);
    expect(puppeteerPage.evaluate.mock.calls.length).toBeGreaterThan(2);
  });

  it('does not wait after other keys', async () => {
    const { page, puppeteerPage } = pageReading(['menu']);
    await page.sendKeys('Escape');
    expect(puppeteerPage.evaluate).not.toHaveBeenCalled();
  });
});
