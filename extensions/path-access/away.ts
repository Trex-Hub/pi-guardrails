import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { checkAction, type Safety } from "../../src/core";
import {
  actionKey,
  hasHighRiskAllow,
  isSevereBlock,
  pickCard,
  resolveRisk,
} from "../../src/core/away";
import type {
  DelegateOutcome,
  GuardrailsCard,
} from "../../src/core/delegation";
import {
  type AllowedPath,
  normalizeForDisplay,
  type PathAccessState,
  resolveFromCwd,
} from "../../src/core/paths";
import type { AdvisorRoster } from "../../src/shared/away/advisor";
import {
  type AwayDecisionParams,
  type AwayEnv,
  blockWith,
  finishBlock,
  raiseTripwire,
  recordDenial,
  recordHighRiskAllow,
  resolveAwayDecisions,
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
import { configLoader } from "../../src/shared/config";
import {
  type DelegatedDecision,
  type DelegateRoster,
  delegateDecision,
} from "../../src/shared/delegation";
import {
  createPromptClosedPayload,
  createPromptOpenedPayload,
  emitActionBlocked,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  type GuardrailsPromptClosedBy,
} from "../../src/shared/events";
import {
  compilePolicies,
  createPolicyRules,
} from "../../src/shared/policy-rules";
import {
  createPendingGrant,
  isGrantTooBroad,
  type PendingPathGrant,
  pendingAllowedPaths,
  persistGrant,
  resolveAllowedPaths,
} from "./grants";
import { pathPark } from "./pi-live";
import {
  createPathAccessPromptComponent,
  type PromptResult,
  promptOptions,
} from "./prompt";
import { createPathAccessRule, type PathAccessMeta } from "./rules";
import { isReadOnlyTool, targetsForTool } from "./targets";

type FlaggedSafety = Extract<Safety<PathAccessMeta>, { kind: "dangerous" }>;
type AskResult = PromptResult | "timeout";

/** Tools path-access looks at; a paused run holds all of them. */
const HANDLED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
]);

export interface PathAccessAwayDeps {
  pi: ExtensionAPI;
  delegates: DelegateRoster;
  advisors: () => AdvisorRoster;
  /** Pi docs and skill paths that are always allowed. */
  extraAllowedPaths: () => AllowedPath[];
}

interface ToolCall {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: Record<string, unknown>;
}

function withRealpath(dir: string): string[] {
  try {
    return [dir, realpathSync(dir)];
  } catch {
    return [dir];
  }
}

let tempRoots: string[] | undefined;

/** Temp roots in both spellings (macOS /var → /private/var), computed once. */
function getTempRoots(): string[] {
  tempRoots ??= [
    ...new Set(
      [tmpdir(), "/tmp", "/private/tmp"].flatMap((dir) => withRealpath(dir)),
    ),
  ];
  return tempRoots;
}

/** Test hook: forget the cached temp roots. */
export function resetTempRoots(): void {
  tempRoots = undefined;
}

function isStrictlyInsideTemp(absolutePath: string): boolean {
  const target = resolve(absolutePath);
  return getTempRoots().some((dir) => {
    const root = resolve(dir);
    return (
      target !== root &&
      target.startsWith(root.endsWith(sep) ? root : root + sep)
    );
  });
}

/**
 * Paths that can never be treated as low risk: writes outside a temp dir (a
 * command can write too) and anything a policy rule protects.
 */
async function pathFloor(
  toolName: string,
  absolutePath: string,
  policyRules: ReturnType<typeof createPolicyRules>,
): Promise<boolean> {
  if (!isReadOnlyTool(toolName) && !isStrictlyInsideTemp(absolutePath)) {
    return true;
  }
  const policy = await checkAction(
    { kind: "file", path: absolutePath, origin: toolName },
    policyRules,
  );
  return policy.kind !== "safe";
}

function pausedAction(call: ToolCall, cwd: string) {
  if (call.toolName === "bash" || call.toolName === "powershell") {
    return {
      kind: "command" as const,
      command: String(call.input.command ?? ""),
      origin: call.toolName,
    };
  }
  const raw = String(call.input.file_path ?? call.input.path ?? "").trim();
  return {
    kind: "file" as const,
    path: resolveFromCwd(raw || ".", cwd),
    origin: call.toolName,
  };
}

async function askUser(
  deps: PathAccessAwayDeps,
  env: AwayEnv,
  call: ToolCall,
  flagged: { absolutePath: string; safety: FlaggedSafety },
  card: GuardrailsCard | undefined,
  ctx: ExtensionContext,
  config: ResolvedConfig,
  acceptedGrants: PendingPathGrant[],
): Promise<AskResult> {
  const { pi } = deps;
  const { absolutePath, safety } = flagged;
  const shellCommand =
    call.toolName === "bash" || call.toolName === "powershell"
      ? String(call.input.command ?? "")
      : undefined;
  const parentDir = dirname(absolutePath);
  const showFileOptions = call.toolName !== "ls" && call.toolName !== "find";
  const dirPath = showFileOptions ? parentDir : absolutePath;
  const dirGrantable = !isGrantTooBroad(dirPath);
  const alwaysEnabled =
    config.pathAccess.alwaysScope === "global" ||
    configLoader.getProjectState() === "trusted";
  const timeoutMs = env.away.promptTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const promptOpened = createPromptOpenedPayload({
    feature: "pathAccess",
    action: safety.action,
    reason: safety.reason,
    prompt: { kind: "confirmation", metadata: safety.metadata },
    context: { toolName: call.toolName, input: call.input },
  });
  pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);

  const parked = pathPark({
    events: pi.events,
    id: promptOpened.prompt.id,
    toolCallId: call.toolCallId,
    parentToolCallId: call.parentToolCallId,
    toolName: call.toolName,
    path: absolutePath,
    displayPath: safety.metadata.displayPath,
    directory: dirPath,
    cwd: ctx.cwd,
    command: shellCommand,
    reason: safety.reason,
    alwaysScope: config.pathAccess.alwaysScope,
    showFileOptions,
    dirGrantable,
    alwaysEnabled,
    signal: ctx.signal,
    timeoutMs,
    card,
    component: createPathAccessPromptComponent(
      call.toolName,
      safety.metadata.displayPath,
      normalizeForDisplay(parentDir, ctx.cwd),
      ctx.cwd,
      showFileOptions,
      {
        command: shellCommand,
        dirGrantable,
        alwaysEnabled,
        inputGuardMs: config.prompts.inputGuardMs,
        expiresAt: deadline,
        card,
      },
    ),
  });

  let result: AskResult;
  let by: GuardrailsPromptClosedBy | undefined;
  try {
    const customResult = await ctx.ui.custom<AskResult>(parked.factory, {
      blocked: { kind: "permission", message: "Guardrails approval required" },
    });
    if (customResult === undefined) {
      // RPC mode: plain select with the same options and a deadline.
      const options = promptOptions(
        showFileOptions,
        dirGrantable,
        alwaysEnabled,
      ).filter((option) => !option.disabled);
      if (!alwaysEnabled) {
        ctx.ui.notify(
          '"Always" grants are saved in this project\'s settings, which are ignored because this folder is not trusted. Use /trust and restart Pi to enable them.',
          "warning",
        );
      }
      const dirNote = showFileOptions
        ? "\nDirectory grants apply to the parent directory."
        : "";
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
          `Allow access to ${safety.metadata.displayPath}? (outside ${ctx.cwd})${dirNote}`,
          options.map((option) => option.label),
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
          options.find((option) => option.label === selection)?.result ??
          "deny";
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

  if (result === "allow-file-session" || result === "allow-file-always") {
    const grant = createPendingGrant(
      absolutePath,
      false,
      result === "allow-file-session"
        ? "memory"
        : config.pathAccess.alwaysScope,
    );
    acceptedGrants.push(grant);
    await persistGrant(grant);
  }
  if (result === "allow-dir-session" || result === "allow-dir-always") {
    if (isGrantTooBroad(dirPath)) {
      ctx.ui.notify(
        `Cannot grant access to ${normalizeForDisplay(dirPath, ctx.cwd)}/ — too broad. Treating as allow once.`,
        "warning",
      );
    } else {
      const grant = createPendingGrant(
        dirPath,
        true,
        result === "allow-dir-session"
          ? "memory"
          : config.pathAccess.alwaysScope,
      );
      acceptedGrants.push(grant);
      await persistGrant(grant);
    }
  }
  return result;
}

/**
 * The path-access gate with away mode on (`away.mode !== "off"`). The off path
 * lives in index.ts and never reaches this file.
 */
export async function handleAwayToolCall(
  deps: PathAccessAwayDeps,
  call: ToolCall,
  ctx: ExtensionContext,
  config: ResolvedConfig,
): Promise<ToolCallEventResult | undefined> {
  const { pi } = deps;
  const away = config.away;
  const state = getAwayState(ctx.sessionManager.getSessionId(), away);
  const env: AwayEnv = {
    pi,
    ctx,
    away,
    delegationTimeoutMs: config.delegation.timeoutMs,
    state,
    advisors: deps.advisors,
    feature: "pathAccess",
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input,
  };

  // Paused: hold every tool path-access handles.
  if (state.paused && HANDLED_TOOLS.has(call.toolName)) {
    return blockWith(env, pausedAction(call, ctx.cwd), PAUSED_HOLD, "paused", {
      terminate: true,
    });
  }

  if (config.pathAccess.mode === "allow") return;
  if (config.pathAccess.applyTo === "write" && isReadOnlyTool(call.toolName)) {
    return;
  }

  const matched = await targetsForTool(
    call.toolName,
    call.input,
    ctx.cwd,
    pi.exec,
  );
  const targets = [...new Set(matched)];

  // A path the user approved once counts as safe for this call; the grant is
  // consumed when the call proceeds.
  const onceKeys: string[] = [];
  const toCheck: string[] = [];
  for (const absolutePath of targets) {
    const key = actionKey({
      kind: "file",
      path: absolutePath,
      origin: call.toolName,
    });
    if (state.onceGrants.has(key)) onceKeys.push(key);
    else toCheck.push(absolutePath);
  }
  const proceed = () => {
    for (const key of onceKeys) state.onceGrants.delete(key);
    return undefined;
  };

  const acceptedGrants: PendingPathGrant[] = [];
  const checkTarget = (absolutePath: string) => {
    const pathState: PathAccessState = {
      cwd: ctx.cwd,
      mode: config.pathAccess.mode,
      allowedPaths: [
        ...resolveAllowedPaths(config.pathAccess.allowedPaths, ctx.cwd),
        ...deps.extraAllowedPaths(),
        ...pendingAllowedPaths(acceptedGrants),
      ],
      // No UI is handled by the away rules, not by a blanket block.
      hasUI: true,
    };
    return checkAction(
      { kind: "file", path: absolutePath, origin: call.toolName },
      [createPathAccessRule(pathState)],
    );
  };

  const flagged: { absolutePath: string; safety: FlaggedSafety }[] = [];
  for (const absolutePath of toCheck) {
    const safety = await checkTarget(absolutePath);
    if (safety.kind === "safe") continue;
    if (config.pathAccess.mode === "block") {
      emitActionBlocked(pi, {
        feature: "pathAccess",
        action: safety.action,
        reason: safety.reason,
        block: { source: "policy", metadata: safety.metadata },
        context: { toolName: call.toolName, input: call.input },
      });
      return { block: true, reason: safety.reason };
    }
    flagged.push({ absolutePath, safety });
  }
  if (flagged.length === 0) return proceed();

  const presence = () => effectivePresence(away, ctx);
  const standing = away.standingPermissions;
  const standingExtra =
    standing.length > 0 ? { standingPermissions: standing } : {};

  // Repeat: something in this call was already deferred or denied.
  if (presence() === "away") {
    const repeats = flagged
      .map(({ safety }) => state.memory.get(actionKey(safety.action)))
      .filter((seen) => seen !== undefined);
    if (repeats.length > 0) {
      state.watchRemaining = away.watchCommands;
      const signal = state.ladder.recordBlock("repeat");
      const denied = repeats.some((seen) => seen.outcome === "denied");
      const base = denied ? REPEAT_DENIED : REPEAT_QUEUED;
      const finished = await finishBlock(env, base, signal);
      return blockWith(
        env,
        flagged[0].safety.action,
        finished.reason,
        "repeat",
        {
          metadata: flagged[0].safety.metadata,
          terminate: finished.terminate === true,
        },
      );
    }
  }

  // Delegates, one request per flagged path, sharing one watch window tick.
  let watch: { blocked: typeof state.blocked } | undefined;
  if (state.watchRemaining > 0) {
    state.watchRemaining -= 1;
    watch = { blocked: [...state.blocked] };
  }
  const delegations = await Promise.all(
    flagged.map(async ({ absolutePath, safety }) => ({
      absolutePath,
      safety,
      delegated: await delegateDecision(
        pi,
        deps.delegates,
        {
          feature: "pathAccess",
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
      ),
    })),
  );

  const blocks = delegations.filter(
    (entry): entry is typeof entry & { delegated: DelegatedDecision } =>
      entry.delegated?.verdict === "block",
  );
  const chosen =
    blocks.find((entry) => isSevereBlock(entry.delegated.outcomes)) ??
    blocks[0];
  if (chosen) {
    const { delegated, safety } = chosen;
    const metadata = { risk: safety.metadata, delegation: delegated };
    if (isSevereBlock(delegated.outcomes)) {
      const out = await raiseTripwire(env, {
        action: safety.action,
        flaggedReason: safety.reason,
        reason: delegated.reason,
        outcomes: delegated.outcomes,
        whileAway: presence() === "away",
      });
      return blockWith(env, safety.action, out.reason, "delegate", {
        metadata,
        terminate: true,
      });
    }
    const reason = `Blocked by decision delegate: ${delegated.reason} ${DENIED_SUFFIX}`;
    const signal = recordDenial(
      env,
      safety.action,
      reason,
      presence() === "away",
    );
    const finished = await finishBlock(env, reason, signal);
    return blockWith(env, safety.action, finished.reason, "delegate", {
      metadata,
      terminate: finished.terminate === true,
    });
  }

  // Unsure paths: ask the user while present, otherwise apply the away rules.
  const policyRules = createPolicyRules(
    compilePolicies(config.policies.rules),
    ctx.cwd,
  );
  const pending: AwayDecisionParams[] = [];
  const highRiskAllows: Omit<AwayDecisionParams, "risk">[] = [];
  const proceedAfterAllows = async () => {
    for (const params of highRiskAllows) await recordHighRiskAllow(env, params);
    return proceed();
  };
  let timedOut = false;
  for (const { absolutePath, delegated } of delegations) {
    const safety = await checkTarget(absolutePath);
    if (safety.kind === "safe") continue;
    if (delegated?.verdict === "allow") {
      state.memory.delete(actionKey(safety.action));
      if (presence() === "away") {
        const policy = await checkAction(
          { kind: "file", path: absolutePath, origin: call.toolName },
          policyRules,
        );
        if (hasHighRiskAllow(delegated.outcomes) || policy.kind !== "safe") {
          highRiskAllows.push({
            action: safety.action,
            flaggedReason: safety.reason,
            outcomes: delegated.outcomes,
            reason: delegated.reason,
            cause: ctx.hasUI ? "away" : "headless",
          });
        }
      }
      continue;
    }

    const outcomes: readonly DelegateOutcome[] = delegated?.outcomes ?? [];
    if (!timedOut && presence() === "present") {
      const result = await askUser(
        deps,
        env,
        call,
        { absolutePath, safety },
        pickCard(outcomes),
        ctx,
        config,
        acceptedGrants,
      );
      if (result === "deny") {
        const reason = "User denied access outside working directory";
        recordDenial(env, safety.action, reason, false);
        return blockWith(env, safety.action, reason, "user", {
          metadata: safety.metadata,
        });
      }
      if (result !== "timeout") {
        state.memory.delete(actionKey(safety.action));
        continue;
      }
      // The prompt timed out: the user is away from now on.
      setPresence(pi, state, "away", "timeout");
      timedOut = true;
    }
    const floor = await pathFloor(call.toolName, absolutePath, policyRules);
    pending.push({
      action: safety.action,
      flaggedReason: safety.reason,
      outcomes,
      reason: delegated?.reason ?? "",
      risk: resolveRisk(outcomes, floor),
      cause: timedOut ? "timeout" : ctx.hasUI ? "away" : "headless",
    });
  }
  if (pending.length === 0) return proceedAfterAllows();

  const decision = await resolveAwayDecisions(env, pending);
  if (decision.kind === "allow") return proceedAfterAllows();

  const deferredPaths = decision.items.map((item) =>
    item.action.kind === "file" ? item.action.path : "",
  );
  const signal = state.ladder.recordBlock("block");
  const finished = await finishBlock(
    env,
    `${DEFERRED}\n${deferredPaths.join("\n")}`,
    signal,
  );
  return blockWith(env, decision.items[0].action, finished.reason, "deferred", {
    metadata: flagged[0].safety.metadata,
    terminate: finished.terminate === true,
  });
}
