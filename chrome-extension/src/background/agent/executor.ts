import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import { splitUserTextAndAttachments } from './messages/utils';
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
import type { GeneralSettingsConfig } from '@extension/storage';
import { analytics } from '../services/analytics';
import { JevDecisionEngine } from './engines/jev';

const logger = createLogger('Executor');

/** A planner run going on alongside navigation */
interface BackgroundPlan {
  promise: Promise<AgentOutput<PlannerOutput> | null>;
  settled: boolean;
}

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  /** what is remembered about the user from earlier conversations */
  memoryContext?: string;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  /** how many of the tasks have already been read for things to remember */
  private tasksRemembered = 0;
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
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    if (this.generalSettings?.fastMode && this.generalSettings.fastModeApiKey) {
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
    // Initialize message history
    this.context.messageManager.initTaskMessages(
      this.navigatorPrompt.getSystemMessage(),
      task,
      extraArgs?.memoryContext,
    );
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    // the plan belonged to the previous task
    this.latestNextSteps = null;
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /** What the user wrote since the last call, without attachments: only their own words go into memory */
  takeUserMessagesToRemember(): string[] {
    const messages = this.tasks.slice(this.tasksRemembered).map(task => splitUserTextAndAttachments(task).userText);
    this.tasksRemembered = this.tasks.length;
    return messages;
  }

  /**
   * Only the task being worked on: earlier tasks are finished, and handing them over made Jev see
   * their results (e.g. an already-starred repo) as evidence that the new task is DONE.
   */
  private decisionGoal(): string {
    const goal = this.tasks[this.tasks.length - 1];
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

        // Pick up a periodic plan that finished while the navigator kept going
        if (backgroundPlan?.settled) {
          latestPlanOutput = await backgroundPlan.promise;
          backgroundPlan = null;
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }
        }

        if (navigatorDone || context.nSteps === 0) {
          // The first plan steers the first steps, and a claimed finish needs checking before going on:
          // both wait for the planner
          navigatorDone = false;
          if (backgroundPlan) await backgroundPlan.promise.catch(() => null);
          backgroundPlan = null;
          latestPlanOutput = await this.runPlanner();
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
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

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      // a plan still in flight would otherwise land in the history of a follow-up task
      await backgroundPlan?.promise.catch(() => null);
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
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
    logger.error(`Failed to execute planner: ${error}`);
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
      throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
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
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
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
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
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
