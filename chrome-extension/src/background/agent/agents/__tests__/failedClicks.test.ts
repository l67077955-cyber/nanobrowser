import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import { FailedClickTracker, clickTargets } from '../navigator';

function node(index: number, xpath: string, text: string, attributes: Record<string, string> = {}, tagName = 'div') {
  const el = new DOMElementNode({ tagName, xpath, attributes, children: [], isVisible: true, highlightIndex: index });
  if (text) el.children.push(new DOMTextNode(text, true, el));
  return el;
}

const URL_A = 'https://live.bilibili.com/1724214024?live_from=x';
const click = (index: number) => [{ click_element: { intent: 'like', index } }];

describe('FailedClickTracker', () => {
  it('refuses the element clicked in two failed steps, though its index changed', () => {
    const tracker = new FailedClickTracker();
    const follow = (index: number) => clickTargets(click(index), new Map([[index, node(index, '/div[3]/div[2]', '关注')]]), URL_A);

    tracker.judge(undefined);
    expect(tracker.refusal(follow(125))).toBeNull();
    tracker.remember(follow(125));
    tracker.judge('Failed - hit 关注 instead of the like button');
    expect(tracker.refusal(follow(124))).toBeNull();
    tracker.remember(follow(124));
    tracker.judge('Failed - hit 关注 again');
    expect(tracker.refusal(follow(44))).toContain('[44] <div> "关注"');
  });

  it('knows the element by what it reads when its place moved', () => {
    const tracker = new FailedClickTracker();
    for (const xpath of ['/div[1]/a', '/div[2]/a']) {
      tracker.remember(clickTargets(click(26), new Map([[26, node(26, xpath, '鸭酱', { href: '/1' }, 'a')]]), URL_A));
      tracker.judge('Failed - opened a new tab');
    }
    const again = clickTargets(click(30), new Map([[30, node(30, '/div[9]/a', '鸭酱', { href: '/1' }, 'a')]]), URL_A);
    expect(tracker.refusal(again)).not.toBeNull();
  });

  it('does not count successes, other pages or a reset', () => {
    const tracker = new FailedClickTracker();
    const like = clickTargets(click(43), new Map([[43, node(43, '/div[4]', '')]]), URL_A);
    for (let i = 0; i < 3; i++) {
      tracker.remember(like);
      tracker.judge('Success - the like count went up');
    }
    expect(tracker.refusal(like)).toBeNull();
    for (let i = 0; i < 2; i++) {
      tracker.remember(like);
      tracker.judge('Failed');
    }
    const elsewhere = clickTargets(click(43), new Map([[43, node(43, '/div[4]', '')]]), 'https://example.com/');
    expect(tracker.refusal(elsewhere)).toBeNull();
    expect(tracker.refusal(like)).not.toBeNull();
    tracker.reset();
    expect(tracker.refusal(like)).toBeNull();
  });
});
