import { describe, expect, it } from 'vitest';
import { isPageStateOutdated, isUrlAllowed, pickOpenedTab } from '../util';

describe('isUrlAllowed', () => {
  it('allows everything when both lists are empty, except dangerous schemes', () => {
    expect(isUrlAllowed('https://example.com', [], [])).toBe(true);
    expect(isUrlAllowed('chrome://settings', [], [])).toBe(false);
    expect(isUrlAllowed('file:///etc/passwd', [], [])).toBe(false);
  });

  it('matches a bare domain and its subdomains', () => {
    const allow = ['example.com'];
    expect(isUrlAllowed('https://example.com/a', allow, [])).toBe(true);
    expect(isUrlAllowed('https://www.example.com', allow, [])).toBe(true);
    expect(isUrlAllowed('https://badexample.com', allow, [])).toBe(false);
    expect(isUrlAllowed('https://other.com', allow, [])).toBe(false);
  });

  it('treats *.domain like a bare domain', () => {
    expect(isUrlAllowed('https://a.example.com', ['*.example.com'], [])).toBe(true);
    expect(isUrlAllowed('https://example.com', ['*.example.com'], [])).toBe(true);
  });

  it('matches paths as segment prefixes', () => {
    const allow = ['github.com/org/'];
    expect(isUrlAllowed('https://github.com/org', allow, [])).toBe(true);
    expect(isUrlAllowed('https://github.com/org/repo?tab=1', allow, [])).toBe(true);
    expect(isUrlAllowed('https://github.com/organic', allow, [])).toBe(false);
    expect(isUrlAllowed('https://github.com/', allow, [])).toBe(false);
  });

  it('lets a blocked entry beat an allowed one, even a more specific one', () => {
    expect(isUrlAllowed('https://github.com/org/repo', ['github.com/org'], ['github.com'])).toBe(false);
    expect(isUrlAllowed('https://github.com/org/secret', ['github.com'], ['github.com/org/secret'])).toBe(false);
    expect(isUrlAllowed('https://github.com/org/public', ['github.com'], ['github.com/org/secret'])).toBe(true);
  });

  it('allows unblocked sites when only the blocked list has entries', () => {
    expect(isUrlAllowed('https://ok.com', [], ['bad.com'])).toBe(true);
    expect(isUrlAllowed('https://x.bad.com', [], ['bad.com'])).toBe(false);
  });

  it('pins the port only when the entry has one', () => {
    expect(isUrlAllowed('http://localhost:3000/x', ['localhost:3000'], [])).toBe(true);
    expect(isUrlAllowed('http://localhost:4000/x', ['localhost:3000'], [])).toBe(false);
    expect(isUrlAllowed('http://localhost:4000/x', ['localhost'], [])).toBe(true);
  });

  it('still lets about:blank through when rules exist', () => {
    expect(isUrlAllowed('about:blank', ['example.com'], [])).toBe(true);
  });
});

describe('isPageStateOutdated', () => {
  const google = 'https://www.google.com/search?q=huggingface%20papers';

  it('keeps the state of a page that is still in the tab', () => {
    expect(isPageStateOutdated(google, google, google)).toBe(false);
  });

  it('drops the state once the tab shows the error page of a failed load', () => {
    expect(isPageStateOutdated(google, 'https://huggingface.co/papers', 'chrome-error://chromewebdata/')).toBe(true);
    // reloading the same address failed
    expect(isPageStateOutdated(google, google, 'chrome-error://chromewebdata/')).toBe(true);
  });

  it('drops the state once the tab has gone to another address', () => {
    expect(isPageStateOutdated(google, 'https://arxiv.org/list/cs.AI/recent', '')).toBe(true);
  });

  it('keeps the state when the address of the tab is unknown', () => {
    expect(isPageStateOutdated(google, '', google)).toBe(false);
  });
});

describe('pickOpenedTab', () => {
  const before = new Set([1, 2, 3]);

  it('takes the tab the clicked tab opened', () => {
    expect(pickOpenedTab([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 10, openerTabId: 2 }], before, 2)).toBe(10);
  });

  it('passes over a tab the browser put to sleep, which comes back under a new id', () => {
    // the bilibili run: 热门 opened a tab while Edge put a grok.com tab to sleep
    const tabs = [{ id: 1 }, { id: 3 }, { id: 9, discarded: true }, { id: 10, openerTabId: 2 }, { id: 2 }];
    expect(pickOpenedTab(tabs, before, 2)).toBe(10);
    expect(pickOpenedTab([{ id: 1 }, { id: 2 }, { id: 9, discarded: true }], before, 2)).toBeUndefined();
  });

  it('passes over a tab another page or the user opened meanwhile', () => {
    expect(
      pickOpenedTab([{ id: 1 }, { id: 2 }, { id: 9, openerTabId: 3 }, { id: 10, openerTabId: 2 }], before, 2),
    ).toBe(10);
  });

  it('takes a lone new tab without an opener, but not one of several', () => {
    expect(pickOpenedTab([{ id: 1 }, { id: 2 }, { id: 10 }], before, 2)).toBe(10);
    expect(pickOpenedTab([{ id: 1 }, { id: 2 }, { id: 9 }, { id: 10 }], before, 2)).toBeUndefined();
  });

  it('finds nothing when no tab was opened', () => {
    expect(pickOpenedTab([{ id: 1 }, { id: 2 }, { id: 3 }], before, 2)).toBeUndefined();
  });
});
