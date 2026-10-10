/*
 * Messages a page shows only for a moment: a toast ("Login failed"), the hint that appears under a field
 * ("Password must be 8-16 characters"), the browser's own bubble for a field that fails its format, an alert.
 * They are often gone before the next read of the page, so the agent never learnt why a click did nothing.
 * A watcher in the page writes each one down as it appears, and the agent is told what was shown since it
 * last looked.
 *
 * watchPageNotices runs in the page: it is passed to page.evaluate and must not use anything outside.
 */

export const NOTICES_KEY = '__nbPageNotices';

export interface PageNotice {
  /** Date.now() when it appeared */
  t: number;
  text: string;
}

/** Installs the watcher once per document; the log is kept on window under `key` */
export function watchPageNotices(key: string): void {
  const w = window as unknown as Record<string, PageNotice[] | undefined>;
  if (w[key]) return;
  const log: PageNotice[] = [];
  Object.defineProperty(window, key, { value: log, enumerable: false });

  const MAX_TEXT = 200;
  // class names toast and message libraries give their boxes, and those of field hints and errors
  const noticeClass =
    /(^|[-_])(toast|toastify|snackbar|notification|notice|notify|message|msg|alert|error|errors|invalid|warning|warn|explain|feedback|tip|tips|hint)([-_]|$)/i;
  const ownIds = ['nanobrowser-agent-mark', 'playwright-highlight-container'];

  const record = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length < 2 || flat.length > MAX_TEXT) return;
    const now = Date.now();
    // the same message rendered again as a new box, not shown again
    if (log.some(n => n.text === flat && now - n.t < 1000)) return;
    log.push({ t: now, text: flat });
    if (log.length > 30) log.splice(0, log.length - 30);
  };

  /** The notice box an element belongs to, or null when it is ordinary page content */
  const noticeOf = (el: Element): Element | null => {
    let n: Element | null = el;
    for (let depth = 0; n && n !== document.body && n !== document.documentElement && depth < 5; depth++) {
      if (ownIds.includes(n.id)) return null;
      if ((n as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT|OPTION|SCRIPT|STYLE)$/.test(n.tagName)) {
        return null;
      }
      const role = n.getAttribute('role');
      const live = n.getAttribute('aria-live');
      if (role === 'alert' || role === 'alertdialog' || role === 'status') return n;
      if (live === 'assertive' || live === 'polite') return n;
      if (n.hasAttribute('data-sonner-toast')) return n;
      const cls = n.getAttribute('class') || '';
      if (cls && cls.split(/\s+/).some(c => noticeClass.test(c))) return n;
      n = n.parentElement;
    }
    return null;
  };

  // what each box showed last: an animated toast changes its style every frame while its text stays
  const shown = new WeakMap<Element, string>();
  const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();

  const observer = new MutationObserver(mutations => {
    const seen = new Set<Element>();
    for (const m of mutations) {
      const targets: Element[] = [];
      if (m.type === 'childList') {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof Element) targets.push(node);
          else if (node.parentElement) targets.push(node.parentElement);
        }
      } else {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (el) targets.push(el);
      }
      for (const target of targets) {
        if (seen.size >= 20) break;
        const box = noticeOf(target);
        if (!box || seen.has(box)) continue;
        seen.add(box);
        // a big notice region (a whole form marked has-error) is told by the part that changed
        let text = textOf(box);
        if (text.length > MAX_TEXT) text = textOf(target);
        // hidden boxes read as empty, so the same text shown again counts once more
        if (!text) shown.delete(box);
        else if (shown.get(box) !== text) {
          shown.set(box, text);
          record(text);
        }
      }
    }
  });
  const start = () =>
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // the browser's own bubble for a field that fails its constraints is not in the page: its text is the field's
  document.addEventListener(
    'invalid',
    event => {
      const field = event.target as HTMLInputElement;
      if (!field?.validationMessage) return;
      const name =
        field.getAttribute('aria-label') || field.getAttribute('placeholder') || field.name || field.id || 'a field';
      record(`${name}: ${field.validationMessage}`);
    },
    true,
  );
}

/** Notices for the model, newest last; null when there are none */
export function describeNotices(texts: string[]): string | null {
  const unique = texts.filter((text, i) => texts.indexOf(text) === i);
  if (unique.length === 0) return null;
  return unique.map(text => `"${text}"`).join('; ');
}

/** How an action's result tells the notices that came up while it ran */
export const pageShowed = (notices: string) => `the page showed briefly: ${notices}`;
