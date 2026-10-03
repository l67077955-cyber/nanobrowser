import { z } from 'zod';
import type BrowserContext from '../browser/context';
import { DEFAULT_INCLUDE_ATTRIBUTES } from '../browser/dom/views';
import type { DOMHistoryElement } from '../browser/dom/history/view';
import type { DOMElementNode } from '../browser/dom/views';
import type MessageManager from './messages/service';
import type { EventManager } from './event/manager';
import { type Actors, ExecutionState, AgentEvent } from './event/types';
import { AgentStepHistory } from './history';
import type { ActionMode, StepMeta } from '@extension/storage';

export interface AgentOptions {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  retryDelay: number;
  maxInputTokens: number;
  maxErrorLength: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  includeAttributes: string[];
  planningInterval: number;
  /** readonly drops the actions that act on a page, manual asks the user before each of them */
  actionMode: ActionMode;
}

export const DEFAULT_AGENT_OPTIONS: AgentOptions = {
  maxSteps: 100,
  maxActionsPerStep: 10,
  maxFailures: 3,
  retryDelay: 10,
  maxInputTokens: 128000,
  maxErrorLength: 400,
  useVision: false,
  useVisionForPlanner: true,
  includeAttributes: DEFAULT_INCLUDE_ATTRIBUTES,
  planningInterval: 3,
  actionMode: 'auto',
};

export class AgentContext {
  controller: AbortController;
  taskId: string;
  browserContext: BrowserContext;
  messageManager: MessageManager;
  eventManager: EventManager;
  options: AgentOptions;
  paused: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  nSteps: number;
  stepInfo: AgentStepInfo | null;
  actionResults: ActionResult[];
  stateMessageAdded: boolean;
  history: AgentStepHistory;
  finalAnswer: string | null;
  /** element indices as the deciding model saw them; actions resolve their index here, not in a re-read DOM */
  observedSelectorMap: Map<number, DOMElementNode> | null;
  private pendingConfirmation: ((approved: boolean) => void) | null;
  private pendingQuestion: ((answer: string | null) => void) | null = null;
  private stepInterrupt = new AbortController();

  constructor(
    taskId: string,
    browserContext: BrowserContext,
    messageManager: MessageManager,
    eventManager: EventManager,
    options: Partial<AgentOptions>,
  ) {
    this.controller = new AbortController();
    this.taskId = taskId;
    this.browserContext = browserContext;
    this.messageManager = messageManager;
    this.eventManager = eventManager;
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };

    this.paused = false;
    this.stopped = false;
    this.nSteps = 0;
    this.consecutiveFailures = 0;
    this.stepInfo = null;
    this.actionResults = [];
    this.stateMessageAdded = false;
    this.history = new AgentStepHistory();
    this.finalAnswer = null;
    this.observedSelectorMap = null;
    this.pendingConfirmation = null;
  }

  async emitEvent(actor: Actors, state: ExecutionState, eventDetails: string, meta?: StepMeta) {
    const event = new AgentEvent(actor, state, {
      taskId: this.taskId,
      step: this.nSteps,
      maxSteps: this.options.maxSteps,
      details: eventDetails,
      meta,
    });
    await this.eventManager.emit(event);
  }

  async pause() {
    this.paused = true;
  }

  async resume() {
    this.paused = false;
  }

  async stop() {
    this.stopped = true;
    this.resolveConfirmation(false);
    this.answerQuestion(null);
    setTimeout(() => this.controller.abort(), 300);
  }

  /** The signal for a navigator decision: it ends when the task stops or when the user sends a message meanwhile */
  interruptibleSignal(): AbortSignal {
    this.stepInterrupt = new AbortController();
    return AbortSignal.any([this.controller.signal, this.stepInterrupt.signal]);
  }

  /** The user said something: a decision still being made would not know it, so it is dropped */
  interruptStep(): void {
    this.stepInterrupt.abort();
  }

  /** Ask the side panel to approve an action; resolves false if declined or the task stops */
  requestConfirmation(actor: Actors, description: string): Promise<boolean> {
    this.resolveConfirmation(false);
    return new Promise(resolve => {
      this.pendingConfirmation = resolve;
      void this.emitEvent(actor, ExecutionState.ACT_CONFIRM, description);
    });
  }

  resolveConfirmation(approved: boolean): void {
    const resolve = this.pendingConfirmation;
    this.pendingConfirmation = null;
    resolve?.(approved);
  }

  get awaitingConfirmation(): boolean {
    return this.pendingConfirmation !== null;
  }

  /** Ask the user a question in the chat; resolves with their reply, or null when the task stops first */
  askUser(actor: Actors, question: string): Promise<string | null> {
    this.answerQuestion(null);
    return new Promise(resolve => {
      this.pendingQuestion = resolve;
      void this.emitEvent(actor, ExecutionState.ACT_ASK, question);
    });
  }

  /** Returns false when no question was waiting for an answer */
  answerQuestion(answer: string | null): boolean {
    const resolve = this.pendingQuestion;
    this.pendingQuestion = null;
    resolve?.(answer);
    return resolve !== null;
  }
}

export class AgentStepInfo {
  stepNumber: number;
  maxSteps: number;

  constructor(params: { stepNumber: number; maxSteps: number }) {
    this.stepNumber = params.stepNumber;
    this.maxSteps = params.maxSteps;
  }
}

export class ActionResult {
  isDone: boolean;
  success: boolean;
  extractedContent: string | null;
  error: string | null;
  includeInMemory: boolean;
  interactedElement: DOMHistoryElement | null;

  constructor(params: Partial<ActionResult> = {}) {
    this.isDone = params.isDone ?? false;
    this.success = params.success ?? false;
    this.interactedElement = params.interactedElement ?? null;
    this.extractedContent = params.extractedContent ?? null;
    this.error = params.error ?? null;
    this.includeInMemory = params.includeInMemory ?? false;
  }
}

export type WrappedActionResult = ActionResult & {
  toolCallId: string;
};

export class StepMetadata {
  stepStartTime: number;
  stepEndTime: number;
  inputTokens: number;
  stepNumber: number;

  constructor(stepStartTime: number, stepEndTime: number, inputTokens: number, stepNumber: number) {
    this.stepStartTime = stepStartTime;
    this.stepEndTime = stepEndTime;
    this.inputTokens = inputTokens;
    this.stepNumber = stepNumber;
  }

  /**
   * Calculate step duration in seconds
   */
  get durationSeconds(): number {
    return this.stepEndTime - this.stepStartTime;
  }
}

export const agentBrainSchema = z
  .object({
    evaluation_previous_goal: z.string(),
    memory: z.string(),
    next_goal: z.string(),
  })
  .describe('Current state of the agent');

export type AgentBrain = z.infer<typeof agentBrainSchema>;

// Make AgentOutput generic with Zod schema
export interface AgentOutput<T = unknown> {
  /**
   * The unique identifier for the agent
   */
  id: string;

  /**
   * The result of the agent's step
   */
  result?: T;
  /**
   * The error that occurred during the agent's action
   */
  error?: string;
}
