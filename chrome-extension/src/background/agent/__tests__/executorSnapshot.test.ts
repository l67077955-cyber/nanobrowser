import { describe, it, expect, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type BrowserContext from '../../browser/context';
import type { AgentContext } from '../types';
import { Executor } from '../executor';

vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: {} }));
vi.mock('../../services/analytics', () => ({ analytics: {} }));

const llm = { modelName: 'test-model' } as unknown as BaseChatModel;
const browserContext = {} as BrowserContext;

function contextOf(executor: Executor): AgentContext {
  return (executor as unknown as { context: AgentContext }).context;
}

function contents(executor: Executor): string[] {
  return contextOf(executor)
    .messageManager.getMessages()
    .map(m => String(m.content));
}

describe('Executor snapshot', () => {
  it('lets a new executor of the session go on with a follow-up', () => {
    const first = new Executor('star the repo', 'session-1', browserContext, llm, { memoryContext: 'old memories' });
    const context = contextOf(first);
    context.messageManager.addPlan('{"done":true,"final_answer":"Starred"}');
    // the page as it was read last: it is read again when the session goes on
    context.messageManager.addStateMessage(new HumanMessage('Current page state'));
    context.stateMessageAdded = true;

    const snapshot = JSON.parse(JSON.stringify(first.snapshot()));
    const second = new Executor('now unstar it', 'session-1', browserContext, llm, {
      snapshot,
      memoryContext: 'new memories',
    });

    const history = contents(second);
    expect(history.slice(1, -1)).toEqual([
      'Context for the task: new memories',
      ...contents(first).slice(2, -1), // without the old system prompt, memories and page state
    ]);
    expect(history.at(-1)).toContain('The user sent a follow-up message: """now unstar it"""');
    expect(second.snapshot().tasks).toEqual(['star the repo', 'now unstar it']);
    // only the follow-up is read for things to remember; the earlier task tells what it refers to
    expect(second.takeUserMessagesToRemember()).toEqual({
      messages: ['now unstar it'],
      earlier: ['star the repo'],
      attachments: '',
    });
  });

  it('hands the attached files of the session to memory along with what the user wrote', () => {
    const file = '<nano_file_content type="file" name="cv.md">\nStudied at TU Berlin\n</nano_file_content>';
    const executor = new Executor(
      `this is my resume\n\n<nano_attached_files>${file}</nano_attached_files>`,
      's',
      browserContext,
      llm,
    );
    expect(executor.takeUserMessagesToRemember().messages).toEqual(['this is my resume']);
    executor.addFollowUpTask('remember this');
    const said = executor.takeUserMessagesToRemember();
    expect(said.messages).toEqual(['remember this']);
    expect(said.earlier).toEqual(['this is my resume']);
    expect(said.attachments).toContain('Studied at TU Berlin');
  });

  // a remote task's chat, then a task of the user's in it that ran out of steps, then "keep going"
  const remote = 'Remote agent: find the book Sapiens on books.toscrape.com';
  const ownTask = 'test the branch pipeline on srdcloud';
  const keepGoing = 'Keep going from where you left off.';

  function goalOf(executor: Executor): string {
    return (executor as unknown as { decisionGoal(): string }).decisionGoal();
  }

  it('keeps working on the task that ran out of steps when told to keep going', () => {
    const executor = new Executor(remote, 'session-1', browserContext, llm);
    executor.addFollowUpTask(ownTask);
    executor.continueTask(keepGoing);

    expect(goalOf(executor)).toBe(`${ownTask}\nThe user added: ${keepGoing}`);
    const last = contents(executor).at(-1);
    expect(last).toContain(`Your ultimate task is still the one you were working on: """${ownTask}"""`);
    expect(last).not.toContain('Sapiens');
  });

  it('remembers which task was worked on when a new executor carries on from the snapshot', () => {
    const first = new Executor(remote, 'session-1', browserContext, llm);
    first.addFollowUpTask(ownTask);
    const snapshot = JSON.parse(JSON.stringify(first.snapshot()));

    const second = new Executor(keepGoing, 'session-1', browserContext, llm, { snapshot, continues: true });
    expect(goalOf(second)).toBe(`${ownTask}\nThe user added: ${keepGoing}`);
    expect(contents(second).at(-1)).toContain(`"""${ownTask}"""`);
    expect(second.snapshot().goalStart).toBe(1);

    // a snapshot from before goalStart was kept: the latest task is the one carried on
    delete snapshot.goalStart;
    const third = new Executor(keepGoing, 'session-1', browserContext, llm, { snapshot, continues: true });
    expect(goalOf(third)).toBe(`${ownTask}\nThe user added: ${keepGoing}`);
  });
});
