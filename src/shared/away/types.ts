import type { Action } from "../../core/types";
import type { DelegationContext } from "../delegation/types";
import type { GuardrailsFeatureId } from "../events";

/** An action Guardrails stopped, kept for the watch window, advisors and cards. */
export interface BlockedAction {
  feature: GuardrailsFeatureId;
  toolName: string;
  action: Action;
  outcome: "deferred" | "denied";
  reason: string;
  /** ISO timestamp. */
  at: string;
}

export interface AdvisorSituation {
  reason: "stuck";
  /** Newest last, at most 20. */
  blocked: BlockedAction[];
  blocksSinceAway: number;
  standingPermissions: string[];
}

export type AdvisorAnswer =
  | { action: "advise"; message: string }
  | { action: "pause"; reason: string };

/**
 * Advisors are asked what to do when a run is stuck. They can advise the agent
 * or pause the run. They can never allow an action.
 */
export interface GuardrailsAdvisor {
  id: string;
  name: string;
  isEnabled?(): boolean;
  advise(
    situation: AdvisorSituation,
    context: DelegationContext,
  ): AdvisorAnswer | undefined | Promise<AdvisorAnswer | undefined>;
}

export interface AdvisorRegisterPayload {
  advisor: GuardrailsAdvisor;
}
