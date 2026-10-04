import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry, PAGE_INPUT_ACTIONS } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger, describeError } from '@src/background/log';
import MessageManager, { type StoredManagedMessage } from './messages/service';
import { filterExternalContent, splitUserTextAndAttachments } from './messages/utils';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  ModelTimeoutError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import {
  type ActionMode,
  type GeneralSettingsConfig,
  describeRepeat,
  parseRepeat,
  scheduleStore,
} from '@extension/storage';
import { analytics } from '../services/analytics';
import { JevDecisionEngine } from './engines/jev';

const logger = createLogger('Executor');

/** The task gives up after failing several times in a row; the last failure says why */
function maxFailuresMessage(lastError: unknown): string {
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  return `${t('exec_errors_maxFailuresReached')}: ${reason}`;
}

/** A planner run going on alongside navigation */
interface BackgroundPlan {
  promise: Promise<AgentOutput<PlannerOutput> | null>;
  settled: boolean;
}

/** What an executor knows, as plain JSON: a later executor of the same session goes on from it */
export interface ExecutorSnapshot {
  tasks: string[];
  messages: StoredManagedMessage[];
  /** results the navigator has not written into the messages yet */
  actionResults: Pick<ActionResult, 'extractedContent' | 'error'>[];
}

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  /** a model that accepts images, for reading image captchas; without one solve_captcha reports that it is missing */
  captchaLLM?: BaseChatModel | null;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  /** what is remembered about the user from earlier conversations */
  memoryContext?: string;
  /** an earlier executor of this session: the task is then a follow-up to what that one knew */
  snapshot?: ExecutorSnapshot;
  /** a run of a scheduled task does not set up more of them */
  allowScheduling?: boolean;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private readonly allowScheduling: boolean;
  private tasks: string[] = [];
  /** how many of the tasks have already been read for things to remember */
  private tasksRemembered = 0;
  /** the request being worked on now is tasks[goalStart]; what the user said after it adds to it */
  private goalStart = 0;
  /** what the user said while the task runs, taken in at the start of the next step */
  private steers: string[] = [];
  /** the step loop is going: a message sent now is taken in by this run */
  private running = false;
  /** the navigator went round in circles: the planner looks again before its next step */
  private planBeforeNextStep = false;
  /** how many history steps have already been read for things to remember */
  private stepsRemembered = 0;
  private latestNextSteps: string | null = null;
  /** step the latest plan was made on: its element indices are only valid on that step */
  private latestPlanStep = 0;
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.allowScheduling = extraArgs?.allowScheduling ?? true;
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM, extraArgs?.captchaLLM ?? null);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());
    // a read-only run is not offered the actions it may not take
    if (context.options.actionMode === 'readonly') {
      for (const name of PAGE_INPUT_ACTIONS) navigatorActionRegistry.unregisterAction(name);
    }

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    // Jev decides clicks and typing, none of which a read-only run takes
    if (
      this.generalSettings?.fastMode &&
      this.generalSettings.fastModeApiKey &&
      context.options.actionMode !== 'readonly'
    ) {
      this.navigator.setDecisionEngine(
        new JevDecisionEngine({
          apiKey: this.generalSettings.fastModeApiKey,
          minOperationConfidence: this.generalSettings.fastModeMinOperationConfidence,
          minTargetConfidence: this.generalSettings.fastModeMinTargetConfidence,
          textLLM: navigatorLLM,
          getGoal: () => this.decisionGoal(),
        }),
      );
    }

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    const snapshot = extraArgs?.snapshot;
    if (snapshot) {
      this.tasks = [...snapshot.tasks];
      this.tasksRemembered = this.tasks.length;
      context.messageManager.restoreMessages(
        this.navigatorPrompt.getSystemMessage(),
        snapshot.messages,
        extraArgs?.memoryContext,
      );
      context.actionResults = snapshot.actionResults.map(
        result => new ActionResult({ ...result, includeInMemory: true }),
      );
      this.addFollowUpTask(task);
      return;
    }
    this.tasks.push(task);
    // Initialize message history
    this.context.messageManager.initTaskMessages(
      this.navigatorPrompt.getSystemMessage(),
      task,
      extraArgs?.memoryContext,
    );
  }

  snapshot(): ExecutorSnapshot {
    const messages = this.context.messageManager.exportMessages();
    // the page is read again when the session goes on
    if (this.context.stateMessageAdded) messages.pop();
    return {
      tasks: [...this.tasks],
      messages,
      actionResults: this.context.actionResults
        .filter(result => result.includeInMemory)
        .map(({ extractedContent, error }) => ({ extractedContent, error })),
    };
  }

  /** A cancelled executor takes no more tasks */
  get stopped(): boolean {
    return this.context.stopped;
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.goalStart = this.tasks.length;
    this.tasks.push(task);
    // the plan belonged to the previous task
    this.latestNextSteps = null;
    this.navigator.resetRepeats();
    this.planBeforeNextStep = false;
    // the page the planner finished on is read again: the user may be on another tab or page by now
    if (this.context.stateMessageAdded) {
      this.context.messageManager.removeLastStateMessage();
      this.context.stateMessageAdded = false;
    }
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Something the user sent while this task runs. It answers a question the agent is waiting on, or it is
   * taken in at the start of the next step and the plan is made again with it. Returns false when the run
   * is over (or about to be): the message is then a follow-up task of its own.
   */
  steer(text: string): boolean {
    if (!this.running || this.context.stopped) return false;
    this.tasks.push(text);
    if (this.context.answerQuestion(text)) return true;
    // a message instead of a click on Approve or Decline: the action waits no longer, the message says why
    if (this.context.awaitingConfirmation) this.context.resolveConfirmation(false);
    this.steers.push(text);
    // the model may take minutes on a step the message changes: it is not waited for
    this.context.interruptStep();
    return true;
  }

  /** The user's messages from the middle of the run go into the history, and the plan is redone with them */
  private takeInSteers(): void {
    const steers = this.steers.splice(0);
    if (this.context.stateMessageAdded) {
      this.context.messageManager.removeLastStateMessage();
      this.context.stateMessageAdded = false;
    }
    for (const text of steers) {
      this.context.messageManager.addUserNote(
        `While you were working, the user added: """${text}""". Take it into account from now on: it may add to, narrow, change or replace the task.`,
      );
    }
    this.latestNextSteps = null;
    this.navigator.resetRepeats();
    this.planBeforeNextStep = false;
  }

  /**
   * What the user wrote since the last call, for memory. Their earlier messages and the files they
   * attached in the session come along, so that "remember this" can be resolved; the newest file first.
   */
  takeUserMessagesToRemember(): { messages: string[]; earlier: string[]; attachments: string } {
    const parts = this.tasks.map(task => splitUserTextAndAttachments(task));
    const said = parts.map(part => part.userText);
    const messages = said.slice(this.tasksRemembered);
    const earlier = said.slice(0, this.tasksRemembered);
    this.tasksRemembered = this.tasks.length;
    const attachments = parts
      .map(part => part.attachmentsInner)
      .filter((inner): inner is string => !!inner)
      .reverse()
      .map(inner => filterExternalContent(inner))
      .join('\n\n');
    return { messages, earlier, attachments };
  }

  /**
   * What the work since the last call showed: the sites it went to and what it came to. Memory reads it
   * alongside the user's messages, so that it learns from what was done and not only from what was said.
   */
  takeWorkToRemember(): { sites: string[]; outcome: string } {
    const steps = this.context.history.history.slice(this.stepsRemembered);
    this.stepsRemembered = this.context.history.history.length;
    const sites = new Set<string>();
    for (const step of steps) {
      const { url, title } = step.state;
      if (!/^https?:/.test(url)) continue;
      const page = url.split(/[?#]/)[0];
      sites.add(title ? `${page} (${title})` : page);
    }
    return { sites: [...sites].slice(0, 20), outcome: (this.context.finalAnswer ?? '').slice(0, 1500) };
  }

  /**
   * Only the task being worked on: earlier tasks are finished, and handing them over made Jev see
   * their results (e.g. an already-starred repo) as evidence that the new task is DONE.
   */
  private decisionGoal(): string {
    const [task, ...added] = this.tasks.slice(this.goalStart);
    const goal = added.length > 0 ? `${task}\nThe user added: ${added.join(' / ')}` : task;
    if (!this.latestNextSteps) return goal;
    // "[92]" in an older plan now points at some other element; keep the words, drop the numbers
    const plan =
      this.context.nSteps > this.latestPlanStep
        ? this.latestNextSteps.replace(/\s*\((?:index\s*)?\[\d+\]\)|\s*(?:at\s+)?(?:index\s*)?\[\d+\]/gi, '')
        : this.latestNextSteps;
    return `${goal}\nCurrent plan: ${plan}`;
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    let backgroundPlan: BackgroundPlan | null = null;
    const taskStarted = performance.now();
    let outcome = 'unknown';
    this.running = true;
    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // What the user said since the last step: a plan already under way did not know it
        let replan = false;
        if (this.steers.length > 0) {
          await backgroundPlan?.promise.catch(() => null);
          backgroundPlan = null;
          this.takeInSteers();
          navigatorDone = false;
          replan = true;
        }

        // Pick up a periodic plan that finished while the navigator kept going
        let finishToConfirm = false;
        if (backgroundPlan?.settled) {
          latestPlanOutput = await backgroundPlan.promise;
          backgroundPlan = null;
          if (latestPlanOutput?.result?.done) {
            // The plan read the page before the navigator's latest steps. A finish the navigator claims as
            // well stands; otherwise it is checked on the page as it is now, so that the task does not end
            // on something the planner never saw (a file the navigator went on to open, a 404).
            if (navigatorDone && this.steers.length === 0 && this.checkTaskCompletion(latestPlanOutput)) {
              break;
            }
            logger.info('Planner found the task done on an earlier page, checking on the current one');
            finishToConfirm = true;
          }
        }

        if (this.planBeforeNextStep) {
          this.planBeforeNextStep = false;
          await backgroundPlan?.promise.catch(() => null);
          backgroundPlan = null;
          replan = true;
        }

        if (navigatorDone || finishToConfirm || replan || context.nSteps === 0) {
          // The first plan steers the first steps, and a claimed finish needs checking before going on:
          // both wait for the planner
          navigatorDone = false;
          // a plan already under way that also finds the task done confirms the finish without a second call
          const pendingPlan = backgroundPlan ? await backgroundPlan.promise.catch(() => null) : null;
          backgroundPlan = null;
          latestPlanOutput = pendingPlan?.result?.done && !replan ? pendingPlan : await this.runPlanner();
          // a message that came in while the planner was at work is taken in before the task can end
          if (this.steers.length === 0 && this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }
          if (this.steers.length > 0) {
            latestPlanOutput = null;
            continue;
          }
        } else if (context.nSteps % context.options.planningInterval === 0 && !backgroundPlan) {
          // Periodic re-planning runs alongside navigation instead of pausing it for a whole LLM call
          backgroundPlan = await this.startPlanner();
        }

        // Execute navigator
        navigatorDone = await this.navigate();

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // from here on a message from the user starts a task of its own
      this.running = false;

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (isCompleted) {
        await this.applySchedule(latestPlanOutput?.result ?? null);
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        outcome = 'done';
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        outcome = 'failed: max steps reached';
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        outcome = 'cancelled';
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        outcome =
          this.context.consecutiveFailures >= this.context.options.maxFailures
            ? 'stopped: too many failures'
            : 'paused';
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        outcome = 'cancelled';
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outcome = `failed: ${describeError(error)}`;
        logger.error(`❌ Task failed: ${describeError(error)}`, error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      this.running = false;
      logger.info(
        `🏁 Task ${this.context.taskId} ${outcome} after ${context.nSteps} steps in ${Math.round((performance.now() - taskStarted) / 1000)}s`,
      );
      // a plan still in flight would otherwise land in the history of a follow-up task
      await backgroundPlan?.promise.catch(() => null);
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // kept so that the session can go on after this executor is gone
      await chatHistoryStore
        .storeAgentContext(this.context.taskId, JSON.stringify(this.snapshot()))
        .catch(error => logger.error('Failed to store the session context:', error));
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * The planner found that the user wants something done later or repeatedly: store it. When the time
   * cannot be read, the answer asks for it again instead of confirming a schedule that does not exist.
   */
  private async applySchedule(plan: PlannerOutput | null): Promise<void> {
    const when = plan?.schedule?.trim();
    const task = plan?.schedule_task?.trim();
    if (!when || !task) return;
    const repeat = this.allowScheduling ? parseRepeat(when) : null;
    if (!repeat) {
      logger.warning('Could not read the schedule', when);
      this.context.finalAnswer = this.allowScheduling
        ? 'I couldn’t pin down when to run that. When should it happen? For example “every weekday at 9:00” or “in 30 minutes”.'
        : this.context.finalAnswer;
      return;
    }
    try {
      const entry = await scheduleStore.add(task, repeat);
      logger.info('Scheduled', entry.id, describeRepeat(repeat), task);
    } catch (error) {
      logger.error('Failed to store the schedule:', error);
      this.context.finalAnswer = 'I couldn’t save that schedule just now. Please try again in a moment.';
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    return (await this.startPlanner()).promise;
  }

  /**
   * Read the page and start the planner on it. Resolves once the planner has taken its snapshot of the
   * history, so the navigator can go on with the same state while the plan is being made.
   */
  private async startPlanner(): Promise<BackgroundPlan> {
    let positionForPlan = 0;
    let started = performance.now();
    let observeMs = 0;
    let planning: Promise<AgentOutput<PlannerOutput>>;
    try {
      // Add current browser state to memory, on the first step too: a blind first plan
      // misleads the fast engine, and the navigator reuses this same state read
      await this.navigator.addStateMessageToMemory();
      observeMs = Math.round(performance.now() - started);
      positionForPlan = this.context.messageManager.length() - 1;
      started = performance.now();
      // execute() copies the history synchronously, before the navigator changes it
      planning = this.planner.execute();
    } catch (error) {
      planning = Promise.reject(error);
    }
    const planStep = this.context.nSteps;
    const plan: BackgroundPlan = {
      settled: false,
      promise: planning
        .then(planOutput => {
          logger.info(`⏱ planner: observe ${observeMs}ms, plan ${Math.round(performance.now() - started)}ms`);
          if (planOutput.result) {
            this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
            this.latestNextSteps = planOutput.result.next_steps || null;
            this.latestPlanStep = planStep;
          }
          return planOutput;
        })
        .catch(error => this.handlePlannerError(error))
        .finally(() => {
          plan.settled = true;
        }),
    };
    // a rejected plan is rethrown when the loop picks it up
    plan.promise.catch(() => {});
    return plan;
  }

  private handlePlannerError(error: unknown): AgentOutput<PlannerOutput> | null {
    const context = this.context;
    logger.error(`Failed to execute planner: ${describeError(error)}`);
    if (
      error instanceof ChatModelAuthError ||
      error instanceof ChatModelBadRequestError ||
      error instanceof ChatModelForbiddenError ||
      error instanceof URLNotAllowedError ||
      error instanceof ModelTimeoutError ||
      error instanceof RequestCancelledError ||
      error instanceof ExtensionConflictError
    ) {
      throw error;
    }
    context.consecutiveFailures++;
    if (context.consecutiveFailures >= context.options.maxFailures) {
      throw new MaxFailuresReachedError(maxFailuresMessage(error));
    }
    return null;
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      if (navOutput.result?.stuck) {
        // the navigator keeps choosing what it has been told changes nothing: a fresh plan, and the task
        // ends if that does not help either
        this.planBeforeNextStep = true;
        throw new Error('The navigator kept repeating an action that changes nothing on the page');
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${describeError(error)}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof ModelTimeoutError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${describeError(error)}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(maxFailuresMessage(error));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  /** null tells the agent nobody will answer, and it decides for itself */
  answerQuestion(answer: string | null): void {
    this.context.answerQuestion(answer);
  }

  /**
   * The mode the user switched to while this executor lives. Read-only and manual hold from the next action on;
   * leaving read-only does not bring back the actions it dropped until a new executor is set up.
   */
  setActionMode(mode: ActionMode): void {
    this.context.options.actionMode = mode;
  }

  confirmAction(approved: boolean): void {
    this.context.resolveConfirmation(approved);
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
