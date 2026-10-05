/*
 * What the user sees on the page while the agent works on it: a thin teal rule along the top of the tab with a
 * tag saying what was done last, and a box around the element acted on. It lives in a closed shadow root on
 * the top document, takes no pointer events (so it is never hit by a click nor by elementFromPoint), and is
 * hidden while a screenshot is taken.
 *
 * The functions below run in the page: they are passed to page.evaluate and must not use anything outside.
 */

export const AGENT_MARK_ID = 'nanobrowser-agent-mark';

export interface MarkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draws or moves the rule, the tag and the box; the box goes away on its own after a moment */
export function drawAgentMark(id: string, label: string, box: MarkBox | null): void {
  const ink = '#0d9488';
  const paper = '#ffffff';
  const mono = "ui-monospace,'JetBrains Mono','SF Mono',Menlo,Consolas,monospace";
  type Host = HTMLElement & { __nbRoot?: ShadowRoot; __nbTimer?: number };

  let host = document.getElementById(id) as Host | null;
  if (!host || !host.__nbRoot) {
    host?.remove();
    host = document.createElement('div') as Host;
    host.id = id;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      * { box-sizing: border-box; }
      .rule { position: fixed; top: 0; left: 0; right: 0; height: 2px; background: ${ink}; }
      .tag { position: fixed; top: 2px; right: 0; padding: 1px 7px; background: ${ink}; color: ${paper};
        border-radius: 0 0 0 5px; font: 500 10px/15px ${mono}; white-space: nowrap;
        max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
      .box { position: fixed; border: 2px solid ${ink}; border-radius: 5px; outline: 1px solid ${paper}; display: none; }
      .box span { position: absolute; left: -2px; bottom: 100%; padding: 0 5px; border-radius: 4px 4px 0 0; background: ${ink}; color: ${paper};
        font: 500 10px/13px ${mono}; white-space: nowrap; }
      .box.below span { bottom: auto; top: 100%; }
    </style><div class="rule"></div><div class="tag"></div><div class="box"><span></span></div>`;
    host.__nbRoot = root;
    document.documentElement.appendChild(host);
  }

  const root = host.__nbRoot as ShadowRoot;
  (root.querySelector('.tag') as HTMLElement).textContent = `Nanobrowser · ${label}`;
  const boxEl = root.querySelector('.box') as HTMLElement;
  window.clearTimeout(host.__nbTimer);
  if (!box) {
    boxEl.style.display = 'none';
    return;
  }
  boxEl.style.display = 'block';
  boxEl.style.left = `${box.x - 3}px`;
  boxEl.style.top = `${box.y - 3}px`;
  boxEl.style.width = `${box.width + 6}px`;
  boxEl.style.height = `${box.height + 6}px`;
  // the label goes under the box when there is no room above it
  boxEl.classList.toggle('below', box.y < 20);
  (boxEl.querySelector('span') as HTMLElement).textContent = label;
  host.__nbTimer = window.setTimeout(() => {
    boxEl.style.display = 'none';
  }, 2500);
}

/** Shows or hides the whole mark, e.g. around a screenshot the model will look at */
export function setAgentMarkVisible(id: string, visible: boolean): void {
  const host = document.getElementById(id);
  if (host) host.style.display = visible ? '' : 'none';
}

export function removeAgentMark(id: string): void {
  document.getElementById(id)?.remove();
}
