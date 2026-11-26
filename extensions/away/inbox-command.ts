import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { configLoader } from "../../src/shared/config";
import { type DecideResult, type DecisionKind, decide } from "./decide";
import { decisionForKey, type InboxRow, loadInbox } from "./inbox-model";
import { createInboxView, detailLines, rowText } from "./inbox-view";

const OFF_NOTICE =
  'Away mode is off. Set away.mode to "auto" in guardrails.json.';

/** The footer line for the outcome of a decision. */
export function resultMessage(
  result: DecideResult,
  decision: DecisionKind,
): string {
  switch (result.status) {
    case "decided":
      return {
        approve: "Approved once.",
        "approve-always": "Always allowed and approved.",
        reject: "Rejected.",
        fine: "Marked fine.",
        wrong: "Marked as shouldn't have run.",
      }[decision];
    case "already":
      return "Already decided.";
    case "grant-failed":
      return `Could not save the global grant, so nothing was decided: ${result.error}`;
    case "write-failed":
      return "Could not write the decision.";
  }
}

const PICK_ACTIONS: Array<{ label: string; key: string }> = [
  { label: "Approve once", key: "a" },
  { label: "Always allow", key: "A" },
  { label: "Reject", key: "r" },
  { label: "Fine", key: "f" },
  { label: "Shouldn't have run", key: "w" },
];

/** No custom UI in RPC mode: pick an item, then an action. */
async function selectFallback(
  ctx: ExtensionCommandContext,
  rows: InboxRow[],
  act: (row: InboxRow, decision: DecisionKind) => Promise<string>,
): Promise<void> {
  const titles = rows.map((row, index) => `${index + 1}. ${rowText(row, 100)}`);
  const picked = await ctx.ui.select("Guardrails inbox", titles);
  if (picked === undefined) return;
  const row = rows[titles.indexOf(picked)];
  if (!row) return;
  const actions = PICK_ACTIONS.filter((a) => decisionForKey(row, a.key));
  const shows = "Show details";
  const choice = await ctx.ui.select(row.label, [
    shows,
    ...actions.map((a) => a.label),
  ]);
  if (choice === undefined) return;
  if (choice === shows) {
    const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    ctx.ui.notify(detailLines(row, plain).join("\n"), "info");
    return;
  }
  const key = actions.find((a) => a.label === choice)?.key;
  const decision = key ? decisionForKey(row, key) : undefined;
  if (!decision) return;
  const message = await act(row, decision);
  ctx.ui.notify(message, "info");
}

export function registerInboxCommand(pi: ExtensionAPI): void {
  pi.registerCommand("guardrails:inbox", {
    description:
      "Review actions Guardrails held or allowed while you were away",
    handler: async (_args, ctx) => {
      const config = configLoader.getConfig();
      if (!config.enabled || (config.away?.mode ?? "off") === "off") {
        ctx.ui.notify(OFF_NOTICE, "info");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const act = async (row: InboxRow, decision: DecisionKind) => {
        const result = await decide(row.item, decision, {
          kind: "inbox",
          sessionId,
        });
        return resultMessage(result, decision);
      };
      if (ctx.mode !== "tui") {
        const snapshot = await loadInbox();
        if (snapshot.rows.length === 0) {
          ctx.ui.notify("Nothing waiting for you.", "info");
          return;
        }
        await selectFallback(ctx, snapshot.rows, act);
        return;
      }
      await ctx.ui.custom<undefined>((tui, theme, _kb, done) =>
        createInboxView({
          tui,
          theme,
          done: () => done(undefined),
          load: () => loadInbox(),
          act,
        }),
      );
    },
  });
}
