/*
 * Whether an action did anything, read from the state of the page's controls rather than its text.
 *
 * Ticking a box, picking a radio or an autocomplete option, choosing a date or opening a menu changes a
 * property (checked, value, aria-expanded, aria-selected) or a class (react-datepicker__day--selected), not the
 * page text. Judged by the text alone such a click "did not visibly change" the page, the model takes it as a
 * failure and clicks again, which unticks the box it had just ticked.
 *
 * probeControls runs in the page: with 'snapshot' before the action it keeps each control's state keyed by
 * the element itself; with 'diff' after it, it names what changed. It is passed to page.evaluate and must not
 * use anything outside itself.
 */

export const CONTROLS_KEY = '__nbControlStates';

/**
 * In the page. mode 'snapshot': keep the state of every control on window under `key`. 'diff': what changed since
 * the snapshot, each as a short phrase ("the radio "Male": unchecked → checked"), at most `max`; null when
 * there is no snapshot to compare with (the page navigated).
 */
export function probeControls(key: string, mode: string, max = 8): string[] | null {
  const SELECTOR =
    'input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable="true"], details, dialog, ' +
    '[role], [aria-expanded], [aria-selected], [aria-checked], [aria-pressed], [aria-current], ' +
    '[class*=active], [class*=selected], [class*=current], [class*=checked], [class*=open]';
  // class names that mark an item as the current, chosen or open one: is-active, react-datepicker__day--selected
  const STATE_CLASS =
    /^(?:is-|has-)?(active|selected|current|checked|open|opened|expanded|highlighted)$|[-_](active|selected|current|checked|open|opened|expanded|highlighted)$/i;

  const SEP = '\u241e';
  const stateOf = (el: Element): string => {
    const parts: string[] = [];
    const shown = el.getClientRects().length > 0;
    parts.push(shown ? 'shown' : 'hidden');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        parts.push(el.checked ? 'checked' : 'unchecked');
      } else if (el instanceof HTMLInputElement && el.type === 'password') {
        parts.push(`value:(${el.value.length} chars)`);
      } else {
        parts.push(`value:${JSON.stringify(el.value.slice(0, 80))}`);
      }
    } else if (el instanceof HTMLSelectElement) {
      parts.push(`value:${JSON.stringify(el.selectedOptions[0]?.text?.trim().slice(0, 80) ?? '')}`);
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      parts.push(`value:${JSON.stringify((el.innerText || '').trim().slice(0, 80))}`);
    }
    if (el instanceof HTMLDetailsElement || el instanceof HTMLDialogElement) parts.push(el.open ? 'open' : 'closed');
    for (const name of ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-current']) {
      const value = el.getAttribute(name);
      if (value !== null) parts.push(`${name.slice(5)}:${value}`);
    }
    const classes = (typeof el.className === 'string' ? el.className : '')
      .split(/\s+/)
      .filter(c => STATE_CLASS.test(c));
    if (classes.length) parts.push(`class:${classes.sort().join(',')}`);
    if (el.ownerDocument.activeElement === el) parts.push('focused');
    // a separator no value holds: values keep their spaces
    return parts.join(SEP);
  };

  if (mode === 'snapshot') {
    const states = new Map<Element, string>();
    const all = Array.from(document.querySelectorAll(SELECTOR)).slice(0, 4000);
    for (const el of all) states.set(el, stateOf(el));
    Object.defineProperty(window, key, {
      value: { states, focus: document.activeElement },
      configurable: true,
      enumerable: false,
    });
    return [];
  }

  const saved = (window as unknown as Record<string, unknown>)[key] as
    | { states: Map<Element, string>; focus: Element | null }
    | undefined;
  if (!saved) return null;

  const label = (el: Element): string => {
    const text =
      el.getAttribute('aria-label') ||
      (el instanceof HTMLInputElement && el.labels?.[0]?.innerText) ||
      el.getAttribute('placeholder') ||
      (el instanceof HTMLElement ? el.innerText : '') ||
      el.getAttribute('title') ||
      el.getAttribute('name') ||
      el.id ||
      '';
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
  };
  const kind = (el: Element): string => {
    if (el instanceof HTMLInputElement) return el.type === 'checkbox' || el.type === 'radio' ? el.type : 'field';
    if (el instanceof HTMLTextAreaElement) return 'field';
    if (el instanceof HTMLSelectElement) return 'dropdown';
    return el.getAttribute('role') || el.tagName.toLowerCase();
  };
  const name = (el: Element) => {
    const l = label(el);
    const k = kind(el);
    return l ? `the ${k} "${l}"` : `${/^[aeiou]/.test(k) ? 'an' : 'a'} ${k}`;
  };
  // only what differs: "unchecked → checked", not the whole state
  const delta = (before: string, after: string): string => {
    const a = before.split(SEP);
    const b = after.split(SEP);
    const gone = a.filter(p => !b.includes(p));
    const came = b.filter(p => !a.includes(p));
    return `${gone.join(' ') || '-'} → ${came.join(' ') || '-'}`;
  };

  const changes: string[] = [];
  const appeared: string[] = [];
  let removed = 0;
  for (const [el, before] of saved.states) {
    if (!el.isConnected) {
      if (before.startsWith('shown')) removed++;
      continue;
    }
    const after = stateOf(el);
    if (after === before) continue;
    // focus moving is reported once below, not for every element
    const strip = (s: string) =>
      s
        .split(SEP)
        .filter(p => p !== 'focused')
        .join(SEP);
    if (strip(after) === strip(before)) continue;
    if (before.startsWith('hidden') && after.startsWith('shown')) appeared.push(name(el));
    else if (before.startsWith('shown') && after.startsWith('hidden')) changes.push(`${name(el)} was hidden`);
    else changes.push(`${name(el)}: ${delta(strip(before), strip(after))}`);
  }
  for (const el of Array.from(document.querySelectorAll(SELECTOR)).slice(0, 4000)) {
    if (!saved.states.has(el) && el.getClientRects().length > 0) appeared.push(name(el));
  }
  if (appeared.length) {
    const shown = appeared.slice(0, 3).join(', ');
    changes.push(`appeared: ${shown}${appeared.length > 3 ? ` and ${appeared.length - 3} more` : ''}`);
  }
  if (removed) changes.push(`${removed} control${removed > 1 ? 's' : ''} went away`);
  const focus = document.activeElement;
  // a clicked link or button takes the focus itself: that says nothing about whether the click did anything
  const pressable =
    focus instanceof HTMLAnchorElement ||
    focus instanceof HTMLButtonElement ||
    (focus instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image'].includes(focus.type)) ||
    ['button', 'link', 'tab', 'menuitem'].includes(focus?.getAttribute('role') ?? '');
  if (focus && focus !== saved.focus && focus !== document.body && !pressable)
    changes.push(`focus moved to ${name(focus)}`);
  return changes.slice(0, max);
}
