import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AwayLadder } from "../../core/away";
import type { Action } from "../../core/types";
import type { AwayMode, ResolvedConfig } from "../config/types";
import {
  emitAwayPaused,
  emitPresenceChanged,
  type GuardrailsFeatureId,
  type GuardrailsPresenceCause,
} from "../events";
import type { BlockedAction } from "./types";

export type { BlockedAction } from "./types";

export type Presence = "present" | "away";

export const MAX_BLOCKED_ACTIONS = 20;

export interface AwayState {
  sessionId: string;
  /** Last mode seen by `getAwayState`. Only `"always"` matters here. */
  mode: AwayMode;
  presence: Presence;
  paused?: { reason: string; since: string };
  ladder: AwayLadder;
  /** Commands left in the watch window. */
  watchRemaining: number;
  /** This session's blocked actions, newest last, capped at 20. */
  blocked: BlockedAction[];
  /** actionKey -> what happened to it. */
  memory: Map<string, { outcome: "deferred" | "denied"; itemId?: string }>;
  /** actionKey of actions the user approved once. */
  onceGrants: Set<string>;
  /** Ids of inbox items this session wrote. */
  ownItemIds: Set<string>;
}

const STATE_KEY = Symbol.for("@aliou/pi-guardrails/away@1");

type AwayConfigView = ResolvedConfig["away"];

function freshState(sessionId: string): AwayState {
  return {
    sessionId,
    mode: "off",
    presence: "present",
    ladder: new AwayLadder({ stuckBlocks: 3, maxBlocks: 50 }),
    watchRemaining: 0,
    blocked: [],
    memory: new Map(),
    onceGrants: new Set(),
    ownItemIds: new Set(),
  };
}

/**
 * The away state of the current session, shared by every Guardrails extension
 * through `globalThis`. A different session id replaces the stored state. When
 * `config` is given, the mode and ladder limits are refreshed from it.
 */
export function getAwayState(
  sessionId: string,
  config?: Pick<AwayConfigView, "mode" | "stuckBlocks" | "maxBlocks">,
): AwayState {
  const store = globalThis as typeof globalThis & {
    [STATE_KEY]?: AwayState;
  };
  if (store[STATE_KEY]?.sessionId !== sessionId) {
    store[STATE_KEY] = freshState(sessionId);
  }
  const state = store[STATE_KEY] as AwayState;
  if (config) {
    state.mode = config.mode;
    state.ladder.configure({
      stuckBlocks: config.stuckBlocks,
      maxBlocks: config.maxBlocks,
    });
  }
  return state;
}

/** Drops the stored state (session shutdown, tests). */
export function clearAwayState(): void {
  const store = globalThis as typeof globalThis & {
    [STATE_KEY]?: AwayState;
  };
  delete store[STATE_KEY];
}

/**
 * Whether the user counts as present or away right now.
 * off: always present. always: always away. auto: away without a UI, otherwise
 * whatever the session tracked.
 */
export function effectivePresence(
  config: Pick<AwayConfigView, "mode" | "stuckBlocks" | "maxBlocks">,
  ctx: {
    hasUI: boolean;
    sessionManager: { getSessionId(): string };
  },
): Presence {
  if (config.mode === "off") return "present";
  if (config.mode === "always") return "away";
  if (!ctx.hasUI) return "away";
  return getAwayState(ctx.sessionManager.getSessionId(), config).presence;
}

/**
 * Changes presence. No-op when unchanged, and in `"always"` mode never goes to
 * present. Going present resets the ladder and clears a pause.
 */
export function setPresence(
  pi: ExtensionAPI,
  state: AwayState,
  presence: Presence,
  cause: GuardrailsPresenceCause,
): void {
  if (state.presence === presence) return;
  if (presence === "present" && state.mode === "always") return;
  state.presence = presence;
  emitPresenceChanged(pi, presence, cause);
  if (presence === "present") {
    state.ladder.reset();
    state.paused = undefined;
    emitAwayPaused(pi, false);
  }
}

/** Pauses the run and tells listeners. */
export function pauseRun(
  pi: ExtensionAPI,
  state: AwayState,
  reason: string,
): void {
  state.paused = { reason, since: new Date().toISOString() };
  emitAwayPaused(pi, true, reason);
}

/** Clears a pause and tells listeners. No-op when not paused. */
export function resumeRun(pi: ExtensionAPI, state: AwayState): void {
  if (!state.paused) return;
  state.paused = undefined;
  emitAwayPaused(pi, false);
}

/** Adds to `state.blocked`, keeping the newest 20. */
export function recordBlockedAction(
  state: AwayState,
  entry: {
    feature: GuardrailsFeatureId;
    toolName: string;
    action: Action;
    outcome: "deferred" | "denied";
    reason: string;
  },
): BlockedAction {
  const blocked: BlockedAction = { ...entry, at: new Date().toISOString() };
  state.blocked.push(blocked);
  if (state.blocked.length > MAX_BLOCKED_ACTIONS) {
    state.blocked.splice(0, state.blocked.length - MAX_BLOCKED_ACTIONS);
  }
  return blocked;
}
