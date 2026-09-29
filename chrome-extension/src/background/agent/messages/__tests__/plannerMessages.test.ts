import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { convertMessagesForPlanner } from '../utils';

function navigatorHistory() {
  return [
    new SystemMessage('planner system'),
    new HumanMessage('Your ultimate task is: delete spam posts'),
    new AIMessage({
      content: 'tool call',
      tool_calls: [{ name: 'AgentOutput', args: { current_state: { next_goal: 'open menu' } }, id: '1' }],
    }),
    new ToolMessage({ content: 'tool call response', tool_call_id: '1' }),
    new HumanMessage('Action result: clicked'),
    new HumanMessage('Current page state'),
  ];
}

describe('convertMessagesForPlanner', () => {
  it('turns navigator tool calls into plain text and drops tool responses', () => {
    const converted = convertMessagesForPlanner(navigatorHistory());
    expect(converted.some(m => m instanceof ToolMessage)).toBe(false);
    const ai = converted.filter((m): m is AIMessage => m instanceof AIMessage);
    expect(ai).toHaveLength(1);
    expect(ai[0].tool_calls ?? []).toHaveLength(0);
    expect(ai[0].content).toBe('Navigator output: {"current_state":{"next_goal":"open menu"}}');
    expect(converted.map(m => m.content).slice(-2)).toEqual(['Action result: clicked', 'Current page state']);
  });

  it('does not modify the shared history', () => {
    const history = navigatorHistory();
    const before = history.map(m => m.content);
    convertMessagesForPlanner(history);
    expect(history.map(m => m.content)).toEqual(before);
    expect((history[2] as AIMessage).tool_calls).toHaveLength(1);
  });
});
