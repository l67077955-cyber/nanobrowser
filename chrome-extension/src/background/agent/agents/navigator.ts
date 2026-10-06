import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger, describeError } from '@src/background/log';
import { ActionResult, type AgentOutput } from '../types';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import { agentBrainSchema } from '../types';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  EXTENSION_CONFLICT_ERROR_MESSAGE,
  ExtensionConflictError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isExtensionConflictError,
  isForbiddenError,
  ResponseParseError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  ModelTimeoutError,
  RequestCancelledError,
  withModelTimeout,
} from './errors';
import { calcBranchPathHashSet } from '@src/background/browser/dom/views';
import { type BrowserState, BrowserStateHistory, URLNotAllowedError } from '@src/background/browser/views';
import { convertZodToJsonSchema, repairJsonString } from '@src/background/utils';
import { HistoryTreeProcessor } from '@src/background/browser/dom/history/service';
import { AgentStepRecord } from '../history';
import { isAnthropicAdaptiveThinkingModel } from '../helper';
import { convertMessagesForPlanner } from '../messages/utils';
import { type DOMHistoryElement } from '@src/background/browser/dom/history/view';
import type { EngineResult, NavigatorDecisionEngine } from '../engines/types';
import type { PageView, StepMeta } from '@extension/storage';
import { t } from '@extension/i18n';
import type { DOMElementNode } from '@src/background/browser/dom/views';

const logger = createLogger('NavigatorAgent');

/** actions that act on a page rather than read it: read-only mode never runs them, manual mode asks before each */
export const PAGE_INPUT_ACTIONS = new Set([
  'click_element',
  'input_text',
  'select_dropdown_option',
  'send_keys',
  'solve_captcha',
]);

/** What a page action would do, in words the user approves it by */
export function describePageInput(actionName: string, args: unknown, selectorMap: Map<number, DOMElementNode>): string {
  const input = (args ?? {}) as { index?: number; text?: string; keys?: string };
  const node = typeof input.index === 'number' ? selectorMap.get(input.index) : undefined;
  const label = (node && elementLabel(node)) || t('act_confirm_desc_element', [String(input.index ?? '?')]);
  const text = input.text ?? '';
  const shown = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  switch (actionName) {
    case 'click_element':
      return t('act_confirm_desc_click', [label]);
    case 'input_text':
      return t('act_confirm_desc_input', [shown, label]);
    case 'select_dropdown_option':
      return t('act_confirm_desc_select', [shown, label]);
    case 'send_keys':
      return t('act_confirm_desc_keys', [input.keys ?? '']);
    case 'solve_captcha':
      return t('act_confirm_desc_captcha', [label]);
    default:
      return actionName;
  }
}

export function elementLabel(node: DOMElementNode): string {
  const attrs = node.attributes;
  const label =
    [attrs['aria-label'], node.getAllTextTillNextClickableElement(2), attrs.title, attrs.value].find(
      c => c && c.trim(),
    ) ?? '';
  const flat = label.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

const FIELD_TAGS = new Set(['textarea', 'select']);
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image']);

/** What the page calls an element, for the side panel. A field goes by its label, never by what it holds. */
export function targetLabel(node: DOMElementNode): string | undefined {
  const attrs = node.attributes;
  const tag = node.tagName?.toLowerCase() ?? '';
  const isField =
    FIELD_TAGS.has(tag) ||
    (tag === 'input' && !BUTTON_INPUT_TYPES.has((attrs.type ?? '').toLowerCase())) ||
    attrs.contenteditable === 'true' ||
    attrs.role === 'textbox';
  const candidates = isField
    ? [attrs['aria-label'], attrs.placeholder, attrs.title, attrs.name]
    : [attrs['aria-label'], node.getAllTextTillNextClickableElement(2), attrs.title, attrs.value];
  const flat = (candidates.find(c => c && c.trim()) ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** An element as a log reads it: <input id="phone" name="mobile" type="text"> "手机号" */
function describeTarget(node: DOMElementNode | undefined): string {
  if (!node) return '';
  const attributes = ['id', 'name', 'type', 'placeholder', 'aria-label', 'href']
    .filter(key => node.attributes[key])
    .map(key => `${key}="${node.attributes[key].slice(0, 60)}"`);
  const text = node.getAllTextTillNextClickableElement(2).replace(/\s+/g, ' ').trim().slice(0, 60);
  return `<${node.tagName ?? '?'}${attributes.length ? ` ${attributes.join(' ')}` : ''}>${text ? ` "${text}"` : ''}`;
}

/** Actions as JSON for the log, with what is typed into a password field left out */
function actionsForLog(actions: Record<string, unknown>[], selectorMap: Map<number, DOMElementNode>): string {
  return JSON.stringify(
    actions.map(action =>
      Object.fromEntries(
        Object.entries(action).map(([name, args]) => {
          const fields = args as Record<string, unknown> | null;
          const node = typeof fields?.index === 'number' ? selectorMap.get(fields.index) : undefined;
          const secret = node?.attributes.type === 'password' && typeof fields?.text === 'string';
          return [name, secret ? { ...fields, text: '***' } : args];
        }),
      ),
    ),
  );
}

const KEY_NAME =
  /^(Enter|Escape|Tab|Backspace|Delete|Space|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Control|Shift|Alt|Meta|F\d{1,2})$/;

/** Keys as pressed, when they are named keys or a shortcut; anything else may be text typed through send_keys */
function keyNames(keys: string): string | undefined {
  const parts = keys.split('+');
  const named = parts.every((part, i) => KEY_NAME.test(part) || (parts.length > 1 && i > 0 && part.length === 1));
  return named ? keys : undefined;
}

/** What an action was given besides its element: an address, a search, a key, an option. Never typed text. */
function actionValue(name: string, args: Record<string, unknown>): string | undefined {
  let value: unknown;
  switch (name) {
    case 'go_to_url':
    case 'open_tab':
      value = args.url;
      break;
    case 'search_google':
      value = args.query;
      break;
    case 'select_dropdown_option':
    case 'scroll_to_text':
      value = args.text;
      break;
    case 'send_keys':
      value = typeof args.keys === 'string' ? keyNames(args.keys) : undefined;
      break;
    case 'wait':
      value = args.seconds;
      break;
    case 'scroll_to_percent':
      value = args.yPercent;
      break;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
}

/** The page text is shown as the model got it, up to this many characters */
const PAGE_TEXT_LIMIT = 8000;

/** Side-panel record of what the model is given about the page for one step */
export function pageView(
  state: BrowserState,
  text: string,
  sent: { screenshot: boolean; tokens?: number; maxTokens?: number },
): PageView {
  const share = (y: number) => Math.round(Math.min(1, Math.max(0, y / state.scrollHeight)) * 100) / 100;
  return {
    url: state.url,
    title: state.title,
    elements: state.selectorMap.size,
    ...(state.scrollHeight > 0
      ? { seen: [share(state.scrollY), share(state.scrollY + state.visualViewportHeight)] as [number, number] }
      : {}),
    screenshot: sent.screenshot,
    tabs: state.tabs.filter(tab => tab.id !== state.tabId).length,
    ...(state.unreadable ? { unreadable: true } : {}),
    ...(sent.tokens !== undefined ? { tokens: sent.tokens, maxTokens: sent.maxTokens } : {}),
    text: text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}\n…` : text,
  };
}

interface ParsedModelOutput {
  current_state?: {
    next_goal?: string;
  };
  action?: (Record<string, unknown> | null)[] | null;
}

export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};

  constructor(actions: Action[]) {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}

interface NavigatorStepMetaInput {
  engineResult: EngineResult;
  llmModel: string;
  decisionMs: number;
  observeMs?: number;
  actMs?: number;
  goal?: string;
  actions: Record<string, unknown>[];
  results: ActionResult[];
  /** what the step told the model besides the results of its actions */
  notes?: string[];
  /** what the model was given about the page */
  view?: PageView;
  /** the elements the actions' indices refer to */
  selectorMap?: Map<number, DOMElementNode>;
}

/** Side-panel record of a finished navigator step: who decided, how fast, and what ran */
export function navigatorStepMeta(input: NavigatorStepMetaInput): StepMeta {
  const { engineResult, llmModel, decisionMs, observeMs, actMs, goal, actions, results, notes, view, selectorMap } =
    input;
  const byEngine = engineResult.decision !== null;
  return {
    kind: 'navigator',
    engine: byEngine ? 'jev' : 'llm',
    model: byEngine && engineResult.trace ? engineResult.trace.model : llmModel,
    latencyMs: decisionMs,
    ...(observeMs !== undefined ? { observeMs } : {}),
    ...(actMs !== undefined ? { actMs } : {}),
    ...(notes?.length ? { notes } : {}),
    goal: byEngine ? undefined : goal || undefined,
    jev: engineResult.trace,
    ...(view ? { view } : {}),
    // only actions that ran; doMultiAction stops early on errors or page changes
    actions: results.map((result, i) => {
      const [name, rawArgs] = Object.entries(actions[i] ?? {})[0] ?? ['unknown', {}];
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      // intent only: typed text may be a password and meta is persisted in chat history
      const detail = typeof args.intent === 'string' && args.intent.trim() ? args.intent : undefined;
      const node = typeof args.index === 'number' ? selectorMap?.get(args.index) : undefined;
      const label = node ? targetLabel(node) : undefined;
      const value = actionValue(name, args);
      return {
        name,
        target: typeof args.index === 'number' ? `[${args.index}]` : undefined,
        ...(label ? { label } : {}),
        ...(value ? { value } : {}),
        detail,
        ok: !result.error,
        error: result.error ?? undefined,
      };
    }),
  };
}

/**
 * Ask the fast engine and the LLM at the same time and take what is usable first. An engine decision
 * cancels the LLM call; an LLM answer that is ready while the engine is still working cancels the engine,
 * so a slow or stalled engine never holds a finished answer back.
 */
export async function decideWithEngineOrLLM<T>(
  taskSignal: AbortSignal,
  engine: (signal: AbortSignal) => Promise<EngineResult>,
  llm: (signal: AbortSignal) => Promise<T>,
): Promise<{ engineResult: EngineResult; modelOutput: T }> {
  const engineController = new AbortController();
  const llmController = new AbortController();
  const abortBoth = () => {
    engineController.abort();
    llmController.abort();
  };
  taskSignal.addEventListener('abort', abortBoth, { once: true });
  const engineCall = engine(engineController.signal);
  const llmCall = llm(llmController.signal);
  // the cancelled call rejects with nobody waiting for it
  engineCall.catch(() => {});
  llmCall.catch(() => {});
  try {
    const engineResult = await Promise.race([
      engineCall,
      // a failed LLM call leaves the step to the engine
      llmCall.then(
        (): EngineResult => ({ decision: null }),
        () => engineCall,
      ),
    ]);
    if (engineResult.decision) {
      llmController.abort();
      return { engineResult, modelOutput: engineResult.decision as T };
    }
    engineController.abort();
    return { engineResult, modelOutput: await llmCall };
  } finally {
    taskSignal.removeEventListener('abort', abortBoth);
  }
}

/** How often the same actions may run on the same page before the model is told they change nothing */
const REPEAT_LIMIT = 3;
/** How often they may run at all: beyond this they are refused and the plan is made again */
export const STUCK_LIMIT = 5;

/** Page text without the numbers outside element indices: a countdown ticking on it does not make it another page */
export function withoutTicking(text: string): string {
  return text.replace(/(^|[^[\d])\d+(?![\d\]])/g, '$1#');
}

/** Counts identical actions taken on an identical page: the mark of a model going round in circles */
export class RepeatedActionTracker {
  private counts = new Map<string, number>();

  private key(actions: Record<string, unknown>[], page: string): string {
    // the intent is free text the model rewords from step to step,
    // and the mark on elements new since the last step says nothing about this page
    return (
      JSON.stringify(actions, (name, value) => (name === 'intent' ? undefined : value)) +
      '\n' +
      page.replace(/\*\[(\d+)\]/g, '[$1]')
    );
  }

  /** @returns how often these actions already ran on this page */
  count(actions: Record<string, unknown>[], page: string): number {
    return this.counts.get(this.key(actions, page)) ?? 0;
  }

  /** @returns a note for the model once the actions have been repeated too often on this page, else null */
  record(actions: Record<string, unknown>[], page: string): string | null {
    const key = this.key(actions, page);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count < REPEAT_LIMIT) return null;
    return `Warning: this exact action has now been taken ${count} times on this same page and the page did not change, so repeating it again will not help. Do something different: type into a text field with input_text directly (no click needed first), press Enter with send_keys, close a dropdown or popup that covers the page with send_keys Escape, use another element, or call done and explain what is blocking you.`;
  }

  reset(): void {
    this.counts.clear();
  }
}

/** After this many steps the model itself judged Failed, clicking the same element again is refused */
export const FAILED_CLICK_LIMIT = 2;

/** An element the model clicked, known by where it is and by what it reads (its index changes every step) */
export interface ClickTarget {
  /** how it reads in a message, e.g. `[124] <div> "关注"` */
  label: string;
  keys: string[];
}

export function clickTargets(
  actions: Record<string, unknown>[],
  selectorMap: Map<number, DOMElementNode>,
  url: string,
): ClickTarget[] {
  let page = url;
  try {
    const parsed = new URL(url);
    page = parsed.origin + parsed.pathname;
  } catch {
    // not a full address: as it is
  }
  const targets: ClickTarget[] = [];
  for (const action of actions) {
    const index = (action.click_element as { index?: number } | undefined)?.index;
    const node = index === undefined ? undefined : selectorMap.get(index);
    if (!node) continue;
    const label = String(node);
    const reads = label.replace(/^\[\d+\]\s*/, '');
    const keys = [`${page}|x|${node.xpath}`];
    // an element with nothing to read is known by its place alone
    if (reads !== `<${node.tagName}>`) keys.push(`${page}|l|${reads}|${node.attributes.href ?? ''}`);
    targets.push({ label, keys });
  }
  return targets;
}

/**
 * Remembers which elements the model clicked in steps it went on to judge Failed. A model on a wrong path
 * (clicking 关注 for the like button, a link to "close" a panel) varies the index and the page from round
 * to round, so identical-action counting never notices; the element and its own verdicts do.
 */
export class FailedClickTracker {
  private failures = new Map<string, number>();
  private pending: ClickTarget[] = [];

  /** The model's evaluation of the step before: a failure counts against the elements that step clicked */
  judge(evaluation: string | undefined): void {
    if (evaluation && /^\W*fail/i.test(evaluation.trim())) {
      for (const target of this.pending) {
        for (const key of target.keys) this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
      }
    }
    this.pending = [];
  }

  count(target: ClickTarget): number {
    return Math.max(0, ...target.keys.map(key => this.failures.get(key) ?? 0));
  }

  /** @returns why these clicks are not taken, when one of them already went wrong too often, else null */
  refusal(targets: ClickTarget[]): string | null {
    const bad = targets.find(target => this.count(target) >= FAILED_CLICK_LIMIT);
    if (!bad) return null;
    return `Not done: clicking ${bad.label} already went wrong ${this.count(bad)} times in this task (you judged those steps Failed), so it was refused. It is not the element you are looking for, whatever its index is now. Step back and rethink: read the element list for one whose text, aria-label or icon matches what you want, hover or look at the screenshot to identify icon-only buttons, close a popup with send_keys Escape instead of clicking links, or call done and explain what blocks you.`;
  }

  /** The clicks this step takes, to be judged by the next evaluation */
  remember(targets: ClickTarget[]): void {
    this.pending = targets;
  }

  reset(): void {
    this.failures.clear();
    this.pending = [];
  }
}

export interface NavigatorResult {
  done: boolean;
  /** the model chose actions it had already repeated too often; they were not taken */
  stuck?: boolean;
  /** a read_page brought the page's text into the history */
  readPage?: boolean;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private jsonSchema: Record<string, unknown>;
  private _stateHistory: BrowserStateHistory | null = null;
  private decisionEngine: NavigatorDecisionEngine | null = null;
  private readonly repeats = new RepeatedActionTracker();
  private readonly failedClicks = new FailedClickTracker();
  /** Set when a step left its remaining actions out because the page changed under them */
  private cutShort: ActionResult | null = null;

  constructor(
    actionRegistry: NavigatorActionRegistry,
    options: BaseAgentOptions,
    extraOptions?: Partial<ExtraAgentOptions>,
  ) {
    super(actionRegistry.setupModelOutputSchema(), options, { ...extraOptions, id: 'navigator' });

    this.actionRegistry = actionRegistry;

    // The zod object is too complex to be used directly, so we need to convert it to json schema first for the model to use
    this.jsonSchema = convertZodToJsonSchema(this.modelOutputSchema, 'NavigatorAgentOutput', true);
  }

  /**
   * Some models (seen with DeepSeek) call an action as a tool of its own, e.g. `open_tab({url})`, instead of
   * sending it inside the AgentOutput tool. Such calls are taken as the step's actions, in order.
   */
  protected override parseRawStructuredResponse(raw: BaseMessage | undefined): this['ModelOutput'] | undefined {
    const recovered = super.parseRawStructuredResponse(raw);
    if (recovered || !raw) return recovered;

    const toolCalls = (raw as BaseMessage & { tool_calls?: Array<{ name?: string; args?: unknown }> }).tool_calls ?? [];
    const actions = toolCalls
      .filter(call => call.name && this.actionRegistry.getAction(call.name))
      .map(call => ({ [call.name as string]: call.args ?? {} }));
    if (actions.length === 0 || actions.length !== toolCalls.length) return undefined;

    const firstArgs = toolCalls[0].args as { intent?: unknown } | undefined;
    const result = this.modelOutputSchema.safeParse({
      current_state: {
        evaluation_previous_goal: '',
        memory: '',
        next_goal: typeof firstArgs?.intent === 'string' ? firstArgs.intent : '',
      },
      action: actions,
    });
    if (!result.success) return undefined;
    logger.warning(`[${this.modelName}] Took bare action tool calls as the step's actions`);
    return result.data;
  }

  async invoke(
    inputMessages: BaseMessage[],
    signal: AbortSignal = this.context.controller.signal,
  ): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      const structuredLlm = this.chatLLM.withStructuredOutput(this.jsonSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        // Thinking Claude models expect thinking blocks before every tool call in the history;
        // the navigator replays its outputs without them, so they are shown as text instead
        const messages = isAnthropicAdaptiveThinkingModel(this.modelName)
          ? convertMessagesForPlanner(inputMessages)
          : inputMessages;
        response = await withModelTimeout(this.modelName, signal, callSignal =>
          structuredLlm.invoke(messages, {
            signal: callSignal,
            tags: [this.id],
            ...this.callOptions,
          }),
        );

        if (response.parsed) {
          return response.parsed;
        }
      } catch (error) {
        if (isAbortedError(error) || error instanceof ModelTimeoutError) {
          throw error;
        }

        // Try to extract JSON from markdown code blocks if parsing failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            return parsed;
          }
        }

        const recovered = this.parseRawStructuredResponse(response?.raw);
        if (recovered) {
          logger.warning(
            `[${this.modelName}] Recovered navigator output from raw response after error: ${errorMessage}`,
          );
          return recovered;
        }
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }

      const recovered = this.parseRawStructuredResponse(response?.raw);
      if (recovered) {
        logger.info(`[${this.modelName}] Recovered navigator output from raw response`);
        return recovered;
      }

      throw new ResponseParseError(
        `Could not parse navigator response (${this.getRawResponseDebugInfo(response?.raw)})`,
      );
    }

    // Fallback to parent class manual JSON extraction for models without structured output support
    return super.invoke(inputMessages, signal);
  }

  async execute(): Promise<AgentOutput<NavigatorResult>> {
    const agentOutput: AgentOutput<NavigatorResult> = {
      id: this.id,
    };

    let cancelled = false;
    let modelOutputString: string | null = null;
    let browserStateHistory: BrowserStateHistory | null = null;
    let actionResults: ActionResult[] = [];
    let decisionSignal: AbortSignal | null = null;

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');

      const messageManager = this.context.messageManager;
      // add the browser state message
      const observeStarted = performance.now();
      await this.addStateMessageToMemory();
      const currentState = await this.context.browserContext.getCachedState();
      const observeMs = Math.round(performance.now() - observeStarted);
      browserStateHistory = new BrowserStateHistory(currentState);

      // the side panel shows what the model is looking at while it decides
      const pageText = currentState.elementTree.clickableElementsToString(this.context.options.includeAttributes);
      const view = pageView(currentState, pageText, {
        screenshot: Boolean(currentState.screenshot && this.context.options.useVision),
        ...messageManager.tokenUsage(),
      });
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OBSERVE, view.title || view.url, {
        kind: 'observe',
        view,
      });

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);

      const decisionStarted = performance.now();
      decisionSignal = this.context.interruptibleSignal();
      const { engineResult, modelOutput } = await this.decide(currentState, inputMessages, decisionSignal);
      const decisionMs = Math.round(performance.now() - decisionStarted);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      const actions = this.fixActions(modelOutput);
      modelOutput.action = actions;
      modelOutputString = JSON.stringify(modelOutput);

      // remove the last state message from memory before adding the model output
      this.removeLastStateMessageFromMemory();
      this.addModelOutputToMemory(modelOutput);

      const decidedBy = engineResult.decision ? this.decisionEngine?.name : this.modelName;
      logger.info(`🧠 step ${this.context.nSteps + 1} decided by ${decidedBy} in ${decisionMs}ms`, {
        evaluation: modelOutput.current_state?.evaluation_previous_goal,
        memory: modelOutput.current_state?.memory,
        nextGoal: modelOutput.current_state?.next_goal,
        actions: actionsForLog(actions, currentState.selectorMap),
      });

      const goal = modelOutput.current_state?.next_goal?.trim();
      if (goal) this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_DECIDED, goal);

      // take the actions, resolving indices against the state the decision was made on
      const actStarted = performance.now();
      const pageKey = `${currentState.url}\n${currentState.scrollY}\n${withoutTicking(pageText)}`;
      const ranBefore = this.repeats.count(actions, pageKey);
      this.failedClicks.judge(modelOutput.current_state?.evaluation_previous_goal);
      const targets = clickTargets(actions, currentState.selectorMap, currentState.url);
      const refusal = this.failedClicks.refusal(targets);
      const stuck = ranBefore >= STUCK_LIMIT || refusal !== null;
      if (refusal) {
        logger.warning('Refused a click that already went wrong', actionsForLog(actions, currentState.selectorMap));
        actionResults = [new ActionResult({ error: refusal, includeInMemory: true })];
      } else if (stuck) {
        logger.warning(
          `Refused actions already taken ${ranBefore} times on this page`,
          actionsForLog(actions, currentState.selectorMap),
        );
        actionResults = [
          new ActionResult({
            error: `Not done: this exact action was already taken ${ranBefore} times on this same page and changed nothing, so it was refused. Follow the new plan with a different action: another element, go_to_url to reload the page, scrolling, or done explaining what blocks you.`,
            includeInMemory: true,
          }),
        ];
      } else {
        this.failedClicks.remember(targets);
        actionResults = await this.doMultiAction(actions, currentState);
      }
      const actMs = Math.round(performance.now() - actStarted);
      logger.info(
        `⏱ step ${this.context.nSteps + 1}: observe ${observeMs}ms, decide ${decisionMs}ms (${engineResult.decision ? this.decisionEngine?.name : this.modelName}), act ${actMs}ms`,
      );
      this.decisionEngine?.observeStep(actions, actionResults);
      // logger.info('Action results', JSON.stringify(actionResults, null, 2));

      // goes into memory with the results, so the navigator and the planner both read it
      const repeatNote = stuck ? null : this.repeats.record(actions, pageKey);
      if (repeatNote) logger.warning(repeatNote);
      const cutShort = this.cutShort;
      this.context.actionResults = repeatNote
        ? [...actionResults, new ActionResult({ extractedContent: repeatNote, includeInMemory: true })]
        : actionResults;

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }
      // emit event
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.STEP_OK,
        'Navigation done',
        navigatorStepMeta({
          engineResult,
          llmModel: this.modelName,
          decisionMs,
          observeMs,
          actMs,
          goal: modelOutput.current_state?.next_goal,
          actions,
          // the note about the page changing stands for no action
          results: actionResults.filter(result => result !== cutShort),
          notes: [cutShort?.extractedContent, repeatNote].filter((note): note is string => !!note),
          view,
          selectorMap: currentState.selectorMap,
        }),
      );
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      agentOutput.result = { done, stuck, readPage: actionResults.some(result => result.readPage) };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (decisionSignal?.aborted && !this.context.controller.signal.aborted && !this.context.stopped) {
        // the user sent a message while the model decided: the step is dropped and the plan redone with it
        logger.info('Decision dropped for a message from the user');
        return agentOutput;
      }
      // Check if this is an authentication error
      if (error instanceof ModelTimeoutError) {
        throw error;
      } else if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (error instanceof URLNotAllowedError) {
        throw error;
      }

      const errorString = `Navigation failed: ${errorMessage}`;
      logger.error(`Navigation failed: ${describeError(error)}`);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, errorString);
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      // if the task is cancelled, remove the last state message from memory and emit event
      if (cancelled) {
        this.removeLastStateMessageFromMemory();
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      if (browserStateHistory) {
        // Create a copy of actionResults to store in history
        const actionResultsCopy = actionResults.map(result => {
          return new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          });
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory);
        this.context.history.history.push(history);

        // logger.info('All history', JSON.stringify(this.context.history, null, 2));
      }
    }
  }

  /** A new task may well repeat what an earlier one did */
  resetRepeats(): void {
    this.repeats.reset();
    this.failedClicks.reset();
  }

  setDecisionEngine(engine: NavigatorDecisionEngine | null): void {
    this.decisionEngine = engine;
  }

  private async decide(
    state: BrowserState,
    inputMessages: BaseMessage[],
    signal: AbortSignal,
  ): Promise<{ engineResult: EngineResult; modelOutput: NavigatorAgent['ModelOutput'] }> {
    if (!this.decisionEngine) {
      return { engineResult: { decision: null }, modelOutput: await this.invoke(inputMessages, signal) };
    }
    const started = performance.now();
    const decided = await decideWithEngineOrLLM<NavigatorAgent['ModelOutput']>(
      signal,
      signal => this.decideWithEngine(state, signal),
      signal => this.invoke(inputMessages, signal),
    );
    const { engineResult } = decided;
    if (engineResult.decision || engineResult.trace) return decided;
    // no record of the engine means it was still working when the LLM answered
    const waitedMs = Math.round(performance.now() - started);
    return {
      ...decided,
      engineResult: {
        decision: null,
        trace: {
          model: this.decisionEngine.name,
          latencyMs: waitedMs,
          operation: 'LATE',
          confidence: 0,
          alternatives: [],
          deferred: 'slower than the LLM',
          noPick: `${this.decisionEngine.name} had not answered after ${waitedMs}ms when the LLM did, so the LLM's answer was used`,
        },
      },
    };
  }

  /**
   * Ask the fast decision engine; null means this step goes to the LLM
   */
  private async decideWithEngine(state: BrowserState, signal: AbortSignal): Promise<EngineResult> {
    if (!this.decisionEngine) return { decision: null };
    const started = performance.now();
    try {
      return await this.decisionEngine.decide(state, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warning(`[${this.decisionEngine.name}] decision failed, falling back to LLM`, error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        decision: null,
        trace: {
          model: this.decisionEngine.name,
          latencyMs: Math.round(performance.now() - started),
          operation: 'ERROR',
          confidence: 0,
          alternatives: [],
          deferred: message.slice(0, 120),
          noPick: message.slice(0, 600),
        },
      };
    }
  }

  /**
   * Add the state message to the memory
   */
  public async addStateMessageToMemory() {
    if (this.context.stateMessageAdded) {
      return;
    }

    const messageManager = this.context.messageManager;
    // Handle results that should be included in memory
    if (this.context.actionResults.length > 0) {
      let index = 0;
      for (const r of this.context.actionResults) {
        if (r.includeInMemory) {
          if (r.extractedContent) {
            const msg = new HumanMessage(`Action result: ${r.extractedContent}`);
            // logger.info('Adding action result to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          if (r.error) {
            // Get error text and convert to string
            const errorText = r.error.toString().trim();

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || '';

            const msg = new HumanMessage(`Action error: ${lastLine}`);
            logger.info('Adding action error to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          // reset this action result to empty, we dont want to add it again in the state message
          // NOTE: in python version, all action results are reset to empty, but in ts version, only those included in memory are reset to empty
          this.context.actionResults[index] = new ActionResult();
        }
        index++;
      }
    }

    const state = await this.prompt.getUserMessage(this.context);
    messageManager.addStateMessage(state);
    this.context.stateMessageAdded = true;
  }

  /**
   * Remove the last state message from the memory
   */
  protected async removeLastStateMessageFromMemory() {
    if (!this.context.stateMessageAdded) return;
    const messageManager = this.context.messageManager;
    messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private async addModelOutputToMemory(modelOutput: this['ModelOutput']) {
    const messageManager = this.context.messageManager;
    messageManager.addModelOutput(modelOutput);
  }

  /**
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    if (Array.isArray(response.action)) {
      // if the item is null, skip it
      actions = response.action.filter((item: unknown) => item !== null);
      if (actions.length === 0) {
        logger.warning('No valid actions found', response.action);
      }
    } else if (typeof response.action === 'string') {
      try {
        logger.warning('Unexpected action format', response.action);
        // First try to parse the action string directly
        actions = JSON.parse(response.action);
      } catch (parseError) {
        try {
          // If direct parsing fails, try to fix the JSON first
          const fixedAction = repairJsonString(response.action);
          logger.info('Fixed action string', fixedAction);
          actions = JSON.parse(fixedAction);
        } catch (error) {
          logger.error('Invalid action format even after repair attempt', response.action);
          throw new Error('Invalid action output format');
        }
      }
    } else {
      // if the action is neither an array nor a string, it should be an object
      actions = [response.action];
    }
    return actions;
  }

  private async doMultiAction(actions: Record<string, unknown>[], browserState: BrowserState): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let errCount = 0;
    this.cutShort = null;

    const browserContext = this.context.browserContext;
    this.context.observedSelectorMap = browserState.selectorMap;
    const cachedPathHashes = await calcBranchPathHashSet(browserState);

    await browserContext.removeHighlight();

    for (const [i, action] of actions.entries()) {
      const actionName = Object.keys(action)[0];
      const actionArgs = action[actionName];
      try {
        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }

        const actionInstance = this.actionRegistry.getAction(actionName);
        if (actionInstance === undefined) {
          throw new Error(`Action ${actionName} not exists`);
        }

        const indexArg = actionInstance.getIndexArg(actionArgs);
        if (i > 0 && indexArg !== null) {
          const newState = await browserContext.getState(this.context.options.useVision);
          const newPathHashes = await calcBranchPathHashSet(newState);
          // next action requires index but there are new elements on the page
          if (!newPathHashes.isSubsetOf(cachedPathHashes)) {
            const msg = `Something new appeared after action ${i} / ${actions.length}, so the remaining ${actions.length - i} were not run`;
            logger.info(msg);
            this.cutShort = new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
            results.push(this.cutShort);
            break;
          }
        }

        if (PAGE_INPUT_ACTIONS.has(actionName)) {
          const mode = this.context.options.actionMode;
          if (mode === 'readonly') {
            results.push(new ActionResult({ error: t('act_readonly_blocked', [actionName]), includeInMemory: true }));
            break;
          }
          if (mode === 'manual') {
            const description = describePageInput(actionName, actionArgs, browserState.selectorMap);
            const approved = await this.context.requestConfirmation(
              Actors.NAVIGATOR,
              t('act_confirm_manual', [description]),
            );
            if (!approved) {
              results.push(
                new ActionResult({ error: t('act_confirm_manual_declined', [description]), includeInMemory: true }),
              );
              break;
            }
          }
        }

        const target = indexArg !== null ? describeTarget(browserState.selectorMap.get(indexArg)) : '';
        logger.info(`▶ ${actionsForLog([action], browserState.selectorMap)}${target ? ` on ${target}` : ''}`);
        const actionStarted = performance.now();
        const result = await actionInstance.call(actionArgs);
        if (result === undefined) {
          throw new Error(`Action ${actionName} returned undefined`);
        }
        const actionMs = Math.round(performance.now() - actionStarted);
        if (result.error) {
          logger.warning(`✗ ${actionName} failed in ${actionMs}ms: ${result.error}`);
        } else {
          const outcome = result.extractedContent?.replace(/\s+/g, ' ').slice(0, 300);
          logger.info(
            `✓ ${actionName} in ${actionMs}ms${result.isDone ? ' (done)' : ''}${outcome ? `: ${outcome}` : ''}`,
          );
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = browserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
          }
        }
        results.push(result);

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }
        // actions planned before the user's reply may no longer be what they want
        if (actionName === 'ask_user') break;
        // the rest was planned on this one working (typing then sending): don't send an empty box
        if (result.error && i < actions.length - 1) {
          this.cutShort = skippedAfterFailure(i, actions.length);
          results.push(this.cutShort);
          break;
        }
        // Let the page react before the next action; after the last one, the next step's observation
        // already waits for the network to go idle.
        if (i < actions.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`✗ ${actionsForLog([action], browserState.selectorMap)} threw: ${describeError(error)}`);
        // unexpected error, emit event
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMessage);
        errCount++;
        if (errCount > 3) {
          throw new Error('Too many errors in actions');
        }
        results.push(
          new ActionResult({
            error: errorMessage,
            isDone: false,
            includeInMemory: true,
          }),
        );
        if (i < actions.length - 1) {
          this.cutShort = skippedAfterFailure(i, actions.length);
          results.push(this.cutShort);
          break;
        }
      }
    }
    return results;
  }

  /**
   * Parse and validate model output from history item
   */
  private parseHistoryModelOutput(historyItem: AgentStepRecord): {
    parsedOutput: ParsedModelOutput;
    goal: string;
    actionsToReplay: (Record<string, unknown> | null)[] | null;
  } {
    if (!historyItem.modelOutput) {
      throw new Error('No model output found in history item');
    }

    let parsedOutput: ParsedModelOutput;
    try {
      parsedOutput = JSON.parse(historyItem.modelOutput) as ParsedModelOutput;
    } catch (error) {
      throw new Error(`Could not parse modelOutput: ${error}`);
    }

    // logger.info('Parsed output', JSON.stringify(parsedOutput, null, 2));

    const goal = parsedOutput?.current_state?.next_goal || '';
    const actionsToReplay = parsedOutput?.action;

    // Validate that there are actions to replay
    if (
      !parsedOutput || // No model output string at all
      !actionsToReplay || // 'action' field is missing or null after parsing
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 0) || // 'action' is an empty array
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 1 && actionsToReplay[0] === null) // 'action' is [null]
    ) {
      throw new Error('No action to replay');
    }

    return { parsedOutput, goal, actionsToReplay };
  }

  /**
   * Execute actions from history with element index updates
   */
  private async executeHistoryActions(
    parsedOutput: ParsedModelOutput,
    historyItem: AgentStepRecord,
    delay: number,
  ): Promise<ActionResult[]> {
    const state = await this.context.browserContext.getState(this.context.options.useVision);
    if (!state) {
      throw new Error('Invalid browser state');
    }

    const updatedActions: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < parsedOutput.action!.length; i++) {
      const result = historyItem.result[i];
      if (!result) {
        break;
      }
      const interactedElement = result.interactedElement;
      const currentAction = parsedOutput.action![i];

      // Skip null actions
      if (currentAction === null) {
        updatedActions.push(null);
        continue;
      }

      // If there's no interacted element, just use the action as is
      if (!interactedElement) {
        updatedActions.push(currentAction);
        continue;
      }

      const updatedAction = await this.updateActionIndices(interactedElement, currentAction, state);
      updatedActions.push(updatedAction);

      if (updatedAction === null) {
        throw new Error(`Could not find matching element ${i} in current page`);
      }
    }

    logger.debug('updatedActions', updatedActions);

    // Filter out null values and cast to the expected type
    const validActions = updatedActions.filter((action): action is Record<string, unknown> => action !== null);
    const result = await this.doMultiAction(validActions, state);

    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delay));
    return result;
  }

  async executeHistoryStep(
    historyItem: AgentStepRecord,
    stepIndex: number,
    totalSteps: number,
    maxRetries = 3,
    delay = 1000,
    skipFailures = true,
  ): Promise<ActionResult[]> {
    const replayLogger = createLogger('NavigatorAgent:executeHistoryStep');
    const results: ActionResult[] = [];

    // Parse and validate model output
    let parsedData: {
      parsedOutput: ParsedModelOutput;
      goal: string;
      actionsToReplay: (Record<string, unknown> | null)[] | null;
    };
    try {
      parsedData = this.parseHistoryModelOutput(historyItem);
    } catch (error) {
      const errorMsg = `Step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      replayLogger.warning(errorMsg);
      return [
        new ActionResult({
          error: errorMsg,
          includeInMemory: false,
        }),
      ];
    }

    const { parsedOutput, goal, actionsToReplay } = parsedData;
    replayLogger.info(`Replaying step ${stepIndex + 1}/${totalSteps}: goal: ${goal}`);
    replayLogger.debug(`🔄 Replaying actions:`, actionsToReplay);

    // Try to execute the step with retries
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history actions
        const stepResults = await this.executeHistoryActions(parsedOutput, historyItem, delay);
        results.push(...stepResults);
        success = true;
      } catch (error) {
        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (retryCount >= maxRetries) {
          const failMsg = `Step ${stepIndex + 1} failed after ${maxRetries} attempts: ${errorMessage}`;
          replayLogger.error(failMsg);

          results.push(
            new ActionResult({
              error: failMsg,
              includeInMemory: true,
            }),
          );

          if (!skipFailures) {
            throw new Error(failMsg);
          }
        } else {
          replayLogger.warning(`Step ${stepIndex + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return results;
  }

  async updateActionIndices(
    historicalElement: DOMHistoryElement,
    action: Record<string, unknown>,
    currentState: BrowserState,
  ): Promise<Record<string, unknown> | null> {
    // If no historical element or no element tree in current state, return the action unchanged
    if (!historicalElement || !currentState.elementTree) {
      return action;
    }

    // Find the current element in the tree based on the historical element
    const currentElement = await HistoryTreeProcessor.findHistoryElementInTree(
      historicalElement,
      currentState.elementTree,
    );

    // If no current element found or it doesn't have a highlight index, return null
    if (!currentElement || currentElement.highlightIndex === null) {
      return null;
    }

    // Get action name and args
    const actionName = Object.keys(action)[0];
    const actionArgs = action[actionName] as Record<string, unknown>;

    // Get the action instance to access the index
    const actionInstance = this.actionRegistry.getAction(actionName);
    if (!actionInstance) {
      return action;
    }

    // Get the index argument from the action
    const oldIndex = actionInstance.getIndexArg(actionArgs);

    // If the index has changed, update it
    if (oldIndex !== null && oldIndex !== currentElement.highlightIndex) {
      // Create a new action object with the updated index
      const updatedAction: Record<string, unknown> = { [actionName]: { ...actionArgs } };

      // Update the index in the action arguments
      actionInstance.setIndexArg(updatedAction[actionName] as Record<string, unknown>, currentElement.highlightIndex);

      logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`);
      return updatedAction;
    }

    return action;
  }
}

/** The note left when an action failed and the ones planned after it were not run */
function skippedAfterFailure(index: number, total: number): ActionResult {
  const msg = `Action ${index + 1} / ${total} failed, so the remaining ${total - index - 1} were not run`;
  logger.info(msg);
  return new ActionResult({ extractedContent: msg, includeInMemory: true });
}
