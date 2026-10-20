import { describe, it, expect } from 'vitest';
import { interruptedSessions, interruptedSnapshot } from '../services/taskState';

const session = (id: string, taskState?: 'running' | 'interrupted') => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  taskState,
});

describe('interruptedSessions', () => {
  it('finds the chats whose task is not here any more', () => {
    const sessions = [session('a', 'running'), session('b', 'interrupted'), session('c')];
    expect(interruptedSessions(sessions, []).map(s => s.id)).toEqual(['a']);
  });

  it('leaves a task that is still running alone', () => {
    const sessions = [session('a', 'running')];
    expect(interruptedSessions(sessions, ['a'])).toEqual([]);
  });
});

describe('interruptedSnapshot', () => {
  it('marks the state of a run that was still under way', () => {
    const stored = JSON.stringify({ tasks: ['a'], messages: [], actionResults: [], live: true });
    const marked = JSON.parse(interruptedSnapshot(stored) ?? '{}');
    expect(marked.interrupted).toBe(true);
    expect(marked.live).toBe(true);
  });

  it('leaves the state of a run that ended on its own alone', () => {
    const stored = JSON.stringify({ tasks: ['a'], messages: [], actionResults: [] });
    expect(interruptedSnapshot(stored)).toBeNull();
  });

  it('has nothing to mark without a state', () => {
    expect(interruptedSnapshot(null)).toBeNull();
    expect(interruptedSnapshot('not json')).toBeNull();
  });
});
