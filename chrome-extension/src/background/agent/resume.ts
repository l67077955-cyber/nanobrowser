import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Message } from '@extension/storage';
import { Actors } from './event/types';
import type { ExecutorSnapshot } from './executor';
import MessageManager from './messages/service';
import { filterExternalContent } from './messages/utils';

/** What a row of the side panel says about an agent's step */
function describeStep(message: Message): string {
  if (message.meta?.kind !== 'navigator') return message.content;
  const actions = message.meta.actions.map(action => {
    const name = [action.name, action.target].filter(Boolean).join(' ');
    return action.ok ? name : `${name} (failed: ${action.error ?? 'unknown error'})`;
  });
  return [message.meta.goal, actions.length > 0 ? `Actions: ${actions.join(', ')}` : ''].filter(Boolean).join('\n');
}

/**
 * For a session that has no stored context (it ended before contexts were kept, or was only replayed):
 * the closest thing to it that the chat shown in the side panel still holds.
 */
export function snapshotFromChat(chat: Message[]): ExecutorSnapshot | null {
  const first = chat.findIndex(message => message.actor === Actors.USER && message.content);
  if (first === -1) return null;

  const tasks = [chat[first].content];
  const manager = new MessageManager();
  // the system prompt is not part of a snapshot
  manager.initTaskMessages(new SystemMessage(''), chat[first].content);

  for (const message of chat.slice(first + 1)) {
    if (!message.content) continue;
    switch (message.actor) {
      case Actors.USER:
        tasks.push(message.content);
        manager.addNewTask(message.content);
        break;
      case Actors.PLANNER:
        if (message.meta?.kind === 'planner') {
          const { done } = message.meta;
          manager.addPlan(
            JSON.stringify(done ? { done, final_answer: message.content } : { done, next_steps: message.content }),
          );
        } else {
          manager.addPlan(message.content);
        }
        break;
      case Actors.SYSTEM:
        manager.addMessageWithTokens(new HumanMessage(`System: ${filterExternalContent(message.content, false)}`));
        break;
      default:
        manager.addMessageWithTokens(
          new AIMessage(`${message.actor} step: ${filterExternalContent(describeStep(message), false)}`),
        );
    }
  }

  return { tasks, messages: manager.exportMessages(), actionResults: [] };
}
