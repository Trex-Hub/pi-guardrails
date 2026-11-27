import {
  type InboxItem,
  isSessionAlive,
  readDecisions,
  readItems,
  readSessionStatuses,
  type SessionStatus,
} from "../../src/shared/away/inbox";
import { actionLabel } from "../../src/shared/away/messages";
import type { DecisionKind } from "./decide";

export type Section = "urgent" | "waiting" | "allowed";
export type SessionState = SessionStatus["state"] | "closed";

export interface InboxRow {
  item: InboxItem;
  section: Section;
  project: string;
  sessionLabel: string;
  sessionState: SessionState;
  /** Session file to reopen, when known. */
  sessionFile?: string;
  label: string;
}

export interface InboxSnapshot {
  /** Urgent first, then waiting, then allowed; newest first inside each. */
  rows: InboxRow[];
  /** Decisions made in the last 24 hours. */
  handled24h: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SECTIONS: Section[] = ["urgent", "waiting", "allowed"];

export const SECTION_TITLES: Record<Section, string> = {
  urgent: "Urgent",
  waiting: "Waiting for you",
  allowed: "Allowed while you were away",
};

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Reads every item, decision and session status on the machine. */
export async function loadInbox(
  now: number = Date.now(),
): Promise<InboxSnapshot> {
  const [items, decisions, statuses] = await Promise.all([
    readItems(),
    readDecisions(),
    readSessionStatuses(),
  ]);
  const decided = new Set(decisions.map((d) => d.id));
  const live = new Map<string, SessionStatus>();
  for (const status of statuses) {
    if (isSessionAlive(status, now)) live.set(status.sessionId, status);
  }
  const rows: InboxRow[] = [];
  for (const item of items) {
    if (decided.has(item.id)) continue;
    const status = live.get(item.session.id);
    rows.push({
      item,
      section: item.kind,
      project: basename(item.session.cwd),
      sessionLabel: item.session.name ?? item.session.id.slice(-8),
      sessionState: status?.state ?? "closed",
      sessionFile: item.session.file ?? status?.file,
      label: actionLabel(item.action, item.toolName).replace(/\s+/g, " "),
    });
  }
  rows.sort(
    (a, b) =>
      SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) ||
      Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt),
  );
  const handled24h = decisions.filter((d) => {
    const at = Date.parse(d.decidedAt);
    return Number.isFinite(at) && now - at <= DAY_MS;
  }).length;
  return { rows, handled24h };
}

/** The decisions a row accepts, by key. */
export function decisionForKey(
  row: InboxRow,
  key: string,
): DecisionKind | undefined {
  if (row.section === "allowed") {
    if (key === "f") return "fine";
    if (key === "w") return "wrong";
    return undefined;
  }
  if (key === "a") return "approve";
  // Urgent items never offer "always": one keypress must not turn a severe
  // action into a permanent allow rule.
  if (key === "A")
    return row.section === "urgent" ? undefined : "approve-always";
  if (key === "r") return "reject";
  return undefined;
}

/** `HH:MM` for today, else `Mon D HH:MM`. */
export function formatTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === new Date(now).toDateString()) return clock;
  const month = at.toLocaleString("en-US", { month: "short" });
  return `${month} ${at.getDate()} ${clock}`;
}
