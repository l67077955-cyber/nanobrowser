import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type BrowserContext from '../../browser/context';
import type { AgentContext } from '../types';
import { Executor } from '../executor';

vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: {} }));
vi.mock('../../services/analytics', () => ({ analytics: {} }));

const llm = { modelName: 'test-model' } as unknown as BaseChatModel;
const browserContext = {} as BrowserContext;

function contextOf(executor: Executor): AgentContext {
  return (executor as unknown as { context: AgentContext }).context;
}

function contents(executor: Executor): string[] {
  return contextOf(executor)
    .messageManager.getMessages()
    .map(m => String(m.content));
}

describe('Executor snapshot', () => {
  it('lets a new executor of the session go on with a follow-up', () => {
    const first = new Executor('star the repo', 'session-1', browserContext, llm, { memoryContext: 'old memories' });
    const context = contextOf(first);
    context.messageManager.addPlan('{"done":true,"final_answer":"Starred"}');
    // the page as it was read last: it is read again when the session goes on
    context.messageManager.addStateMessage(new HumanMessage('Current page state'));
    context.stateMessageAdded = true;

    const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
    const second = new Executor('now unstar it', 'session-1', browserContext, llm, {
      snapshot,
      memoryContext: 'new memories',
    });

    const history = contents(second);
    expect(history.slice(1, -1)).toEqual([
      'Context for the task: new memories',
      ...contents(first).slice(2, -1), // without the old system prompt, memories and page state
    ]);
    expect(history.at(-1)).toContain('The user sent a follow-up message: """now unstar it"""');
    expect(second.snapshot().tasks).toEqual(['star the repo', 'now unstar it']);
    // only the follow-up is read for things to remember
    expect(second.takeUserMessagesToRemember()).toEqual(['now unstar it']);
  });
});
