import type { ChatSessionMetadata } from '@extension/storage';

/**
 * The chats whose task was running when the worker was stopped: the task died with the worker, and the work it
 * had done was left unfinished. The panel offers to carry on with them.
 */
export function interruptedSessions(sessions: ChatSessionMetadata[], runningTaskIds: string[]): ChatSessionMetadata[] {
  const running = new Set(runningTaskIds);
  return sessions.filter(session => session.taskState === 'running' && !running.has(session.id));
}

/**
 * The state of a run that was cut short, marked as such: the model is told that the step it was in may or may
 * not have gone through when the session goes on from here. Only a state taken while the run was under way says
 * so: the one of a run that ended is the state it ended in.
 */
export function interruptedSnapshot(stored: string | null): string | null {
  if (!stored) return null;
  try {
    const snapshot = JSON.parse(stored) as (Record<string, unknown> & { live?: boolean }) | null;
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.live) return null;
    return JSON.stringify({ ...snapshot, interrupted: true });
  } catch {
    return null;
  }
}
