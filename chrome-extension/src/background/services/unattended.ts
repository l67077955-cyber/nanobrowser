import { chatHistoryStore, type Message } from '@extension/storage';
import { Actors, ExecutionState, type AgentEvent } from '../agent/event/types';
import { createLogger } from '../log';

const logger = createLogger('unattended');

const FAILURE_STATES = [ExecutionState.TASK_FAIL, ExecutionState.STEP_FAIL, ExecutionState.ACT_FAIL];

/**
 * The chat row the side panel shows for an event, as it saves it, or null for an event it shows none for.
 * Keep in step with handleTaskState in pages/side-panel/src/SidePanel.tsx.
 */
export function chatMessageFromEvent(event: AgentEvent): Message | null {
  const { actor, state, timestamp, data } = event;
  let shown = false;
  switch (actor) {
    case Actors.SYSTEM:
      shown = state === ExecutionState.TASK_FAIL || state === ExecutionState.TASK_CANCEL;
      break;
    case Actors.PLANNER:
      shown = state === ExecutionState.STEP_OK || state === ExecutionState.STEP_FAIL;
      break;
    case Actors.NAVIGATOR:
      shown =
        (state === ExecutionState.STEP_OK && !!data.meta) ||
        state === ExecutionState.STEP_FAIL ||
        state === ExecutionState.ACT_FAIL ||
        state === ExecutionState.ACT_ASK;
      break;
  }
  if (!shown) return null;

  let meta =
    state === ExecutionState.ACT_ASK && data.meta?.kind !== 'question' ? { kind: 'question' as const } : data.meta;
  // the page text a step read stays out of storage
  if (meta?.kind === 'navigator' && meta.view?.text !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { text, ...view } = meta.view;
    meta = { ...meta, view };
  }
  return {
    actor: actor as unknown as Message['actor'],
    content: data.details || '',
    timestamp,
    ...(meta ? { meta } : {}),
    ...(FAILURE_STATES.includes(state) ? { failed: true } : {}),
  };
}

/** Rows of a task no side panel shows, saved to its chat one after another */
let saves: Promise<unknown> = Promise.resolve();

/** Saves the row for an event into the chat of the task, as an open side panel would */
export function saveUnattended(sessionId: string, event: AgentEvent): void {
  const message = chatMessageFromEvent(event);
  if (!message) return;
  saves = saves
    .then(() => chatHistoryStore.addMessage(sessionId, message))
    .catch(error => logger.error('Failed to save a step of the task to its chat:', error));
}

/** Resolves once every row handed to saveUnattended so far, and any added while waiting, is saved */
export async function unattendedSaved(): Promise<void> {
  let last: Promise<unknown> | null = null;
  while (last !== saves) {
    last = saves;
    await last;
  }
}
