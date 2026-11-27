import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InboxItem,
  inboxDir,
  readDecisions,
  writeDecision,
} from "../../src/shared/away/inbox";
import { configLoader } from "../../src/shared/config";
import { exactCommandPattern } from "../permission-gate/grants";
import { decide } from "./decide";

// Never the real agent dir: the config loader and getAgentDir both read this.
const AGENT_DIR = vi.hoisted(() => {
  const dir = "/tmp/guardrails-test-agent";
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
});

const GLOBAL_CONFIG = join(AGENT_DIR, "extensions", "guardrails.json");

function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  return {
    version: 1,
    id,
    kind: "waiting",
    cause: "away",
    createdAt: new Date().toISOString(),
    session: { id: "s1", cwd: "/work" },
    feature: "permissionGate",
    toolName: "bash",
    toolCallId: "tc1",
    action: { kind: "command", command: "sudo ls (x)" },
    flaggedReason: "superuser command",
    reason: "",
    risk: "high",
    ...extra,
  };
}

const by = { kind: "inbox", sessionId: "s2" } as const;

describe("decide", () => {
  beforeEach(async () => {
    await configLoader.load();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the temp agent dir", () => {
    expect(process.env.PI_CODING_AGENT_DIR).toBe(AGENT_DIR);
    expect(AGENT_DIR.startsWith("/tmp/")).toBe(true);
  });

  it("writes a plain decision with decidedBy", async () => {
    const result = await decide(item("a"), "reject", by);
    expect(result).toEqual({ status: "decided" });
    const stored = await readDecisions(["a"]);
    expect(stored[0]).toMatchObject({ decision: "reject", decidedBy: by });
    expect(existsSync(GLOBAL_CONFIG)).toBe(false);
  });

  it("approve-always on a command saves an exact pattern to the GLOBAL config, then writes the decision", async () => {
    const result = await decide(item("a"), "approve-always", by);
    expect(result).toEqual({ status: "decided" });
    const saved = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
    expect(saved.permissionGate.allowedPatterns).toEqual([
      { pattern: exactCommandPattern("sudo ls (x)"), regex: true },
    ]);
    const stored = await readDecisions(["a"]);
    expect(stored[0]?.decision).toBe("approve-always");
  });

  it("approve-always twice does not duplicate the pattern", async () => {
    await decide(item("a"), "approve-always", by);
    await decide(item("b"), "approve-always", by);
    const saved = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
    expect(saved.permissionGate.allowedPatterns).toHaveLength(1);
  });

  it("approve-always on a file saves a file grant to the global pathAccess.allowedPaths", async () => {
    const file = item("f", {
      feature: "pathAccess",
      toolName: "write",
      action: { kind: "file", path: "/opt/data/out.txt" },
    });
    const result = await decide(file, "approve-always", by);
    expect(result).toEqual({ status: "decided" });
    const saved = JSON.parse(readFileSync(GLOBAL_CONFIG, "utf-8"));
    expect(saved.pathAccess.allowedPaths).toEqual([
      { kind: "file", path: "/opt/data/out.txt" },
    ]);
  });

  it("a failed global save reports it and writes NO decision", async () => {
    vi.spyOn(configLoader, "save").mockRejectedValue(new Error("disk full"));
    const result = await decide(item("a"), "approve-always", by);
    expect(result).toEqual({ status: "grant-failed", error: "disk full" });
    expect(existsSync(join(inboxDir(), "a.decision.json"))).toBe(false);
  });

  it("an item that already has a decision is 'already', without saving a grant", async () => {
    await writeDecision({
      version: 1,
      id: "a",
      decision: "reject",
      decidedAt: new Date().toISOString(),
      decidedBy: { kind: "pi-live", client: "phone" },
    });
    const save = vi.spyOn(configLoader, "save");
    const result = await decide(item("a"), "approve-always", by);
    expect(result).toEqual({ status: "already" });
    expect(save).not.toHaveBeenCalled();
    const stored = await readDecisions(["a"]);
    expect(stored[0]?.decision).toBe("reject");
  });

  it("two deciders at once: exactly one decided, the other 'already', first decision kept", async () => {
    const results = await Promise.all([
      decide(item("a"), "approve", by),
      decide(item("a"), "reject", { kind: "pi-live", client: "phone" }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["already", "decided"]);
    const stored = await readDecisions(["a"]);
    expect(stored).toHaveLength(1);
  });
});
