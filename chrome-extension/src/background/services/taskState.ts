import type { ChatSessionMetadata } from '@extension/storage';

/**
 * The chats whose task was running when the worker was stopped: the task died with the worker, and the work it
 * had done was left unfinished. The panel offers to carry on with them.
 */
export function interruptedSessions(sessions: ChatSessionMetadata[], runningTaskIds: string[]): ChatSessionMetadata[] {
  const running = new Set(runningTaskIds);
  return sessions.filter(session => session.taskState === 'running' && !running.has(session.id));
}
