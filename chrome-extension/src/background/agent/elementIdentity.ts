import type { DOMElementNode } from '@src/background/browser/dom/views';

/**
 * How an element is known from one step to the next.
 *
 * The index an action carries is given anew every step: a toast that appears, a panel that opens, a page
 * that re-renders — the same button reads as another number. Where the element is and what it reads is
 * what stays, so that is what a repetition is counted on.
 */

/** The page a node belongs to: a hash-routed app shows its pages under one path, the hash tells them apart */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname + parsed.hash;
  } catch {
    return url;
  }
}

/** Every way to name an element: where it is, and how it reads */
export function identityKeys(node: DOMElementNode | undefined, url: string): string[] {
  if (!node) return [];
  const page = pageKey(url);
  const reads = String(node).replace(/^\[\d+\]\s*/, '');
  const keys = [`${page}|x|${node.xpath}`];
  // an element with nothing to read is known by its place alone; one that reads the same is the same
  // element only where the page has the same shape around it (a list item that moved), not every "OK"
  const shape = (node.xpath ?? '').replace(/\[\d+\]/g, '');
  if (reads !== `<${node.tagName}>`) keys.push(`${page}|l|${shape}|${reads}|${node.attributes.href ?? ''}`);
  return keys;
}

/**
 * The one name an element keeps across steps: what it reads when it reads something, else where it is.
 * The name that reads the text survives a re-render that shifts the numbers on the way to it.
 */
export function identityOf(node: DOMElementNode | undefined, url: string): string | null {
  const keys = identityKeys(node, url);
  if (keys.length === 0) return null;
  return keys.length > 1 ? keys[1] : keys[0];
}

/** Why a click on a control that is still on its way was not made */
export const PENDING_CLICK_REASON =
  'Not done: this control was clicked a moment ago and the page has not shown the result of it yet, so it was not clicked again: doing it twice would send it twice. Wait for the page to settle, then check the result (reload the page and read it) before sending anything again.';

/**
 * The controls whose last click started a request the page has not shown the result of yet.
 *
 * A form that is sent twice is sent twice: the message goes out, the order is placed, the payment is
 * made. The mark holds for the steps that follow the click, so that the page is looked at first.
 */
export class PendingClickTracker {
  /** how long a mark holds: the click is made and the mark ages with every step that follows */
  private readonly steps: number;
  private entries: { identity: string; stepsLeft: number }[] = [];

  constructor(steps = 3) {
    this.steps = steps;
  }

  /** The click on this control started a request */
  mark(node: DOMElementNode | undefined, url: string): void {
    const identity = identityOf(node, url);
    if (!identity) return;
    const known = this.entries.find(entry => entry.identity === identity);
    if (known) {
      known.stepsLeft = this.steps;
      return;
    }
    this.entries.push({ identity, stepsLeft: this.steps });
  }

  /** Why this control may not be acted on again, when its last click is still on its way */
  reason(node: DOMElementNode | undefined, url: string): string | null {
    const identity = identityOf(node, url);
    if (!identity) return null;
    return this.entries.some(entry => entry.identity === identity) ? PENDING_CLICK_REASON : null;
  }

  /** The marks grow older with every step and fall away when they are old enough */
  age(): void {
    this.entries = this.entries
      .map(entry => ({ ...entry, stepsLeft: entry.stepsLeft - 1 }))
      .filter(e => e.stepsLeft > 0);
  }

  reset(): void {
    this.entries = [];
  }
}
