import type { AgentBrain, ActionResult } from '../types';
import type { BrowserState } from '@src/background/browser/views';
import type { JevTrace } from '@extension/storage';

/** Same shape the LLM navigator produces, so fixActions/doMultiAction/memory stay unchanged. */
export interface NavigatorDecision {
  current_state: AgentBrain;
  action: Record<string, unknown>[];
}

export interface EngineResult {
  /** null defers the step to the LLM navigator */
  decision: NavigatorDecision | null;
  /** what the engine picked and, if deferred, why; shown in the side panel */
  trace?: JevTrace;
}

/**
 * A fast path the navigator consults before calling its LLM.
 * A null decision defers the step to the LLM navigator; so does throwing (except on abort).
 */
export interface NavigatorDecisionEngine {
  readonly name: string;
  decide(state: BrowserState, signal: AbortSignal): Promise<EngineResult>;
  /** Called after every executed step (engine or LLM) so the engine sees the full action history. */
  observeStep(actions: Record<string, unknown>[], results: ActionResult[]): void;
}
