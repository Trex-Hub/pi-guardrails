import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { checkAction, hasNeverLowRiskCommand } from "../../src/core";
import {
  actionKey,
  isSevereBlock,
  pickCard,
  resolveRisk,
} from "../../src/core/away";
import type {
  DelegateOutcome,
  GuardrailsCard,
} from "../../src/core/delegation";
import type { AdvisorRoster } from "../../src/shared/away/advisor";
import {
  type AwayCause,
  type AwayEnv,
  blockWith,
  finishBlock,
  raiseTripwire,
  recordDenial,
  resolveAwayDecision,
} from "../../src/shared/away/engine";
import {
  DEFERRED,
  DENIED_SUFFIX,
  PAUSED_HOLD,
  REPEAT_DENIED,
  REPEAT_QUEUED,
} from "../../src/shared/away/messages";
import {
  effectivePresence,
  getAwayState,
  setPresence,
} from "../../src/shared/away/state";
import type { ResolvedConfig } from "../../src/shared/config";
import type { DelegatedDecision } from "../../src/shared/delegation";
import {
  type DelegateRoster,
  delegateDecision,
} from "../../src/shared/delegation";
import {
  createPromptClosedPayload,
  createPromptOpenedPayload,
  emitRiskDetected,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  type GuardrailsPromptClosedBy,
} from "../../src/shared/events";
import { isCommandAllowed, saveCommandSessionGrant } from "./grants";
import { COMMAND_OPTIONS, commandPark } from "./pi-live";
import {
  createPermissionGateRule,
  formatAutoDenyReason,
  matchCommandPattern,
} from "./rules";
import { isExemptSafeCleanup } from "./safe-cleanup";

type ConfirmResult = "allow" | "allow-session" | "deny" | "stop" | "timeout";

export interface PermissionGateAwayDeps {
  pi: ExtensionAPI;
  delegates: DelegateRoster;
  /** Created on first use so off mode never touches the advisor event. */
  advisors: () => AdvisorRoster;
}

interface ToolCall {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: { command: string } & Record<string, unknown>;
}

async function askUser(
  deps: PermissionGateAwayDeps,
  env: AwayEnv,
  call: ToolCall,
  flag: { reason: string; metadata: unknown },
  card: GuardrailsCard | undefined,
  ctx: ExtensionContext,
  inputGuardMs: number,
): Promise<ConfirmResult> {
  const { pi } = deps;
  const { command } = call.input;
  const timeoutMs = env.away.promptTimeoutMs;
  const action = { kind: "command" as const, command, origin: call.toolName };
  const promptOpened = createPromptOpenedPayload({
    feature: "permissionGate",
    action,
    reason: flag.reason,
    prompt: { kind: "permission", metadata: flag.metadata },
    context: { toolName: call.toolName, input: call.input },
  });
  pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);

  const deadline = Date.now() + timeoutMs;
  const parked = commandPark({
    events: pi.events,
    id: promptOpened.prompt.id,
    toolCallId: call.toolCallId,
    parentToolCallId: call.parentToolCallId,
    toolName: call.toolName,
    command,
    reason: flag.reason,
    signal: ctx.signal,
    inputGuardMs,
    timeoutMs,
    card,
  });
  let result: ConfirmResult;
  let by: GuardrailsPromptClosedBy | undefined;
  try {
    const customResult = await ctx.ui.custom<ConfirmResult>(parked.factory, {
      blocked: { kind: "permission", message: "Guardrails approval required" },
    });

    if (customResult === undefined) {
      const indentedCommand = command.replace(/^/gm, "    ");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        Math.max(0, deadline - Date.now()),
      );
      let selection: string | undefined;
      try {
        selection = await ctx.ui.select(
          `Dangerous command: ${flag.reason}\n\n${indentedCommand}`,
          COMMAND_OPTIONS.map((option) => option.label),
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
      if (selection === undefined && timedOut) {
        result = "timeout";
        by = "timeout";
      } else {
        result =
          COMMAND_OPTIONS.find((option) => option.label === selection)
            ?.result ?? "deny";
        by = selection === undefined ? "abort" : "keyboard";
      }
    } else {
      result = customResult;
      const closedBy = parked.closedBy();
      by = closedBy === "shutdown" ? undefined : closedBy;
    }
  } finally {
    parked.dispose();
    pi.events.emit(
      GUARDRAILS_PROMPT_CLOSED_EVENT,
      createPromptClosedPayload(promptOpened, by),
    );
  }
  if (by === "client") {
    setPresence(pi, env.state, "present", "client");
  }
  return result;
}

function delegationMetadata(
  flagMetadata: unknown,
  delegated: DelegatedDecision,
) {
  return { risk: flagMetadata, delegation: delegated };
}

/**
 * The permission gate with away mode on (`away.mode !== "off"`). The off path
 * lives in index.ts and never reaches this file.
 */
export async function handleAwayToolCall(
  deps: PermissionGateAwayDeps,
  call: ToolCall,
  ctx: ExtensionContext,
  config: ResolvedConfig,
): Promise<ToolCallEventResult | undefined> {
  const { pi } = deps;
  const away = config.away;
  const state = getAwayState(ctx.sessionManager.getSessionId(), away);
  const { command } = call.input;
  const action = { kind: "command" as const, command, origin: call.toolName };
  const key = actionKey(action);
  const env: AwayEnv = {
    pi,
    ctx,
    away,
    delegationTimeoutMs: config.delegation.timeoutMs,
    state,
    advisors: deps.advisors,
    feature: "permissionGate",
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input,
  };
  const standing = away.standingPermissions;
  const standingExtra =
    standing.length > 0 ? { standingPermissions: standing } : {};

  // 1. Paused.
  if (state.paused) {
    return blockWith(env, action, PAUSED_HOLD, "paused", { terminate: true });
  }
  // 2. Once-grant.
  if (state.onceGrants.delete(key)) return;
  // 3. Allowed by pattern.
  if (isCommandAllowed(command)) return;

  const presence = () => effectivePresence(away, ctx);
  const denial = async (
    reason: string,
    source: "delegate" | "permission",
    extra: { metadata?: unknown; terminate?: boolean } = {},
  ): Promise<ToolCallEventResult> => {
    const signal = recordDenial(env, action, reason, presence() === "away");
    const finished = await finishBlock(env, reason, signal);
    return blockWith(env, action, finished.reason, source, {
      metadata: extra.metadata,
      terminate: extra.terminate || finished.terminate === true,
    });
  };

  // 4. Auto-deny.
  const autoDenyMatch = matchCommandPattern(
    command,
    config.permissionGate.autoDenyPatterns,
  );
  if (autoDenyMatch) {
    return denial(formatAutoDenyReason(autoDenyMatch), "permission", {
      metadata: autoDenyMatch,
      terminate: autoDenyMatch.terminate === true,
    });
  }

  const delegatedDenial = async (
    delegated: DelegatedDecision,
    flagMetadata: unknown,
    flaggedReason: string,
  ): Promise<ToolCallEventResult> => {
    if (isSevereBlock(delegated.outcomes)) {
      const out = await raiseTripwire(env, {
        action,
        flaggedReason,
        reason: delegated.reason,
        outcomes: delegated.outcomes,
        whileAway: presence() === "away",
      });
      return blockWith(env, action, out.reason, "delegate", {
        metadata: delegationMetadata(flagMetadata, delegated),
        terminate: true,
      });
    }
    return denial(
      `Blocked by decision delegate: ${delegated.reason} ${DENIED_SUFFIX}`,
      "delegate",
      { metadata: delegationMetadata(flagMetadata, delegated) },
    );
  };

  // 5. Watch window for unflagged commands.
  const safety = await checkAction(action, [
    createPermissionGateRule({
      patterns: config.permissionGate.patterns,
      useBuiltinMatchers: config.permissionGate.useBuiltinMatchers,
    }),
  ]);
  if (
    safety.kind === "safe" ||
    isExemptSafeCleanup(config.permissionGate, command, ctx.cwd)
  ) {
    if (state.watchRemaining <= 0) return;
    state.watchRemaining -= 1;
    const watched = await delegateDecision(
      pi,
      deps.delegates,
      {
        feature: "permissionGate",
        action,
        reason: "follow-up check after a block",
        toolName: call.toolName,
        input: call.input,
        watch: { blocked: [...state.blocked] },
        ...standingExtra,
      },
      ctx,
      { timeoutMs: config.delegation.timeoutMs, watchOnly: true },
    );
    if (watched?.verdict !== "block") return;
    return delegatedDenial(watched, undefined, "follow-up check after a block");
  }

  // 6. Flagged: the watch window also covers flagged commands.
  let watch: { blocked: typeof state.blocked } | undefined;
  if (state.watchRemaining > 0) {
    state.watchRemaining -= 1;
    watch = { blocked: [...state.blocked] };
  }

  // 7. Risk event, warn-only mode.
  emitRiskDetected(pi, {
    feature: "permissionGate",
    risk: safety,
    context: { toolName: call.toolName, input: call.input },
  });
  if (!config.permissionGate.requireConfirmation) {
    ctx.ui.notify(`Dangerous command detected: ${safety.reason}`, "warning");
    return;
  }

  // 8. Repeat of something already deferred or denied.
  if (presence() === "away") {
    const seen = state.memory.get(key);
    if (seen) {
      state.watchRemaining = away.watchCommands;
      const signal = state.ladder.recordBlock("repeat");
      const base = seen.outcome === "deferred" ? REPEAT_QUEUED : REPEAT_DENIED;
      const finished = await finishBlock(env, base, signal);
      return blockWith(env, safety.action, finished.reason, "repeat", {
        metadata: safety.metadata,
        terminate: finished.terminate === true,
      });
    }
  }

  // 9. Delegates.
  const delegated = await delegateDecision(
    pi,
    deps.delegates,
    {
      feature: "permissionGate",
      action: safety.action,
      reason: safety.reason,
      metadata: safety.metadata,
      toolName: call.toolName,
      input: call.input,
      ...(watch ? { watch } : {}),
      ...standingExtra,
    },
    ctx,
    { timeoutMs: config.delegation.timeoutMs },
  );
  if (delegated?.verdict === "allow") {
    state.memory.delete(key);
    return;
  }
  if (delegated?.verdict === "block") {
    return delegatedDenial(delegated, safety.metadata, safety.reason);
  }

  // 10. Unsure.
  const outcomes: readonly DelegateOutcome[] = delegated?.outcomes ?? [];
  const risk = resolveRisk(outcomes, hasNeverLowRiskCommand(command));
  let cause: AwayCause = ctx.hasUI ? "away" : "headless";
  if (presence() === "present") {
    const result = await askUser(
      deps,
      env,
      call,
      { reason: safety.reason, metadata: safety.metadata },
      pickCard(outcomes),
      ctx,
      config.prompts.inputGuardMs,
    );
    if (result === "allow") {
      state.memory.delete(key);
      return;
    }
    if (result === "allow-session") {
      await saveCommandSessionGrant(command);
      state.memory.delete(key);
      return;
    }
    if (result === "stop" || result === "deny") {
      const reason =
        result === "stop"
          ? "User declined and stopped dangerous command"
          : "User denied dangerous command";
      recordDenial(env, safety.action, reason, false);
      if (result === "stop") ctx.abort();
      return blockWith(
        env,
        safety.action,
        reason,
        result === "stop" ? "user-stop" : "user",
        {
          metadata: safety.metadata,
        },
      );
    }
    // The prompt timed out: the user is away from now on.
    setPresence(pi, state, "away", "timeout");
    cause = "timeout";
  }

  // 11. Away rules.
  const decision = await resolveAwayDecision(env, {
    action: safety.action,
    flaggedReason: safety.reason,
    outcomes,
    reason: delegated?.reason ?? "",
    risk,
    cause,
  });
  if (decision.kind === "allow") return;

  const signal = state.ladder.recordBlock("block");
  const finished = await finishBlock(env, DEFERRED, signal);
  return blockWith(env, safety.action, finished.reason, "deferred", {
    metadata: safety.metadata,
    terminate: finished.terminate === true,
  });
}
