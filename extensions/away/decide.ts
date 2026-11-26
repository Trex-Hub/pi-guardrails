import {
  type InboxDecision,
  type InboxItem,
  readDecisions,
  writeDecision,
} from "../../src/shared/away/inbox";
import { saveGlobalGrant } from "./grant";

export type DecisionKind = InboxDecision["decision"];

export type DecideResult =
  | { status: "decided" }
  /** Someone else (another session, the TUI, a pi-live client) decided first. */
  | { status: "already" }
  | { status: "grant-failed"; error: string }
  | { status: "write-failed" };

async function alreadyDecided(id: string): Promise<boolean> {
  const found = await readDecisions([id]);
  return found.length > 0;
}

/**
 * Records a decision for an item. For `approve-always` the global grant is
 * saved first and the decision is written only if that succeeds. The first
 * decision wins: a loser gets `already`, never an error.
 */
export async function decide(
  item: InboxItem,
  decision: DecisionKind,
  decidedBy: InboxDecision["decidedBy"],
): Promise<DecideResult> {
  if (await alreadyDecided(item.id)) return { status: "already" };
  if (decision === "approve-always") {
    try {
      await saveGlobalGrant(item.action);
    } catch (error) {
      return {
        status: "grant-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const written = await writeDecision({
    version: 1,
    id: item.id,
    decision,
    decidedAt: new Date().toISOString(),
    decidedBy,
  });
  if (written) return { status: "decided" };
  const lost = await alreadyDecided(item.id);
  return lost ? { status: "already" } : { status: "write-failed" };
}
