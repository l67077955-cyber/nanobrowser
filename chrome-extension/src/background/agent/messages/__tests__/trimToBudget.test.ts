import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import MessageManager, { MessageManagerSettings } from '../service';
import { pairToolResponses } from '../utils';

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
    expect(manager.tokenUsage().tokens).toBeLessThanOrEqual(1500 * 0.75);
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

  it('cuts with room to spare, so the next steps keep the start of the history (and the prompt cache) unchanged', () => {
    const manager = managerWithSteps(20, 1500);
    manager.trimToBudget();
    expect(manager.tokenUsage().tokens).toBeLessThanOrEqual(1500 * 0.75);
    const step = (i: number) => {
      manager.removeLastStateMessage();
      manager.addModelOutput({ current_state: { next_goal: `step ${i}` } });
      manager.addMessageWithTokens(new HumanMessage(`Action result: ${big(`result ${i}`)}`));
      manager.addStateMessage(new HumanMessage(big('current page')));
    };
    const prefix = texts(manager).slice(0, -1);
    step(21);
    expect(manager.trimToBudget()).toBe(0);
    expect(texts(manager).slice(0, prefix.length)).toEqual(prefix);
  });

  it('says in the note what the dropped steps did and keeps the findings they cached', () => {
    const manager = new MessageManager(new MessageManagerSettings({ maxInputTokens: 1500 }));
    manager.initTaskMessages(new SystemMessage('system'), 'compare three laptops');
    manager.addModelOutput({ current_state: { next_goal: 'Open the first laptop' } });
    manager.addMessageWithTokens(new HumanMessage('Action result: Cached findings: Laptop A costs 999'));
    manager.addModelOutput({ current_state: { next_goal: 'Read the review' } });
    manager.addMessageWithTokens(
      new HumanMessage(
        `Action result: Text of "Review" (https://a.example/r), characters 0-300 of 300:\n${big('review')}`,
      ),
    );
    for (let i = 1; i <= 20; i++) {
      manager.addModelOutput({ current_state: { next_goal: `step ${i}` } });
      manager.addMessageWithTokens(new HumanMessage(`Action result: ${big(`result ${i}`)}`));
    }
    manager.addStateMessage(new HumanMessage(big('current page')));
    manager.trimToBudget();
    const note = texts(manager).find(t => t.includes('left out here')) ?? '';
    expect(note).toContain('Laptop A costs 999');
    expect(note).toContain('- Open the first laptop');
    expect(note).toContain('read the text of "Review" (https://a.example/r)');
    expect(note).not.toContain('xxxxxxxxxx');
    expect(manager.tokenUsage().tokens).toBeLessThanOrEqual(1500 * 0.75);
  });

  it('never drops what the user said while the task ran', () => {
    const manager = managerWithSteps(3, 1500);
    manager.removeLastStateMessage();
    manager.addUserNote('use the Canadian address, not the US one');
    for (let i = 4; i <= 20; i++) {
      manager.addModelOutput({ current_state: { next_goal: `step ${i}` } });
      manager.addMessageWithTokens(new HumanMessage(`Action result: ${big(`result ${i}`)}`));
    }
    manager.addStateMessage(new HumanMessage(big('current page')));
    expect(manager.trimToBudget()).toBeGreaterThan(0);
    expect(texts(manager).some(t => t.includes('Canadian address'))).toBe(true);
  });

  it('stops when only kept messages are left', () => {
    const manager = managerWithSteps(2, 10);
    manager.trimToBudget();
    expect(texts(manager).at(-1)).toContain('current page');
    expect(texts(manager).some(t => t.includes('Action result'))).toBe(false);
  });

  it('places a plan made during a trim where it was meant to go, never inside a tool call', () => {
    const manager = managerWithSteps(20, 1500);
    // the planner takes its position, then the navigator goes on and trims
    const position = manager.length() - 1;
    const droppedBefore = manager.droppedCount();
    manager.removeLastStateMessage();
    manager.addModelOutput({ current_state: { next_goal: 'step 21' } });
    manager.addStateMessage(new HumanMessage(big('current page')));
    manager.trimToBudget();
    manager.addPlan('the plan', position - (manager.droppedCount() - droppedBefore));

    const messages = manager.getMessages();
    const plan = messages.findIndex(m => String(m.content).includes('the plan'));
    expect(String(messages[plan - 1].content)).toContain('result 20');
    expect(messages[plan + 1]).toBeInstanceOf(AIMessage);
    expect(messages[plan + 2]).toBeInstanceOf(ToolMessage);
  });

  it('never splits a tool call from its response, even given a position between them', () => {
    const manager = managerWithSteps(2, 128000);
    const all = manager.getMessages();
    const response = all.findLastIndex(m => m instanceof ToolMessage);
    manager.addPlan('the plan', response);
    const messages = manager.getMessages();
    const plan = messages.findIndex(m => String(m.content).includes('the plan'));
    expect(messages[plan + 1]).toBeInstanceOf(AIMessage);
  });
});

describe('pairToolResponses', () => {
  const call = (id: string) =>
    new AIMessage({ content: 'tool call', tool_calls: [{ name: 'AgentOutput', args: {}, id }] });
  const response = (id: string) => new ToolMessage({ content: 'tool call response', tool_call_id: id });

  it('moves a message stuck between a tool call and its response behind the response', () => {
    const plan = new AIMessage('<plan>x</plan>');
    const out = pairToolResponses([new HumanMessage('a'), call('5'), plan, response('5'), new HumanMessage('b')]);
    expect(out.map(m => m.constructor.name)).toEqual([
      'HumanMessage',
      'AIMessage',
      'ToolMessage',
      'AIMessage',
      'HumanMessage',
    ]);
    expect(out[3]).toBe(plan);
  });

  it('drops responses whose call is gone and answers calls left without one', () => {
    const out = pairToolResponses([response('1'), call('2'), new HumanMessage('page')]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeInstanceOf(AIMessage);
    expect((out[1] as ToolMessage).tool_call_id).toBe('2');
  });
});
