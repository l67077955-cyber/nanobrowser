import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { Actors, type Message } from '@extension/storage';
import MessageManager from '../messages/service';
import { snapshotFromChat } from '../resume';

function finishedTask(): MessageManager {
  const manager = new MessageManager();
  manager.initTaskMessages(new SystemMessage('old system prompt'), 'star the repo', 'old memories');
  manager.addPlan('{"next_steps":"open the repo"}');
  manager.addModelOutput({ current_state: { next_goal: 'click Star' }, action: [{ click_element: { index: 7 } }] });
  manager.addMessageWithTokens(new HumanMessage('Action result: clicked'));
  return manager;
}

function restored(manager: MessageManager): MessageManager {
  // through JSON, as it is kept in storage
  const stored = JSON.parse(JSON.stringify(manager.exportMessages()));
  const copy = new MessageManager();
  copy.restoreMessages(new SystemMessage('new system prompt'), stored, 'new memories');
  return copy;
}

describe('MessageManager export and restore', () => {
  it('brings the history back behind a fresh system prompt and context', () => {
    const before = finishedTask().getMessages();
    const after = restored(finishedTask()).getMessages();

    expect(after.map(m => m.constructor.name)).toEqual(before.map(m => m.constructor.name));
    expect(after[0].content).toBe('new system prompt');
    expect(after[1].content).toBe('Context for the task: new memories');
    expect(after.slice(2).map(m => m.content)).toEqual(before.slice(2).map(m => m.content));

    const toolCall = after.filter((m): m is AIMessage => m instanceof AIMessage).at(-1);
    expect(toolCall?.tool_calls?.[0]).toMatchObject({
      name: 'AgentOutput',
      args: { current_state: { next_goal: 'click Star' }, action: [{ click_element: { index: 7 } }] },
    });
    const toolMessage = after.filter((m): m is ToolMessage => m instanceof ToolMessage).at(-1);
    expect(toolMessage?.tool_call_id).toBe(toolCall?.tool_calls?.[0].id);
  });

  it('numbers new tool calls after the restored ones', () => {
    const original = finishedTask();
    const copy = restored(original);
    expect(copy.nextToolId()).toBe(original.nextToolId());
  });

  it('leaves no context message when there is nothing remembered', () => {
    const copy = new MessageManager();
    copy.restoreMessages(new SystemMessage('new system prompt'), finishedTask().exportMessages());
    expect(copy.getMessages().some(m => String(m.content).startsWith('Context for the task'))).toBe(false);
  });
});

describe('snapshotFromChat', () => {
  const chat: Message[] = [
    { actor: Actors.USER, content: 'find the cheapest flight to Oslo', timestamp: 1 },
    {
      actor: Actors.PLANNER,
      content: 'Open the flight search',
      timestamp: 2,
      meta: { kind: 'planner', model: 'm', latencyMs: 1, done: false },
    },
    {
      actor: Actors.NAVIGATOR,
      content: 'Navigation done',
      timestamp: 3,
      meta: {
        kind: 'navigator',
        engine: 'llm',
        model: 'm',
        latencyMs: 1,
        goal: 'Search for flights',
        actions: [
          { name: 'click_element', target: '[12]', ok: true },
          { name: 'input_text', target: '[3]', ok: false, error: 'element is gone' },
        ],
      },
    },
    {
      actor: Actors.PLANNER,
      content: 'The cheapest flight is 79 EUR',
      timestamp: 4,
      meta: { kind: 'planner', model: 'm', latencyMs: 1, done: true },
    },
    { actor: Actors.USER, content: 'and to Bergen?', timestamp: 5 },
    { actor: Actors.SYSTEM, content: 'Task cancelled', timestamp: 6 },
  ];

  it('rebuilds tasks, plans and steps from the rows of the side panel', () => {
    const snapshot = snapshotFromChat(chat);
    expect(snapshot?.tasks).toEqual(['find the cheapest flight to Oslo', 'and to Bergen?']);

    const manager = new MessageManager();
    manager.restoreMessages(new SystemMessage('system'), snapshot!.messages);
    const text = manager
      .getMessages()
      .map(m => String(m.content))
      .join('\n');

    expect(text).toContain('Your ultimate task is: """find the cheapest flight to Oslo"""');
    expect(text).toContain('<plan>{"done":false,"next_steps":"Open the flight search"}</plan>');
    expect(text).toContain(
      'navigator step: Search for flights\nActions: click_element [12], input_text [3] (failed: element is gone)',
    );
    expect(text).toContain('<plan>{"done":true,"final_answer":"The cheapest flight is 79 EUR"}</plan>');
    expect(text).toContain('The user sent a follow-up message: """and to Bergen?"""');
    expect(text).toContain('System: Task cancelled');
    expect(text.indexOf('79 EUR')).toBeLessThan(text.indexOf('and to Bergen?'));
  });

  it('has nothing to go on without a user message', () => {
    expect(snapshotFromChat([{ actor: Actors.SYSTEM, content: 'Task failed', timestamp: 1 }])).toBeNull();
  });
});
