import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import { identityKeys, identityOf, PendingClickTracker, PENDING_CLICK_REASON } from '../elementIdentity';

function el(tagName: string, xpath: string, attributes: Record<string, string> = {}, text = '') {
  const node = new DOMElementNode({
    tagName,
    xpath,
    attributes,
    children: text ? [new DOMTextNode(text, true)] : [],
    isVisible: true,
    isInteractive: true,
    highlightIndex: 1,
  });
  node.children.forEach(child => (child.parent = node));
  return node;
}

const URL = 'https://example.com/ticket/1';

describe('element identity', () => {
  it('knows an element by what it reads, not by the number it carried', () => {
    const button = el('button', 'html/body/div/form/button', {}, 'Submit Reply');
    const identity = identityOf(button, URL);
    expect(identity).toBeTruthy();
    // the same button, another number in a later step
    expect(identityOf(button, URL)).toBe(identity);
  });

  it('tells two buttons with different text apart', () => {
    const one = el('button', 'html/body/div[1]/button', {}, 'Submit');
    const other = el('button', 'html/body/div[2]/button', {}, 'Cancel');
    expect(identityOf(one, URL)).not.toBe(identityOf(other, URL));
  });

  it('keeps the identity when the numbers on the way to it shift', () => {
    const before = el('button', 'html/body/div[1]/span/button', {}, 'Submit Reply');
    const after = el('button', 'html/body/div[2]/span/button', {}, 'Submit Reply');
    expect(identityOf(after, URL)).toBe(identityOf(before, URL));
  });

  it('says nothing about an element it does not know', () => {
    expect(identityOf(undefined, URL)).toBeNull();
    expect(identityKeys(undefined, URL)).toEqual([]);
  });

  it('tells pages apart', () => {
    const button = el('button', 'html/body/button', {}, 'Send');
    expect(identityOf(button, 'https://example.com/a')).not.toBe(identityOf(button, 'https://example.com/b'));
  });
});

describe('PendingClickTracker', () => {
  it('holds a control that started a request for the steps that follow', () => {
    const tracker = new PendingClickTracker();
    const button = el('button', 'html/body/form/button', {}, 'Submit Reply');
    expect(tracker.reason(button, URL)).toBeNull();
    tracker.mark(button, URL);
    expect(tracker.reason(button, URL)).toBe(PENDING_CLICK_REASON);
    // the mark ages with every step and falls away
    tracker.age();
    expect(tracker.reason(button, URL)).toBe(PENDING_CLICK_REASON);
    tracker.age();
    expect(tracker.reason(button, URL)).toBe(PENDING_CLICK_REASON);
    tracker.age();
    expect(tracker.reason(button, URL)).toBeNull();
  });

  it('knows the same button after the page renumbered it', () => {
    const tracker = new PendingClickTracker();
    tracker.mark(el('button', 'html/body/form/button', {}, 'Submit Reply'), URL);
    const renumbered = el('button', 'html/body/form[2]/button', {}, 'Submit Reply');
    expect(tracker.reason(renumbered, URL)).toBe(PENDING_CLICK_REASON);
  });

  it('leaves other controls alone', () => {
    const tracker = new PendingClickTracker();
    tracker.mark(el('button', 'html/body/form/button', {}, 'Submit Reply'), URL);
    expect(tracker.reason(el('button', 'html/body/form/button', {}, 'Cancel'), URL)).toBeNull();
  });

  it('starts over after a reset', () => {
    const tracker = new PendingClickTracker();
    const button = el('button', 'html/body/form/button', {}, 'Submit Reply');
    tracker.mark(button, URL);
    tracker.reset();
    expect(tracker.reason(button, URL)).toBeNull();
  });
});
