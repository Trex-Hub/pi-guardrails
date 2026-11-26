import { describe, expect, it } from "vitest";
import {
  type InboxDecision,
  type InboxItem,
  type SessionStatus,
  writeDecision,
  writeItem,
  writeSessionStatus,
} from "../../src/shared/away/inbox";
import {
  decisionForKey,
  formatTime,
  type InboxRow,
  loadInbox,
} from "./inbox-model";

const NOW = Date.parse("2026-03-10T12:00:00");

function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  return {
    version: 1,
    id,
    kind: "waiting",
    cause: "away",
    createdAt: "2026-03-10T10:00:00",
    session: { id: "abcdef123456", cwd: "/work/proj" },
    feature: "permissionGate",
    toolName: "bash",
    toolCallId: "tc",
    action: { kind: "command", command: "sudo ls" },
    flaggedReason: "superuser",
    reason: "",
    risk: "high",
    ...extra,
  };
}

function decision(id: string, decidedAt: string): InboxDecision {
  return {
    version: 1,
    id,
    decision: "approve",
    decidedAt,
    decidedBy: { kind: "inbox", sessionId: "x" },
  };
}

function status(extra: Partial<SessionStatus> = {}): SessionStatus {
  return {
    version: 1,
    sessionId: "abcdef123456",
    cwd: "/work/proj",
    pid: process.pid,
    state: "idle",
    presence: "away",
    updatedAt: new Date(NOW).toISOString(),
    ...extra,
  };
}

describe("loadInbox", () => {
  it("groups urgent, waiting, allowed and orders newest first inside each", async () => {
    await writeItem(item("w-old", { createdAt: "2026-03-10T08:00:00" }));
    await writeItem(item("w-new", { createdAt: "2026-03-10T09:00:00" }));
    await writeItem(item("a1", { kind: "allowed" }));
    await writeItem(item("u1", { kind: "urgent" }));
    const { rows } = await loadInbox(NOW);
    expect(rows.map((r) => r.item.id)).toEqual(["u1", "w-new", "w-old", "a1"]);
    expect(rows.map((r) => r.section)).toEqual([
      "urgent",
      "waiting",
      "waiting",
      "allowed",
    ]);
  });

  it("hides decided items and counts decisions of the last 24h", async () => {
    await writeItem(item("open"));
    await writeItem(item("done1"));
    await writeItem(item("done2"));
    await writeDecision(decision("done1", "2026-03-10T09:00:00"));
    await writeDecision(decision("done2", "2026-03-01T09:00:00"));
    const { rows, handled24h } = await loadInbox(NOW);
    expect(rows.map((r) => r.item.id)).toEqual(["open"]);
    expect(handled24h).toBe(1);
  });

  it("shows project, session name or short id, and session state", async () => {
    await writeItem(item("a"));
    await writeItem(
      item("b", { session: { id: "zzzz", cwd: "/x/other", name: "refactor" } }),
    );
    await writeSessionStatus(status({ state: "paused" }));
    const { rows } = await loadInbox(NOW);
    const a = rows.find((r) => r.item.id === "a") as InboxRow;
    const b = rows.find((r) => r.item.id === "b") as InboxRow;
    expect(a).toMatchObject({
      project: "proj",
      sessionLabel: "abcdef12",
      sessionState: "paused",
    });
    expect(b).toMatchObject({
      project: "other",
      sessionLabel: "refactor",
      sessionState: "closed",
    });
  });

  it("a status whose process is gone counts as closed", async () => {
    await writeItem(item("a"));
    await writeSessionStatus(status({ pid: 2 ** 22 + 12345 }));
    const { rows } = await loadInbox(NOW);
    expect(rows[0]?.sessionState).toBe("closed");
  });

  it("keeps the session file for reopening, from the item or the live status", async () => {
    await writeItem(
      item("a", { session: { id: "s9", cwd: "/w", file: "/s/a.jsonl" } }),
    );
    const { rows } = await loadInbox(NOW);
    expect(rows[0]?.sessionFile).toBe("/s/a.jsonl");
  });

  it("is empty when nothing exists", async () => {
    const snapshot = await loadInbox(NOW);
    expect(snapshot).toEqual({ rows: [], handled24h: 0 });
  });
});

describe("decisionForKey", () => {
  const waiting = { section: "waiting" } as InboxRow;
  const urgent = { section: "urgent" } as InboxRow;
  const allowed = { section: "allowed" } as InboxRow;

  it("maps waiting keys", () => {
    expect(decisionForKey(waiting, "a")).toBe("approve");
    expect(decisionForKey(waiting, "A")).toBe("approve-always");
    expect(decisionForKey(waiting, "r")).toBe("reject");
    expect(decisionForKey(waiting, "f")).toBeUndefined();
    expect(decisionForKey(waiting, "w")).toBeUndefined();
  });

  it("urgent items offer only approve once and reject, never always allow", () => {
    expect(decisionForKey(urgent, "a")).toBe("approve");
    expect(decisionForKey(urgent, "r")).toBe("reject");
    expect(decisionForKey(urgent, "A")).toBeUndefined();
    expect(decisionForKey(urgent, "f")).toBeUndefined();
    expect(decisionForKey(urgent, "w")).toBeUndefined();
  });

  it("maps allowed keys", () => {
    expect(decisionForKey(allowed, "f")).toBe("fine");
    expect(decisionForKey(allowed, "w")).toBe("wrong");
    expect(decisionForKey(allowed, "a")).toBeUndefined();
    expect(decisionForKey(allowed, "A")).toBeUndefined();
    expect(decisionForKey(allowed, "r")).toBeUndefined();
  });
});

describe("formatTime", () => {
  it("is a clock time today and a date otherwise", () => {
    expect(formatTime("2026-03-10T09:05:00", NOW)).toBe("09:05");
    expect(formatTime("2026-03-08T21:30:00", NOW)).toBe("Mar 8 21:30");
    expect(formatTime("nope", NOW)).toBe("");
  });
});
