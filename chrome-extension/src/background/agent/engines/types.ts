import type { AgentBrain, ActionResult } from '../types';
import type { BrowserState } from '@src/background/browser/views';

/** Same shape the LLM navigator produces, so fixActions/doMultiAction/memory stay unchanged. */
export interface NavigatorDecision {
  current_state: AgentBrain;
  action: Record<string, unknown>[];
}

/**
 * A fast path the navigator consults before calling its LLM.
 * Returning null defers the step to the LLM navigator; so does throwing (except on abort).
 */
export interface NavigatorDecisionEngine {
  readonly name: string;
  decide(state: BrowserState, signal: AbortSignal): Promise<NavigatorDecision | null>;
  /** Called after every executed step (engine or LLM) so the engine sees the full action history. */
  observeStep(actions: Record<string, unknown>[], results: ActionResult[]): void;
}
