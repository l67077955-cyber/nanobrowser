import { describe, expect, it } from 'vitest';
import { isUrlAllowed } from '../util';

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
