import { readdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type InboxItem,
  inboxDir,
  readDecisions,
  writeDecision,
  writeItem,
} from "../../src/shared/away/inbox";
import type { ResolvedConfig } from "../../src/shared/config";
import { registerInboxCommand, resultMessage } from "./inbox-command";

const h = vi.hoisted(() => ({
  mode: "auto" as "off" | "auto" | "always",
  enabled: true,
}));

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    getRawConfig: vi.fn(() => null),
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(
      () =>
        ({
          enabled: h.enabled,
          away: { mode: h.mode },
        }) as unknown as ResolvedConfig,
    ),
  },
}));

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
    toolCallId: "tc",
    action: { kind: "command", command: `sudo ${id}` },
    flaggedReason: "superuser",
    reason: "",
    risk: "high",
    ...extra,
  };
}

function setup(mode: string) {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerCommand: vi.fn(
      (
        _name: string,
        options: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        handler = options.handler;
      },
    ),
  } as unknown as ExtensionAPI;
  registerInboxCommand(pi);
  const notify = vi.fn();
  const select = vi.fn();
  const custom = vi.fn();
  const ctx = {
    mode,
    ui: { notify, select, custom },
    sessionManager: { getSessionId: () => "viewer" },
  };
  return {
    notify,
    select,
    custom,
    run: () => handler?.("", ctx) as Promise<void>,
  };
}

describe("/guardrails:inbox", () => {
  it("in off mode only notifies and creates nothing", async () => {
    h.mode = "off";
    const t = setup("tui");
    await t.run();
    expect(t.notify).toHaveBeenCalledWith(
      'Away mode is off. Set away.mode to "auto" in guardrails.json.',
      "info",
    );
    expect(t.custom).not.toHaveBeenCalled();
    expect(() => readdirSync(inboxDir())).toThrow();
    h.mode = "auto";
  });

  it("opens the custom view in the tui", async () => {
    h.mode = "auto";
    const t = setup("tui");
    await t.run();
    expect(t.custom).toHaveBeenCalledTimes(1);
    expect(t.select).not.toHaveBeenCalled();
  });

  it("rpc: says so when empty", async () => {
    h.mode = "auto";
    const t = setup("rpc");
    await t.run();
    expect(t.notify).toHaveBeenCalledWith("Nothing waiting for you.", "info");
    expect(t.select).not.toHaveBeenCalled();
  });

  it("rpc: picks an item, then an action, and writes the decision", async () => {
    h.mode = "auto";
    await writeItem(item("one"));
    const t = setup("rpc");
    t.select
      .mockImplementationOnce(
        async (_title: string, options: string[]) => options[0],
      )
      .mockImplementationOnce(async (_title: string, options: string[]) => {
        expect(options).toEqual([
          "Show details",
          "Approve once",
          "Always allow",
          "Reject",
        ]);
        return "Reject";
      });
    await t.run();
    const stored = await readDecisions(["one"]);
    expect(stored[0]).toMatchObject({
      decision: "reject",
      decidedBy: { kind: "inbox", sessionId: "viewer" },
    });
    expect(t.notify).toHaveBeenCalledWith("Rejected.", "info");
  });

  it("rpc: urgent items offer approve once and reject only", async () => {
    h.mode = "auto";
    await writeItem(item("one", { kind: "urgent" }));
    const t = setup("rpc");
    t.select
      .mockImplementationOnce(
        async (_t: string, options: string[]) => options[0],
      )
      .mockImplementationOnce(async (_t: string, options: string[]) => {
        expect(options).toEqual(["Show details", "Approve once", "Reject"]);
        return "Approve once";
      });
    await t.run();
    const stored = await readDecisions(["one"]);
    expect(stored[0]?.decision).toBe("approve");
  });

  it("rpc: allowed items offer fine and shouldn't-have-run", async () => {
    h.mode = "auto";
    await writeItem(item("one", { kind: "allowed" }));
    const t = setup("rpc");
    t.select
      .mockImplementationOnce(
        async (_t: string, options: string[]) => options[0],
      )
      .mockImplementationOnce(async (_t: string, options: string[]) => {
        expect(options).toEqual(["Show details", "Fine", "Shouldn't have run"]);
        return "Fine";
      });
    await t.run();
    const stored = await readDecisions(["one"]);
    expect(stored[0]?.decision).toBe("fine");
  });

  it("rpc: show details notifies the item without deciding", async () => {
    h.mode = "auto";
    await writeItem(item("one"));
    const t = setup("rpc");
    t.select
      .mockImplementationOnce(
        async (_t: string, options: string[]) => options[0],
      )
      .mockImplementationOnce(async () => "Show details");
    await t.run();
    expect(String(t.notify.mock.calls[0]?.[0])).toContain("Flagged: superuser");
    const stored = await readDecisions(["one"]);
    expect(stored).toEqual([]);
  });

  it("rpc: choosing an item someone else just decided says 'Already decided.'", async () => {
    h.mode = "auto";
    await writeItem(item("one"));
    const t = setup("rpc");
    t.select
      .mockImplementationOnce(
        async (_t: string, options: string[]) => options[0],
      )
      .mockImplementationOnce(async () => {
        await writeDecision({
          version: 1,
          id: "one",
          decision: "reject",
          decidedAt: new Date().toISOString(),
          decidedBy: { kind: "pi-live", client: "phone" },
        });
        return "Approve once";
      });
    await t.run();
    expect(t.notify).toHaveBeenCalledWith("Already decided.", "info");
    const stored = await readDecisions(["one"]);
    expect(stored[0]?.decision).toBe("reject");
  });

  it("rpc: cancelling a select does nothing", async () => {
    h.mode = "auto";
    await writeItem(item("one"));
    const t = setup("rpc");
    t.select.mockResolvedValueOnce(undefined);
    await t.run();
    expect(t.notify).not.toHaveBeenCalled();
  });
});

describe("resultMessage", () => {
  it("says what happened, including 'already decided' and a failed grant", () => {
    expect(resultMessage({ status: "decided" }, "approve-always")).toBe(
      "Always allowed and approved.",
    );
    expect(resultMessage({ status: "already" }, "approve")).toBe(
      "Already decided.",
    );
    expect(
      resultMessage(
        { status: "grant-failed", error: "disk full" },
        "approve-always",
      ),
    ).toContain("disk full");
    expect(resultMessage({ status: "write-failed" }, "reject")).toContain(
      "Could not",
    );
  });
});
