import { readdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InboxItem,
  inboxDir,
  readDecisions,
  writeDecision,
  writeItem,
} from "../../src/shared/away/inbox";
import { configLoader, type ResolvedConfig } from "../../src/shared/config";
import { registerInboxCommand, resultMessage } from "./inbox-command";
import { resetSuggestions } from "./suggest";

const h = vi.hoisted(() => ({
  mode: "auto" as "off" | "auto" | "always",
  enabled: true,
  standing: [] as string[],
  raw: null as Record<string, unknown> | null,
}));

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    getRawConfig: vi.fn(() => h.raw),
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(
      () =>
        ({
          enabled: h.enabled,
          away: { mode: h.mode, standingPermissions: h.standing },
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
  const confirm = vi.fn(async () => false);
  const ctx = {
    mode,
    ui: { notify, select, custom, confirm },
    sessionManager: { getSessionId: () => "viewer" },
  };
  return {
    notify,
    select,
    custom,
    confirm,
    run: () => handler?.("", ctx) as Promise<void>,
  };
}

beforeEach(() => {
  h.standing = [];
  h.raw = null;
  resetSuggestions();
});

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

describe("standing-permission suggestion", () => {
  const CATEGORY = "delete build output";
  const card = { summary: "Deletes build output", category: CATEGORY };

  /** `count` earlier approvals of the category plus one open item "open". */
  async function seed(count: number, decision = "fine", daysAgo = 1) {
    for (let i = 0; i < count; i++) {
      await writeItem(
        item(`old${i}`, {
          kind: "allowed",
          card,
          session: { id: "s0", cwd: "/w" },
        }),
      );
      await writeDecision({
        version: 1,
        id: `old${i}`,
        decision: decision as "fine",
        decidedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        decidedBy: { kind: "inbox", sessionId: "x" },
      });
    }
    await writeItem(item("open", { card }));
  }

  function pickOpenThen(t: ReturnType<typeof setup>, action: string) {
    t.select
      .mockImplementationOnce(
        async (_t: string, options: string[]) => options[0],
      )
      .mockImplementationOnce(async () => action);
  }

  it("asks after the 5th approval and saves to the global config on yes", async () => {
    await seed(4);
    h.raw = {
      away: { mode: "auto", standingPermissions: ["other"] },
      enabled: true,
    };
    const t = setup("rpc");
    t.confirm.mockResolvedValueOnce(true);
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.confirm).toHaveBeenCalledWith(
      expect.any(String),
      `Add standing permission: "${CATEGORY}"?`,
    );
    expect(configLoader.save).toHaveBeenCalledWith("global", {
      enabled: true,
      away: { mode: "auto", standingPermissions: ["other", CATEGORY] },
    });
  });

  it("does not ask below 5, for rejects, for old approvals or when already standing", async () => {
    await seed(3);
    let t = setup("rpc");
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(t.confirm).not.toHaveBeenCalled();

    // 4 earlier + a reject: not a positive decision.
    await seed(4);
    resetSuggestions();
    t = setup("rpc");
    await writeItem(item("open2", { card }));
    pickOpenThen(t, "Reject");
    await t.run();
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("does not count approvals older than 14 days", async () => {
    await seed(4, "fine", 15);
    const t = setup("rpc");
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("does not ask when the category is already a standing permission", async () => {
    await seed(4);
    h.standing = [CATEGORY];
    const t = setup("rpc");
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("ignores items without a category", async () => {
    for (let i = 0; i < 6; i++) {
      await writeItem(item(`n${i}`, { kind: "allowed" }));
      await writeDecision({
        version: 1,
        id: `n${i}`,
        decision: "fine",
        decidedAt: new Date().toISOString(),
        decidedBy: { kind: "inbox", sessionId: "x" },
      });
    }
    await writeItem(item("open"));
    const t = setup("rpc");
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(t.confirm).not.toHaveBeenCalled();
  });

  it("tells the user when saving the standing permission fails", async () => {
    await seed(4);
    vi.mocked(configLoader.save).mockRejectedValueOnce(new Error("disk full"));
    const t = setup("rpc");
    t.confirm.mockResolvedValueOnce(true);
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(
      t.notify.mock.calls.some(([m]) => String(m).includes("disk full")),
    ).toBe(true);
  });

  it("a no is not asked again for that category this session", async () => {
    await seed(4);
    const t = setup("rpc");
    pickOpenThen(t, "Approve once");
    await t.run();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(configLoader.save).not.toHaveBeenCalled();

    await writeItem(item("open3", { card }));
    const again = setup("rpc");
    pickOpenThen(again, "Approve once");
    await again.run();
    expect(again.confirm).not.toHaveBeenCalled();
  });

  it("asks again in another session", async () => {
    await seed(4);
    const t = setup("rpc");
    pickOpenThen(t, "Approve once");
    await t.run();
    resetSuggestions();
    await writeItem(item("open4", { card }));
    const next = setup("rpc");
    pickOpenThen(next, "Approve once");
    await next.run();
    expect(next.confirm).toHaveBeenCalledTimes(1);
  });

  it("tui: asks only after the inbox view has closed", async () => {
    await seed(4);
    const t = setup("tui");
    const order: string[] = [];
    t.confirm.mockImplementationOnce(async () => {
      order.push("confirm");
      return false;
    });
    t.custom.mockImplementationOnce(async (factory: unknown) => {
      const make = factory as (
        tui: unknown,
        theme: unknown,
        kb: unknown,
        done: () => void,
      ) => { handleInput(data: string): void };
      const theme = {
        fg: (_c: string, x: string) => x,
        bold: (x: string) => x,
      };
      let finished: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const view = make({ requestRender: () => undefined }, theme, {}, () => {
        order.push("closed");
        finished();
      });
      await new Promise((r) => setTimeout(r, 20));
      view.handleInput("a");
      await new Promise((r) => setTimeout(r, 20));
      view.handleInput("\u001b");
      await closed;
    });
    await t.run();
    expect(order).toEqual(["closed", "confirm"]);
  });
});
