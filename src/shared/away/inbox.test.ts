import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDRAILS_AWAY_ITEM_EVENT } from "../events";
import {
  type InboxDecision,
  type InboxItem,
  inboxDir,
  isSessionAlive,
  prune,
  publishItem,
  readDecisions,
  readItems,
  readSessionStatuses,
  removeSessionStatus,
  type SessionStatus,
  sessionsDir,
  writeDecision,
  writeItem,
  writeSessionStatus,
} from "./inbox";
import { collect, fakePi } from "./test-utils";

const DAY = 24 * 60 * 60 * 1000;

function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  return {
    version: 1,
    id,
    kind: "waiting",
    cause: "away",
    createdAt: new Date().toISOString(),
    session: { id: "s1", cwd: "/work/proj" },
    feature: "permissionGate",
    toolName: "bash",
    toolCallId: "tc1",
    action: { kind: "command", command: "sudo ls" },
    flaggedReason: "superuser command",
    reason: "",
    risk: "high",
    ...extra,
  };
}

function decision(
  id: string,
  extra: Partial<InboxDecision> = {},
): InboxDecision {
  return {
    version: 1,
    id,
    decision: "approve",
    decidedAt: new Date().toISOString(),
    decidedBy: { kind: "inbox", sessionId: "s2" },
    ...extra,
  };
}

function status(id: string, extra: Partial<SessionStatus> = {}): SessionStatus {
  return {
    version: 1,
    sessionId: id,
    cwd: "/work/proj",
    pid: process.pid,
    state: "idle",
    presence: "away",
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", "/agent");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vol.reset();
});

describe("paths", () => {
  it("live under the agent dir", () => {
    expect(inboxDir()).toBe("/agent/guardrails/inbox");
    expect(sessionsDir()).toBe("/agent/guardrails/sessions");
  });
});

describe("items and decisions", () => {
  it("round-trips an item, creating the directory on demand", async () => {
    const a = item("a", { card: { summary: "does a thing" } });
    const r1 = await writeItem(a);
    expect(r1).toBe(true);
    const r2 = await readItems();
    expect(r2).toEqual([a]);
    expect(readdirSync(inboxDir())).toEqual(["a.item.json"]);
  });

  it("writes one item per id and leaves no temp files", async () => {
    await writeItem(item("a"));
    const r3 = await writeItem(item("a", { reason: "second" }));
    expect(r3).toBe(false);
    const items = await readItems();
    expect(items[0]?.reason).toBe("");
    expect(readdirSync(inboxDir()).filter((n) => n.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("round-trips decisions and filters by id", async () => {
    await writeItem(item("a"));
    await writeItem(item("b"));
    const rejected = decision("b", { decision: "reject" });
    await writeDecision(decision("a"));
    await writeDecision(rejected);
    const all = await readDecisions();
    expect(all.map((d) => d.id).sort()).toEqual(["a", "b"]);
    const onlyB = await readDecisions(["b"]);
    expect(onlyB).toEqual([rejected]);
    const none = await readDecisions([]);
    expect(none).toEqual([]);
  });

  it("the first decision wins", async () => {
    await writeItem(item("a"));
    const first = await writeDecision(decision("a", { decision: "approve" }));
    const second = await writeDecision(decision("a", { decision: "reject" }));
    expect(first).toBe(true);
    expect(second).toBe(false);
    const stored = await readDecisions(["a"]);
    expect(stored[0]?.decision).toBe("approve");
  });

  it("concurrent decisions: exactly one wins", async () => {
    const results = await Promise.all([
      writeDecision(decision("a", { decision: "approve" })),
      writeDecision(decision("a", { decision: "reject" })),
      writeDecision(decision("a", { decision: "fine" })),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const r5 = await readDecisions(["a"]);
    expect(r5).toHaveLength(1);
  });

  it("returns empty lists when the directory does not exist", async () => {
    const r6 = await readItems();
    expect(r6).toEqual([]);
    const r7 = await readDecisions();
    expect(r7).toEqual([]);
    const r8 = await readSessionStatuses();
    expect(r8).toEqual([]);
  });

  it("skips corrupt, unknown-version, mismatched and temp files", async () => {
    await writeItem(item("good"));
    const dir = inboxDir();
    writeFileSync(join(dir, "corrupt.item.json"), "{not json");
    writeFileSync(
      join(dir, "future.item.json"),
      JSON.stringify({ ...item("future"), version: 2 }),
    );
    writeFileSync(
      join(dir, "wrongname.item.json"),
      JSON.stringify(item("other")),
    );
    writeFileSync(
      join(dir, "tmp.item.json.tmp-1-abc"),
      JSON.stringify(item("tmp")),
    );
    writeFileSync(join(dir, "notes.txt"), "hello");
    writeFileSync(
      join(dir, "good.decision.json"),
      JSON.stringify({ ...decision("good"), version: 9 }),
    );
    const items = await readItems();
    expect(items.map((i) => i.id)).toEqual(["good"]);
    const r9 = await readDecisions();
    expect(r9).toEqual([]);
  });

  it("refuses ids that could escape the directory", async () => {
    const r10 = await writeItem(item("../evil"));
    expect(r10).toBe(false);
    const r11 = await writeDecision(decision("a/b"));
    expect(r11).toBe(false);
    expect(vol.toJSON()).toEqual({});
  });

  it("publishItem writes and emits guardrails:away:item", async () => {
    const { pi, bus } = fakePi();
    const seen = collect(bus, GUARDRAILS_AWAY_ITEM_EVENT);
    const a = item("a");
    const r12 = await publishItem(pi, a);
    expect(r12).toBe(true);
    expect(seen).toEqual([
      expect.objectContaining({ source: "guardrails", item: a }),
    ]);
    expect((seen[0] as { decision?: unknown }).decision).toBeUndefined();
    seen.length = 0;
    const r13 = await publishItem(pi, a);
    expect(r13).toBe(false);
    expect(seen).toEqual([]);
  });

  it("never throws on I/O errors", async () => {
    vol.fromJSON({ "/agent/guardrails": "i am a file" });
    const r14 = await writeItem(item("a"));
    expect(r14).toBe(false);
    const r15 = await writeDecision(decision("a"));
    expect(r15).toBe(false);
    const r16 = await readItems();
    expect(r16).toEqual([]);
    const r17 = await writeSessionStatus(status("s1"));
    expect(r17).toBe(false);
  });
});

describe("session status", () => {
  it("writes, rewrites, reads and removes", async () => {
    await writeSessionStatus(status("s1", { state: "running" }));
    await writeSessionStatus(status("s1", { state: "paused" }));
    await writeSessionStatus(status("s2"));
    const all = await readSessionStatuses();
    expect(all.map((s) => `${s.sessionId}:${s.state}`).sort()).toEqual([
      "s1:paused",
      "s2:idle",
    ]);
    await removeSessionStatus("s1");
    await removeSessionStatus("missing");
    const remaining = await readSessionStatuses();
    expect(remaining.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("skips corrupt and temp status files", async () => {
    await writeSessionStatus(status("s1"));
    writeFileSync(join(sessionsDir(), "bad.json"), "nope");
    writeFileSync(join(sessionsDir(), "s9.json.tmp-1-x"), "{}");
    const statuses = await readSessionStatuses();
    expect(statuses.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("sanitizes session ids used in file names", async () => {
    await writeSessionStatus(status("../x/y"));
    expect(readdirSync(sessionsDir())).toEqual([".._x_y.json"]);
    await removeSessionStatus("../x/y");
    expect(readdirSync(sessionsDir())).toEqual([]);
  });
});

describe("isSessionAlive", () => {
  it("is true for a live pid", () => {
    expect(isSessionAlive(status("s1"))).toBe(true);
  });

  it("is false when the pid is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no"), { code: "ESRCH" });
    });
    expect(isSessionAlive(status("s1"))).toBe(false);
  });

  it("on EPERM depends on how fresh the status is", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no"), { code: "EPERM" });
    });
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(
      isSessionAlive(status("s", { updatedAt: "2026-01-01T11:55:00Z" }), now),
    ).toBe(true);
    expect(
      isSessionAlive(status("s", { updatedAt: "2026-01-01T11:40:00Z" }), now),
    ).toBe(false);
    expect(isSessionAlive(status("s", { updatedAt: "garbage" }), now)).toBe(
      false,
    );
  });
});

describe("prune", () => {
  const now = Date.parse("2026-02-01T00:00:00Z");
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const files = () => readdirSync(inboxDir()).sort();

  it("deletes an item and decision once the decision is over 14 days old", async () => {
    await writeItem(item("old"));
    await writeDecision(decision("old", { decidedAt: ago(15) }));
    await writeItem(item("recent"));
    await writeDecision(decision("recent", { decidedAt: ago(13) }));
    await prune(now);
    expect(files()).toEqual(["recent.decision.json", "recent.item.json"]);
  });

  it("keeps items without a decision, however old", async () => {
    await writeItem(item("waiting", { createdAt: ago(60) }));
    await prune(now);
    expect(files()).toEqual(["waiting.item.json"]);
  });

  it("deletes orphan decisions over 14 days old, keeps recent ones", async () => {
    await writeDecision(decision("orphan-old", { decidedAt: ago(20) }));
    await writeDecision(decision("orphan-new", { decidedAt: ago(1) }));
    await prune(now);
    expect(files()).toEqual(["orphan-new.decision.json"]);
  });

  it("is a no-op without an inbox directory", async () => {
    await expect(prune(now)).resolves.toBeUndefined();
  });

  it("leaves file contents untouched", async () => {
    const a = item("keep");
    await writeItem(a);
    await prune(now);
    expect(
      JSON.parse(readFileSync(join(inboxDir(), "keep.item.json"), "utf-8")),
    ).toEqual(a);
  });
});
