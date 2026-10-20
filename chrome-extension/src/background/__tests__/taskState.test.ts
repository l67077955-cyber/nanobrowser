import { describe, it, expect } from 'vitest';
import { interruptedSessions } from '../services/taskState';

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
