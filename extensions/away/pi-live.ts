import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InboxItem } from "../../src/shared/away/inbox";
import { actionLabel } from "../../src/shared/away/messages";
import { type PiLiveClient, parkPrompt } from "../../src/shared/pi-live";

export const INBOX_OPTIONS = [
  { result: "approve", label: "Approve once" },
  { result: "approve-always", label: "Always allow" },
  { result: "reject", label: "Reject" },
] as const;

export type InboxAnswer = (typeof INBOX_OPTIONS)[number]["result"];

export interface InboxTicket {
  /** The decision came from somewhere else: close the ticket with `{ by: "keyboard" }`. */
  closeOutside(): void;
  /** The decision was written for a client's answer: close the ticket as answered. */
  closeAnswered(): void;
  /** The session is ending: close the ticket with `{ by: "shutdown" }`. */
  shutdown(): void;
}

/**
 * Parks one open inbox item for pi-live clients. A client answer calls
 * `onAnswer`; the caller writes the decision and closes the ticket.
 */
export function parkInboxItem(
  pi: ExtensionAPI,
  item: InboxItem,
  onAnswer: (answer: InboxAnswer, client: PiLiveClient | undefined) => void,
): InboxTicket {
  let closedOutside = false;
  const park = parkPrompt<InboxAnswer>({
    events: pi.events,
    id: item.id,
    kind: "guardrails.inbox",
    title: `Waiting for approval: ${actionLabel(item.action, item.toolName)}`,
    view: {
      itemId: item.id,
      ...(item.session.name !== undefined
        ? { sessionName: item.session.name }
        : {}),
      cwd: item.session.cwd,
      toolName: item.toolName,
      action: item.action,
      flaggedReason: item.flaggedReason,
      reason: item.reason,
      risk: item.risk,
      ...(item.card ? { card: item.card } : {}),
      options: INBOX_OPTIONS,
    },
    options: INBOX_OPTIONS,
    onResult: (answer) => {
      if (closedOutside) return;
      onAnswer(answer, park.outcome().client);
    },
  });
  return {
    closeOutside() {
      closedOutside = true;
      park.keyboard("reject");
      park.dispose();
    },
    closeAnswered() {
      park.dispose();
    },
    shutdown() {
      park.dispose("shutdown");
    },
  };
}
