import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { actionKey } from "../../src/core/away";
import {
  type InboxItem,
  readDecisions,
  readItem,
  readItems,
} from "../../src/shared/away/inbox";
import {
  actionLabel,
  approved,
  rejected,
} from "../../src/shared/away/messages";
import { type AwayState, resumeRun } from "../../src/shared/away/state";

export const APPLIED_ENTRY = "guardrails:inbox-applied";

/** Clears a pause and starts the ladder over, so a limit pause does not re-trigger on the next block. */
export function liftPause(pi: ExtensionAPI, state: AwayState): void {
  if (!state.paused) return;
  resumeRun(pi, state);
  state.ladder.reset();
}

/**
 * Rebuilds this session's items and the ids it already applied. Called when
 * the extension starts, so a reload or resume never applies a decision twice.
 */
export async function restoreSession(
  ctx: ExtensionContext,
  state: AwayState,
): Promise<{ applied: Set<string>; ownItems: InboxItem[] }> {
  const sessionId = ctx.sessionManager.getSessionId();
  const ownItems: InboxItem[] = [];
  for (const item of await readItems()) {
    if (item.session.id !== sessionId) continue;
    state.ownItemIds.add(item.id);
    ownItems.push(item);
  }
  const applied = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== APPLIED_ENTRY) continue;
    const id = (entry.data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") applied.add(id);
  }
  return { applied, ownItems };
}

/**
 * Applies decisions made for this session's items. Safe to call from several
 * wake-ups: a decision is applied once, tracked in `applied` and a session entry.
 * Only this session's items are looked at, so sessions sharing the inbox dir
 * never touch each other's.
 */
export async function applyDecisions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: AwayState,
  applied: Set<string>,
  delivery: "live" | "nextTurn",
): Promise<void> {
  const pending = [...state.ownItemIds].filter((id) => !applied.has(id));
  if (pending.length === 0) return;
  const decisions = await readDecisions(pending);
  const lines: string[] = [];
  for (const decision of decisions) {
    if (applied.has(decision.id)) continue;
    applied.add(decision.id);
    pi.appendEntry(APPLIED_ENTRY, {
      id: decision.id,
      decision: decision.decision,
    });
    const item = await readItem(decision.id);
    if (!item) continue;
    const key = actionKey(item.action);
    const label = actionLabel(item.action, item.toolName);
    if (
      decision.decision === "approve" ||
      decision.decision === "approve-always"
    ) {
      state.onceGrants.add(key);
      state.memory.delete(key);
      lines.push(approved(label));
    } else if (decision.decision === "reject") {
      state.memory.set(key, { outcome: "denied", itemId: item.id });
      lines.push(rejected(label));
    }
  }
  if (lines.length === 0) return;
  liftPause(pi, state);
  const options =
    delivery === "nextTurn"
      ? { deliverAs: "nextTurn" as const }
      : ctx.isIdle()
        ? { triggerTurn: true }
        : { deliverAs: "followUp" as const };
  pi.sendMessage(
    { customType: "guardrails:away", content: lines.join("\n"), display: true },
    options,
  );
}
