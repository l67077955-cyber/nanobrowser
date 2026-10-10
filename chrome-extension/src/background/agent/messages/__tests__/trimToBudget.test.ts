import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import MessageManager, { MessageManagerSettings } from '../service';

/** 3 characters make a token, so 'x'.repeat(300) is 100 tokens */
const big = (tag: string) => `${tag} ${'x'.repeat(300)}`;

function managerWithSteps(steps: number, maxInputTokens: number) {
  const manager = new MessageManager(new MessageManagerSettings({ maxInputTokens }));
  manager.initTaskMessages(new SystemMessage('system'), 'find the cheapest flight');
  for (let i = 1; i <= steps; i++) {
    manager.addModelOutput({ current_state: { next_goal: `step ${i}` } });
    manager.addMessageWithTokens(new HumanMessage(`Action result: ${big(`result ${i}`)}`));
  }
  manager.addStateMessage(new HumanMessage(big('current page')));
  return manager;
}

const texts = (manager: MessageManager) => manager.getMessages().map(m => String(m.content));

describe('MessageManager.trimToBudget', () => {
  it('leaves a history that fits alone', () => {
    const manager = managerWithSteps(3, 128000);
    const before = texts(manager);
    expect(manager.trimToBudget()).toBe(0);
    expect(texts(manager)).toEqual(before);
  });

  it('drops the oldest steps first and keeps setup, follow-ups and the current page', () => {
    const manager = managerWithSteps(20, 1500);
    manager.removeLastStateMessage();
    manager.addNewTask('now book it');
    manager.addStateMessage(new HumanMessage(big('current page')));
    const setup = texts(manager).slice(0, 6); // system, task, example output, its tool call and response, history start

    expect(manager.trimToBudget()).toBeGreaterThan(0);
    const after = texts(manager);
    expect(manager.tokenUsage().tokens).toBeLessThanOrEqual(1500);
    expect(after.slice(0, 6)).toEqual(setup);
    expect(after[6]).toContain('left out here');
    expect(after.some(t => t.includes('result 1 '))).toBe(false);
    expect(after.some(t => t.includes('result 20 '))).toBe(true);
    expect(after.some(t => t.includes('now book it'))).toBe(true);
    expect(after.at(-1)).toContain('current page');
  });

  it('never leaves a tool response without its tool call', () => {
    const manager = managerWithSteps(20, 1500);
    manager.trimToBudget();
    const messages = manager.getMessages();
    messages.forEach((m, i) => {
      if (!(m instanceof ToolMessage)) return;
      const call = messages[i - 1];
      expect(call).toBeInstanceOf(AIMessage);
      expect((call as AIMessage).tool_calls?.map(c => c.id)).toContain(m.tool_call_id);
    });
  });

  it('leaves one note however many times it trims', () => {
    const manager = managerWithSteps(20, 1500);
    manager.trimToBudget();
    manager.removeLastStateMessage();
    manager.addModelOutput({ current_state: { next_goal: 'step 21' } });
    manager.addMessageWithTokens(new HumanMessage(`Action result: ${big('result 21')}`));
    manager.addStateMessage(new HumanMessage(big('current page')));
    manager.trimToBudget();
    expect(texts(manager).filter(t => t.includes('left out here'))).toHaveLength(1);
  });

  it('stops when only kept messages are left', () => {
    const manager = managerWithSteps(2, 10);
    manager.trimToBudget();
    expect(texts(manager).at(-1)).toContain('current page');
    expect(texts(manager).some(t => t.includes('Action result'))).toBe(false);
  });
});
