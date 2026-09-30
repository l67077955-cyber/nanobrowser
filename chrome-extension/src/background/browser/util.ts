import { normalizeSiteEntry } from '@extension/storage';

/**
 * Checks whether one site-access entry covers a parsed URL.
 * - `example.com` covers example.com and every subdomain, on any path
 * - `localhost:3000` also pins the port
 * - `github.com/foo` covers /foo and anything below it, not /foobar
 */
function entryMatches(entry: string, url: URL): boolean {
  const slash = entry.indexOf('/');
  const entryHost = slash === -1 ? entry : entry.slice(0, slash);
  const entryPath = slash === -1 ? '' : entry.slice(slash);

  const host = entryHost.includes(':') ? url.host : url.hostname;
  if (host !== entryHost && !host.endsWith(`.${entryHost}`)) {
    return false;
  }
  if (!entryPath) {
    return true;
  }
  const path = url.pathname.toLowerCase();
  return path === entryPath || path.startsWith(`${entryPath}/`);
}

/**
 * Checks if a URL is allowed by the site-access lists.
 * Blocked sites always win; when the allowed list is non-empty, only sites on it are reachable.
 * @param url The URL to check
 * @param allowList Allowed sites
 * @param denyList Blocked sites
 * @returns True if the URL is allowed, false otherwise
 */
export function isUrlAllowed(url: string, allowList: string[], denyList: string[]): boolean {
  // Normalize and validate input
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    return false;
  }

  const lowerCaseUrl = trimmedUrl.toLowerCase();

  // ALWAYS block dangerous/forbidden URLs, even with site access turned off
  const DANGEROUS_PREFIXES = [
    'https://chromewebstore.google.com', // scripts are not allowed to be injected into chrome web store
    'chrome-extension://',
    'chrome://',
    'javascript:',
    'data:',
    'file:',
    'vbscript:',
    'ws:',
    'wss:',
  ];

  if (DANGEROUS_PREFIXES.some(prefix => lowerCaseUrl.startsWith(prefix))) {
    return false;
  }

  const allowed = allowList.map(normalizeSiteEntry).filter(Boolean);
  const denied = denyList.map(normalizeSiteEntry).filter(Boolean);

  // No rules (or site access turned off, which passes empty lists): allow everything else
  if (allowed.length === 0 && denied.length === 0) {
    return true;
  }

  // Special case: Allow 'about:blank' explicitly
  if (trimmedUrl === 'about:blank') {
    return true;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);

    if (denied.some(entry => entryMatches(entry, parsedUrl))) {
      return false;
    }
    if (allowed.length === 0) {
      return true;
    }
    return allowed.some(entry => entryMatches(entry, parsedUrl));
  } catch (error) {
    // Invalid URL format - deny by default
    return false;
  }
}

// Check if a URL is a new tab page (about:blank or chrome://new-tab-page).
export function isNewTabPage(url: string): boolean {
  return url === 'about:blank' || url === 'chrome://new-tab-page' || url === 'chrome://new-tab-page/';
}

export function capTextLength(text: string, maxLength: number): string {
  if (text.length > maxLength) {
    return text.slice(0, maxLength) + '...';
  }
  return text;
}
