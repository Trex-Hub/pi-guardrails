import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { actionKey, type LadderSignal, pickCard } from "../../core/away";
import type { DelegateOutcome, Risk } from "../../core/delegation";
import type { Action } from "../../core/types";
import type { ResolvedConfig } from "../config/types";
import {
  emitActionBlocked,
  emitTripwire,
  type GuardrailsBlockSource,
  type GuardrailsFeatureId,
} from "../events";
import type { AdvisorRoster } from "./advisor";
import { runAdvisors } from "./advisor";
import { type InboxItem, publishItem } from "./inbox";
import { advice, NUDGE, paused, pausedWhy, withSuffix } from "./messages";
import { type AwayState, pauseRun, recordBlockedAction } from "./state";

export type AwayCtx = Pick<
  ExtensionContext,
  "cwd" | "sessionManager" | "modelRegistry" | "signal" | "hasUI"
> &
  Partial<Pick<ExtensionContext, "mode" | "ui">>;

/** What every away-mode helper needs to know about the call being judged. */
export interface AwayEnv {
  pi: ExtensionAPI;
  ctx: AwayCtx;
  away: ResolvedConfig["away"];
  delegationTimeoutMs: number;
  state: AwayState;
  /** Lazy, so off mode never creates the advisor roster (it emits an event). */
  advisors: () => AdvisorRoster;
  feature: GuardrailsFeatureId;
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface AwayBlock {
  block: true;
  reason: string;
  terminate?: true;
}

export type AwayCause = "away" | "timeout" | "headless";

/** Emits `guardrails:action:blocked` and builds the hook result. */
export function blockWith(
  env: AwayEnv,
  action: Action,
  reason: string,
  source: GuardrailsBlockSource,
  options: { metadata?: unknown; terminate?: boolean } = {},
): AwayBlock {
  emitActionBlocked(env.pi, {
    feature: env.feature,
    action,
    reason,
    block: { source, metadata: options.metadata },
    context: { toolName: env.toolName, input: env.input },
  });
  return {
    block: true,
    reason,
    ...(options.terminate ? { terminate: true as const } : {}),
  };
}

/** Pauses the run and returns the PAUSED block reason for `why`. */
export function pauseWith(env: AwayEnv, why: string): string {
  pauseRun(env.pi, env.state, why);
  return paused(why);
}

function makeItem(
  env: AwayEnv,
  fields: Pick<InboxItem, "kind" | "cause" | "action" | "flaggedReason"> &
    Partial<Pick<InboxItem, "reason" | "risk" | "card">>,
): InboxItem {
  const { sessionManager } = env.ctx;
  const file = sessionManager.getSessionFile();
  const name = sessionManager.getSessionName();
  const card = fields.card;
  return {
    version: 1,
    id: randomUUID(),
    kind: fields.kind,
    cause: fields.cause,
    createdAt: new Date().toISOString(),
    session: {
      id: sessionManager.getSessionId(),
      ...(file ? { file } : {}),
      ...(name ? { name } : {}),
      cwd: sessionManager.getCwd() || env.ctx.cwd,
    },
    feature: env.feature,
    toolName: env.toolName,
    toolCallId: env.toolCallId,
    action: fields.action,
    flaggedReason: fields.flaggedReason,
    reason: fields.reason ?? "",
    risk: fields.risk ?? "high",
    ...(card ? { card } : {}),
  };
}

async function publish(env: AwayEnv, item: InboxItem): Promise<void> {
  env.state.ownItemIds.add(item.id);
  await publishItem(env.pi, item);
}

/**
 * Records a denial (delegate or user). Always adds to the blocked list and
 * refills the watch window. While away it also remembers the action and counts
 * toward the ladder; the returned signal must go to `finishBlock`.
 */
export function recordDenial(
  env: AwayEnv,
  action: Action,
  reason: string,
  whileAway: boolean,
): LadderSignal {
  const { state } = env;
  recordBlockedAction(state, {
    feature: env.feature,
    toolName: env.toolName,
    action,
    outcome: "denied",
    reason,
  });
  state.watchRemaining = env.away.watchCommands;
  if (!whileAway) return "none";
  state.memory.set(actionKey(action), { outcome: "denied" });
  return state.ladder.recordBlock("block");
}

/**
 * Applies a ladder signal to a block reason: advisors on "stuck", pause on
 * "stuck-again" and "limit". Pausing replaces the reason and terminates.
 */
export async function finishBlock(
  env: AwayEnv,
  baseReason: string,
  signal: LadderSignal,
): Promise<{ reason: string; terminate?: true }> {
  const { state, away } = env;
  switch (signal) {
    case "none":
      return { reason: baseReason };
    case "limit":
      return {
        reason: pauseWith(env, pausedWhy.limit(away.maxBlocks)),
        terminate: true,
      };
    case "stuck-again":
      return { reason: pauseWith(env, pausedWhy.stuck()), terminate: true };
    case "stuck": {
      const answer = await runAdvisors(
        env.advisors().list(),
        {
          reason: "stuck",
          blocked: [...state.blocked],
          blocksSinceAway: state.ladder.blocksSinceAway,
          standingPermissions: away.standingPermissions,
        },
        {
          cwd: env.ctx.cwd,
          sessionManager: env.ctx.sessionManager,
          modelRegistry: env.ctx.modelRegistry,
        },
        { timeoutMs: env.delegationTimeoutMs, signal: env.ctx.signal },
      );
      if (answer?.action === "pause") {
        return {
          reason: pauseWith(env, pausedWhy.advisor(answer.reason)),
          terminate: true,
        };
      }
      if (answer?.action === "advise") {
        return { reason: withSuffix(baseReason, advice(answer.message)) };
      }
      return { reason: withSuffix(baseReason, NUDGE) };
    }
  }
}

/**
 * The away rules for one action both reviewers were unsure about. Low risk and
 * `lowRisk: "allow"`: write an `allowed` item and let it run. Otherwise write a
 * `waiting` item, remember the action as deferred and add it to the blocked
 * list. The caller counts the ladder (once per call) and builds the block.
 */
export async function resolveAwayDecision(
  env: AwayEnv,
  params: {
    action: Action;
    flaggedReason: string;
    outcomes: readonly DelegateOutcome[];
    reason: string;
    risk: Risk;
    cause: AwayCause;
  },
): Promise<{ kind: "allow" } | { kind: "defer"; item: InboxItem }> {
  const { state, away } = env;
  const card = pickCard(params.outcomes);
  const common = {
    cause: params.cause,
    action: params.action,
    flaggedReason: params.flaggedReason,
    reason: params.reason,
    risk: params.risk,
    card,
  };
  if (params.risk === "low" && away.lowRisk === "allow") {
    await publish(env, makeItem(env, { ...common, kind: "allowed" }));
    state.memory.delete(actionKey(params.action));
    return { kind: "allow" };
  }

  const item = makeItem(env, { ...common, kind: "waiting" });
  await publish(env, item);
  state.memory.set(actionKey(params.action), {
    outcome: "deferred",
    itemId: item.id,
  });
  recordBlockedAction(state, {
    feature: env.feature,
    toolName: env.toolName,
    action: params.action,
    outcome: "deferred",
    reason: params.flaggedReason,
  });
  state.watchRemaining = away.watchCommands;
  return { kind: "defer", item };
}

/**
 * A severe block: write an urgent item, emit the tripwire, pause the run and
 * end the turn. Applies whether the user is present or away.
 */
export async function raiseTripwire(
  env: AwayEnv,
  params: {
    action: Action;
    flaggedReason: string;
    reason: string;
    outcomes: readonly DelegateOutcome[];
    whileAway: boolean;
  },
): Promise<{ reason: string; terminate: true }> {
  const item = makeItem(env, {
    kind: "urgent",
    cause: "tripwire",
    action: params.action,
    flaggedReason: params.flaggedReason,
    reason: params.reason,
    risk: "high",
    card: pickCard(params.outcomes),
  });
  await publish(env, item);
  emitTripwire(env.pi, item);

  const { state } = env;
  recordBlockedAction(state, {
    feature: env.feature,
    toolName: env.toolName,
    action: params.action,
    outcome: "denied",
    reason: params.reason,
  });
  state.watchRemaining = env.away.watchCommands;
  if (params.whileAway) {
    state.memory.set(actionKey(params.action), { outcome: "denied" });
  }
  return {
    reason: pauseWith(env, pausedWhy.severe(params.reason)),
    terminate: true,
  };
}
