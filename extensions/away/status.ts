import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readDecisions,
  readItems,
  type SessionStatus,
  writeSessionStatus,
} from "../../src/shared/away/inbox";
import { type AwayState, effectivePresence } from "../../src/shared/away/state";
import type { ResolvedConfig } from "../../src/shared/config/types";

/** Footer text for the away status line, or undefined to clear it. */
export function statusLine(
  presence: "present" | "away",
  paused: boolean,
  open: number,
): string | undefined {
  if (paused) return `paused · ${open} waiting`;
  if (presence === "away") return `away · ${open} waiting`;
  return open > 0 ? `${open} waiting` : undefined;
}

/** Open waiting and urgent items on this machine: no decision yet. */
export async function openCount(): Promise<number> {
  const items = await readItems();
  const waiting = items.filter((item) => item.kind !== "allowed");
  if (waiting.length === 0) return 0;
  const decisions = await readDecisions(waiting.map((item) => item.id));
  const decided = new Set(decisions.map((d) => d.id));
  return waiting.filter((item) => !decided.has(item.id)).length;
}

export async function writeStatus(
  ctx: ExtensionContext,
  state: AwayState,
  away: ResolvedConfig["away"],
  runState: "running" | "idle",
): Promise<void> {
  const { sessionManager } = ctx;
  const status: SessionStatus = {
    version: 1,
    sessionId: sessionManager.getSessionId(),
    file: sessionManager.getSessionFile(),
    name: sessionManager.getSessionName(),
    cwd: ctx.cwd,
    pid: process.pid,
    state: state.paused ? "paused" : runState,
    presence: effectivePresence(away, ctx),
    updatedAt: new Date().toISOString(),
  };
  await writeSessionStatus(status);
}
