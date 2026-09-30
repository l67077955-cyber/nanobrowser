import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
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
import type { StepMeta } from '@extension/storage';
import { t } from '@extension/i18n';
import type { DOMElementNode } from '@src/background/browser/dom/views';

const logger = createLogger('NavigatorAgent');

// Clicks on elements named like this are hard to undo; with confirmation on, they wait for the user
const SENSITIVE_LABEL =
  /\b(delete|remove|discard|erase|destroy|unsubscribe|send|submit|publish|post|reply|pay|purchase|buy|checkout|order|transfer|confirm)\b|删除|刪除|移除|清空|发送|發送|发布|發布|提交|支付|付款|购买|購買|下单|下單|转账|轉帳|确认|確認/i;

function elementLabel(node: DOMElementNode): string {
  const attrs = node.attributes;
  const label =
    [attrs['aria-label'], node.getAllTextTillNextClickableElement(2), attrs.title, attrs.value].find(
      c => c && c.trim(),
    ) ?? '';
  const flat = label.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
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
}

/** Side-panel record of a finished navigator step: who decided, how fast, and what ran */
export function navigatorStepMeta(input: NavigatorStepMetaInput): StepMeta {
  const { engineResult, llmModel, decisionMs, observeMs, actMs, goal, actions, results, notes } = input;
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
    // only actions that ran; doMultiAction stops early on errors or page changes
    actions: results.map((result, i) => {
      const [name, rawArgs] = Object.entries(actions[i] ?? {})[0] ?? ['unknown', {}];
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      // intent only: typed text may be a password and meta is persisted in chat history
      const detail = typeof args.intent === 'string' && args.intent.trim() ? args.intent : undefined;
      return {
        name,
        target: typeof args.index === 'number' ? `[${args.index}]` : undefined,
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

/** Counts identical actions taken on an identical page: the mark of a model going round in circles */
export class RepeatedActionTracker {
  private counts = new Map<string, number>();

  /** @returns a note for the model once the actions have been repeated too often on this page, else null */
  record(actions: Record<string, unknown>[], page: string): string | null {
    // the intent is free text the model rewords from step to step
    const key = JSON.stringify(actions, (name, value) => (name === 'intent' ? undefined : value)) + '\n' + page;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count < REPEAT_LIMIT) return null;
    return `Warning: this exact action has now been taken ${count} times on this same page and the page did not change, so repeating it again will not help. Do something different: type into a text field with input_text directly (no click needed first), press Enter with send_keys, close a dropdown or popup that covers the page with send_keys Escape, use another element, or call done and explain what is blocking you.`;
  }

  reset(): void {
    this.counts.clear();
  }
}

export interface NavigatorResult {
  done: boolean;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private jsonSchema: Record<string, unknown>;
  private _stateHistory: BrowserStateHistory | null = null;
  private decisionEngine: NavigatorDecisionEngine | null = null;
  private readonly repeats = new RepeatedActionTracker();
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

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');

      const messageManager = this.context.messageManager;
      // add the browser state message
      const observeStarted = performance.now();
      await this.addStateMessageToMemory();
      const currentState = await this.context.browserContext.getCachedState();
      const observeMs = Math.round(performance.now() - observeStarted);
      browserStateHistory = new BrowserStateHistory(currentState);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);

      const decisionStarted = performance.now();
      const { engineResult, modelOutput } = await this.decide(currentState, inputMessages);
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

      // take the actions, resolving indices against the state the decision was made on
      const actStarted = performance.now();
      actionResults = await this.doMultiAction(actions, currentState);
      const actMs = Math.round(performance.now() - actStarted);
      logger.info(
        `⏱ step ${this.context.nSteps + 1}: observe ${observeMs}ms, decide ${decisionMs}ms (${engineResult.decision ? this.decisionEngine?.name : this.modelName}), act ${actMs}ms`,
      );
      this.decisionEngine?.observeStep(actions, actionResults);
      // logger.info('Action results', JSON.stringify(actionResults, null, 2));

      // goes into memory with the results, so the navigator and the planner both read it
      const repeatNote = this.repeats.record(
        actions,
        `${currentState.url}\n${currentState.scrollY}\n${currentState.elementTree.clickableElementsToString(this.context.options.includeAttributes)}`,
      );
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
        }),
      );
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      agentOutput.result = { done };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      logger.error(errorString);
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
  }

  setDecisionEngine(engine: NavigatorDecisionEngine | null): void {
    this.decisionEngine = engine;
  }

  private async decide(
    state: BrowserState,
    inputMessages: BaseMessage[],
  ): Promise<{ engineResult: EngineResult; modelOutput: NavigatorAgent['ModelOutput'] }> {
    if (!this.decisionEngine) {
      return { engineResult: { decision: null }, modelOutput: await this.invoke(inputMessages) };
    }
    return decideWithEngineOrLLM<NavigatorAgent['ModelOutput']>(
      this.context.controller.signal,
      signal => this.decideWithEngine(state, signal),
      signal => this.invoke(inputMessages, signal),
    );
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
    logger.info('Actions', actions);

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

        if (this.context.options.confirmSensitiveActions && indexArg !== null) {
          const node = browserState.selectorMap.get(indexArg);
          const label = node ? elementLabel(node) : '';
          if (actionName === 'click_element' && SENSITIVE_LABEL.test(label)) {
            const approved = await this.context.requestConfirmation(
              Actors.NAVIGATOR,
              t('act_confirm_click', [indexArg.toString(), label]),
            );
            if (!approved) {
              results.push(
                new ActionResult({
                  error: t('act_confirm_declined', [indexArg.toString(), label]),
                  includeInMemory: true,
                }),
              );
              break;
            }
          }
        }

        const result = await actionInstance.call(actionArgs);
        if (result === undefined) {
          throw new Error(`Action ${actionName} returned undefined`);
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = browserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
            logger.info('Interacted element', interactedElement);
            logger.info('Result', result);
          }
        }
        results.push(result);

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
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
        logger.error(
          'doAction error',
          actionName,
          JSON.stringify(actionArgs, null, 2),
          JSON.stringify(errorMessage, null, 2),
        );
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
