import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type BrowserContext from '../../../browser/context';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import type { AgentContext } from '../../types';
import { Executor } from '../../executor';
import { FailedClickTracker, clickTargets } from '../navigator';

vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: {} }));
vi.mock('../../../services/analytics', () => ({ analytics: {} }));

function node(index: number, xpath: string, text: string) {
  const el = new DOMElementNode({
    tagName: 'button',
    xpath,
    attributes: {},
    children: [],
    isVisible: true,
    highlightIndex: index,
  });
  el.children.push(new DOMTextNode(text, true, el));
  return el;
}

const click = (index: number) => [{ click_element: { intent: 'submit', index } }];
const targetsOf = (xpath: string, url: string) => clickTargets(click(7), new Map([[7, node(7, xpath, 'OK')]]), url);

function failTwice(tracker: FailedClickTracker, xpath: string, url: string, evaluation = 'Failed - nothing happened') {
  for (let i = 0; i < 2; i++) {
    tracker.remember(targetsOf(xpath, url));
    tracker.judge(evaluation);
  }
}

describe('FailedClickTracker scope', () => {
  it('tells the routes of a hash-routed app apart', () => {
    const tracker = new FailedClickTracker();
    failTwice(tracker, '/div[1]/div/button', 'https://app.example.cn/#/projects?a=1');
    expect(tracker.refusal(targetsOf('/div[1]/div/button', 'https://app.example.cn/#/projects?a=1'))).not.toBeNull();
    expect(tracker.refusal(targetsOf('/div[1]/div/button', 'https://app.example.cn/#/members'))).toBeNull();
  });

  it('does not refuse a button that reads the same in a dialog of another shape', () => {
    const tracker = new FailedClickTracker();
    failTwice(tracker, '/body/div[3]/div/div[2]/div/button', 'https://app.example.cn/#/a');
    expect(
      tracker.refusal(targetsOf('/body/div[4]/div/section/footer/button', 'https://app.example.cn/#/a')),
    ).toBeNull();
  });

  it('does not blame the button for a form that failed its checks', () => {
    const tracker = new FailedClickTracker();
    failTwice(tracker, '/form/button', 'https://app.example.cn/#/a', 'Failed - validation error: name is required');
    expect(tracker.refusal(targetsOf('/form/button', 'https://app.example.cn/#/a'))).toBeNull();
  });
});

describe('Executor follow-up', () => {
  it('starts a follow-up task without the failures of the one before', () => {
    const executor = new Executor('task', 's', {} as BrowserContext, { modelName: 'm' } as unknown as BaseChatModel);
    const context = (executor as unknown as { context: AgentContext }).context;
    context.consecutiveFailures = context.options.maxFailures;
    executor.addFollowUpTask('try again');
    expect(context.consecutiveFailures).toBe(0);
  });
});
