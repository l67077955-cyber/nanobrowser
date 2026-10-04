import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { MemoryEntry } from '@extension/storage';
import { createLogger } from '@src/background/log';
import { jevEndpoint, postJev, validateChoice } from '@src/background/agent/engines/jev';

const logger = createLogger('MemoryCurator');

const ADD = 'add';
const SKIP = 'skip';
const REPLACE = 'replace_';
const KEEP_ALL = 'none';

const DECISION_RULES = `Decide what to do with the new information the user gave about themselves.
Memory is for lasting facts and preferences that will help with the user's future browser tasks.
Details that only matter for the task at hand are not worth storing. Choose a replace option when
the new information updates, corrects or contradicts that memory. Choose skip when a current memory
already says the same thing.`;

const EVICT_RULES = `Memory is full. The new information can only be stored by deleting one current memory.
Choose the current memory that is least useful to keep: outdated, trivial, or the least likely to
matter in future tasks. Choose none when every current memory is more useful than the new information.`;

const ANSWER_FORMAT = `You curate a small long-term memory about one user. You get a JSON object with state and questions.
Each question lists criteria: answer it by choosing exactly one criteria key.
Return only a JSON object mapping each question name to the chosen key, e.g. {"decision": "skip"}.`;

export type CurationDecision =
  | { action: 'skip' }
  /** evictId is set when memory was full: that entry makes room for the new one */
  | { action: 'add'; evictId?: string }
  | { action: 'replace'; id: string };

interface ChoiceQuestion {
  type: 'choice';
  criteria: Record<string, string>;
  instructions: { rules: string };
}

export interface CurationRequest {
  state: { current_memories: string[]; new_information: string };
  questions: { decision: ChoiceQuestion; evict?: ChoiceQuestion };
}

/** Memories are numbered from 1 in the order given; the numbers are the choice keys */
export function buildCurationRequest(candidate: string, memories: MemoryEntry[], full: boolean): CurationRequest {
  const numbered = memories.map((m, i) => `${i + 1}# ${m.content}`);
  const decision: Record<string, string> = {
    [ADD]: 'Store it as a new memory: a lasting fact or preference about the user that no current memory covers.',
    [SKIP]: 'Do not store it: it only matters for one task, is trivial, or a current memory already says it.',
  };
  memories.forEach((m, i) => {
    decision[`${REPLACE}${i + 1}`] = `It updates or corrects memory ${i + 1}# (${m.content}): rewrite that memory.`;
  });
  const request: CurationRequest = {
    state: { current_memories: numbered, new_information: candidate },
    questions: { decision: { type: 'choice', criteria: decision, instructions: { rules: DECISION_RULES } } },
  };
  if (full) {
    const evict: Record<string, string> = {};
    memories.forEach((m, i) => {
      evict[String(i + 1)] = `Delete memory ${i + 1}# (${m.content})`;
    });
    evict[KEEP_ALL] = 'Delete nothing and do not store the new information.';
    request.questions.evict = { type: 'choice', criteria: evict, instructions: { rules: EVICT_RULES } };
  }
  return request;
}

/** Anything that is not one of the offered keys counts as skip: a memory is never changed on a garbled answer */
export function interpretCuration(
  choices: Record<string, string | undefined>,
  memories: MemoryEntry[],
  full: boolean,
): CurationDecision {
  const decision = choices.decision ?? '';
  if (decision.startsWith(REPLACE)) {
    const target = memories[Number(decision.slice(REPLACE.length)) - 1];
    return target ? { action: 'replace', id: target.id } : { action: 'skip' };
  }
  if (decision !== ADD) return { action: 'skip' };
  if (!full) return { action: 'add' };
  const evicted = /^\d+$/.test(choices.evict ?? '') ? memories[Number(choices.evict) - 1] : undefined;
  return evicted ? { action: 'add', evictId: evicted.id } : { action: 'skip' };
}

type Ask = (request: CurationRequest, signal: AbortSignal) => Promise<Record<string, string | undefined>>;

export function askJev(apiKey: string, fetchImpl?: typeof fetch): Ask {
  const { url, model } = jevEndpoint(apiKey);
  return async (request, signal) => {
    const response = await postJev(url, apiKey, { model, ...request }, signal, fetchImpl);
    const choices: Record<string, string> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      choices[name] = validateChoice(response.answers?.[name], Object.keys(question.criteria)).choice;
    }
    return choices;
  };
}

export function askLLM(llm: BaseChatModel): Ask {
  return async (request, signal) => {
    const result = await llm.invoke([new SystemMessage(ANSWER_FORMAT), new HumanMessage(JSON.stringify(request))], {
      signal,
      tags: ['memory-curator'],
    });
    const content = typeof result.content === 'string' ? result.content : '';
    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Record<string, unknown>;
    const choices: Record<string, string | undefined> = {};
    for (const name of Object.keys(request.questions)) {
      choices[name] = typeof parsed[name] === 'string' ? (parsed[name] as string) : undefined;
    }
    return choices;
  };
}

/**
 * Decide whether a new piece of information is stored, and which memory it displaces.
 * Jev answers when fast mode has a key; the LLM answers otherwise, or when Jev fails.
 */
export async function curate(
  candidate: string,
  memories: MemoryEntry[],
  full: boolean,
  askers: Ask[],
  signal: AbortSignal,
): Promise<CurationDecision> {
  const request = buildCurationRequest(candidate, memories, full);
  for (const ask of askers) {
    try {
      return interpretCuration(await ask(request, signal), memories, full);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning(`Curation failed, trying the next model: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { action: 'skip' };
}
