import type { Message, PageView, StepAction, StepMeta } from '@extension/storage';

export type NavigatorMeta = Extract<StepMeta, { kind: 'navigator' }>;
export type PlannerMeta = Extract<StepMeta, { kind: 'planner' }>;

export const shortModel = (model: string) => (model.split('/').pop() ?? model).replace(/:latest$/, '');
export const formatMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** How long something took, the way a person would say it: 42s, 3m 05s */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** 12400 → 12.4k */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}k`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

const quote = (text: string) => `“${text}”`;

/** [what was done, how to say it could not be done, what to] */
type Phrase = [past: string, base: string, object?: string];

function actionPhrase(action: StepAction, label: string | undefined): Phrase {
  const { value } = action;
  const named = label ? quote(label) : undefined;
  switch (action.name) {
    case 'click_element':
      return ['Clicked', 'click', named ?? 'something on the page'];
    case 'input_text':
      return ['Typed into', 'type into', named ?? 'a field'];
    case 'solve_captcha':
      return ['Filled in', 'fill in', 'the captcha'];
    case 'go_to_url':
      return ['Opened', 'open', value ? hostOf(value) : 'a page'];
    case 'open_tab':
      return ['Opened', 'open', `${value ? hostOf(value) : 'a page'} in a new tab`];
    case 'search_google':
      return ['Searched Google', 'search Google', value ? `for ${quote(value)}` : undefined];
    case 'go_back':
      return ['Went back', 'go back'];
    case 'wait':
      return ['Waited', 'wait', value ? `${value}s for the page` : 'for the page'];
    case 'switch_tab':
      return ['Switched', 'switch', 'to another tab'];
    case 'close_tab':
      return ['Closed', 'close', 'a tab'];
    case 'cache_content':
      return ['Made a note', 'make a note', 'of what it found'];
    case 'scroll_to_percent':
      return ['Scrolled', 'scroll', value ? `to ${value}% of the page` : undefined];
    case 'scroll_to_top':
      return ['Scrolled', 'scroll', 'to the top'];
    case 'scroll_to_bottom':
      return ['Scrolled', 'scroll', 'to the bottom'];
    case 'previous_page':
      return ['Scrolled', 'scroll', 'up'];
    case 'next_page':
      return ['Scrolled', 'scroll', 'down'];
    case 'scroll_to_text':
      return ['Looked for', 'find', value ? `${quote(value)} on the page` : 'some text on the page'];
    case 'send_keys':
      return ['Pressed', 'press', value ?? 'some keys'];
    case 'get_dropdown_options':
      return ['Checked the options', 'check the options', named ? `in ${named}` : 'of a dropdown'];
    case 'select_dropdown_option':
      return ['Chose', 'choose', [value ? quote(value) : 'an option', named ? `in ${named}` : ''].join(' ').trim()];
    case 'done':
      return ['Wrapped up', 'wrap up'];
    case 'ask_user':
      return ['Asked you', 'ask you', 'something'];
    default:
      return ['Ran', 'run', action.name.replace(/_/g, ' ')];
  }
}

/** Jev names its target "[83] More · post: …"; the part after the index is what the page calls it */
function jevLabel(target: string | undefined): string | undefined {
  const label = target?.replace(/^\[\d+\]\s*/, '').trim();
  return label || undefined;
}

/** One action as a sentence: what was done, or what could not be */
export function describeAction(action: StepAction, fallbackLabel?: string): string {
  const [past, base, object] = actionPhrase(action, action.label ?? fallbackLabel);
  return [action.ok ? past : `Couldn’t ${base}`, object].filter(Boolean).join(' ');
}

/** A step as a sentence, by its first action */
export function describeStep(meta: NavigatorMeta): string {
  const first = meta.actions[0];
  if (!first) return 'Looked at the page';
  // steps saved before labels were recorded only have Jev's own name for the element
  return describeAction(first, meta.engine === 'jev' ? jevLabel(meta.jev?.target) : undefined);
}

/** Why a step was taken, in the model's words, when it said so in words a person would use */
export function stepReason(meta: NavigatorMeta): string | undefined {
  if (meta.engine === 'jev') return undefined; // Jev's intent is the operation over again: "CLICK [83] More"
  return (meta.goal ?? meta.actions[0]?.detail)?.trim() || undefined;
}

/** "CLICK [83] More" → "Click More": an action under way, as announced by the engine that chose it */
export function humanizeIntent(intent: string): string {
  const match = intent.match(/^([A-Z][A-Z_ ]+?)\s+\[\d+\]\s*(.*)$/);
  if (!match) return intent;
  const verb = match[1].toLowerCase().replace(/_/g, ' ');
  return `${verb[0].toUpperCase()}${verb.slice(1)} ${match[2]}`.trim();
}

/** Notes written for the model, said again for a person */
export function humanizeNote(note: string): string {
  if (/taken \d+ times on this same page/.test(note)) {
    return 'The same move kept leaving the page unchanged, so the model was told to try something else.';
  }
  const cut = note.match(/^Something new appeared after action (\d+) \/ (\d+)/);
  if (cut) return 'The page changed partway through, so the remaining actions were held back.';
  return note;
}

export interface Entry {
  message: Message;
  /** position in the chat, for keys */
  index: number;
  /** number of the navigator step within its turn, 0 for anything else */
  step: number;
}

export type Segment =
  | { kind: 'work'; entries: Entry[] }
  | { kind: 'answer' | 'question' | 'failure' | 'notice'; entry: Entry };

/** What the user asked and everything that came of it */
export interface Turn {
  index: number;
  user?: Message;
  startedAt: number;
  segments: Segment[];
  /** how many chat messages the turn holds */
  size: number;
}

function segmentKind(message: Message): Segment['kind'] {
  if (message.meta?.kind === 'question') return 'question';
  if (message.meta?.kind === 'planner') return message.meta.done ? 'answer' : 'work';
  if (message.meta?.kind === 'navigator') return 'work';
  if (message.actor !== 'system') return 'work';
  // history saved before failures were marked is told apart by its wording
  return (message.failed ?? /fail|error/i.test(message.content)) ? 'failure' : 'notice';
}

/** The chat as turns: a request, the work done for it, and what came back */
export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  let step = 0;
  messages.forEach((message, index) => {
    if (message.actor === 'user' || !turn) {
      turn = { index, startedAt: message.timestamp, segments: [], size: 0 };
      turns.push(turn);
      step = 0;
    }
    turn.size++;
    if (message.actor === 'user') {
      turn.user = message;
      return;
    }
    const entry: Entry = { message, index, step: message.meta?.kind === 'navigator' ? ++step : 0 };
    const kind = segmentKind(message);
    const last = turn.segments[turn.segments.length - 1];
    if (kind !== 'work') turn.segments.push({ kind, entry });
    else if (last?.kind === 'work') last.entries.push(entry);
    else turn.segments.push({ kind, entries: [entry] });
  });
  return turns;
}

export interface WorkStats {
  steps: number;
  jev: number;
  llm: number;
  avgMs: number;
  fallbacks: number;
  errors: number;
}

export function workStats(entries: Entry[]): WorkStats {
  const steps = entries.map(e => e.message.meta).filter((m): m is NavigatorMeta => m?.kind === 'navigator');
  return {
    steps: steps.length,
    jev: steps.filter(s => s.engine === 'jev').length,
    llm: steps.filter(s => s.engine === 'llm').length,
    avgMs: steps.length ? Math.round(steps.reduce((sum, s) => sum + s.latencyMs, 0) / steps.length) : 0,
    fallbacks: steps.filter(s => s.engine === 'llm' && s.jev?.deferred).length,
    errors: steps.reduce((sum, s) => sum + s.actions.filter(a => !a.ok).length, 0),
  };
}

/** Planner steps arrive as one string; models number them and sometimes double-escape newlines */
export function planLines(content: string): string[] {
  return content
    .split(/\\n|\n/)
    .map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

/** An answer whose line breaks arrived escaped reads as one long line; give it its lines back */
export function answerText(content: string): string {
  return content.includes('\n') ? content : content.replace(/\\n/g, '\n');
}

export type FailureKind =
  | 'setup'
  | 'auth'
  | 'forbidden'
  | 'rateLimit'
  | 'timeout'
  | 'maxSteps'
  | 'network'
  | 'blocked'
  | 'unknown';

/** What kind of trouble ended a task, read from the error's wording, and the error without its preamble */
export function classifyFailure(content: string): { kind: FailureKind; raw: string } {
  const raw = content.replace(/^Task failed:\s*/i, '').trim();
  const tests: [FailureKind, RegExp][] = [
    ['setup', /configure api keys|choose a model|not found in the settings/i],
    ['maxSteps', /max(imum)? steps/i],
    ['auth', /\b401\b|authenticat|unauthori[sz]ed|api key|invalid.{0,20}key/i],
    ['forbidden', /\b403\b|forbidden/i],
    ['rateLimit', /\b429\b|rate.?limit|quota|insufficient|overloaded/i],
    ['timeout', /timed? ?out|timeout|did not answer/i],
    ['blocked', /not allowed|firewall|denied by/i],
    ['network', /network|failed to fetch|econn|connect to service worker|offline/i],
  ];
  return { kind: tests.find(([, pattern]) => pattern.test(raw))?.[0] ?? 'unknown', raw };
}

/** The page the model was last shown, from the newest step that recorded one */
export function latestView(messages: Message[]): PageView | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = messages[i].meta;
    if (meta?.kind === 'navigator' && meta.view) return meta.view;
  }
  return undefined;
}

/** A message as it is saved with the chat: the page text a step read stays out of storage */
export function withoutPageText(message: Message): Message {
  if (message.meta?.kind !== 'navigator' || message.meta.view?.text === undefined) return message;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { text, ...view } = message.meta.view;
  return { ...message, meta: { ...message.meta, view } };
}
