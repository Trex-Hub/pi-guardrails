import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionKey } from "../../src/core/away";
import { readItems } from "../../src/shared/away/inbox";
import {
  DEFERRED,
  DENIED_SUFFIX,
  PAUSED_HOLD,
  REPEAT_DENIED,
  REPEAT_QUEUED,
} from "../../src/shared/away/messages";
import { clearAwayState, getAwayState } from "../../src/shared/away/state";
import type { ResolvedConfig } from "../../src/shared/config";
import {
  type GuardrailsDelegate,
  registerDelegate,
} from "../../src/shared/delegation";
import {
  GUARDRAILS_ACTION_BLOCKED_EVENT,
  GUARDRAILS_ADVISOR_REQUEST_EVENT,
  GUARDRAILS_AWAY_ITEM_EVENT,
  GUARDRAILS_PRESENCE_CHANGED_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_TRIPWIRE_EVENT,
} from "../../src/shared/events";
import pathAccess from "./index";

const h = vi.hoisted(() => ({
  away: {} as Record<string, unknown>,
  mode: "ask" as "ask" | "block" | "allow",
  hasAway: true,
  policies: [] as unknown[],
}));

const baseAway = {
  mode: "always",
  promptTimeoutMs: 120000,
  lowRisk: "allow",
  watchCommands: 3,
  stuckBlocks: 3,
  maxBlocks: 50,
  standingPermissions: [] as string[],
};

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    getProjectState: vi.fn(() => "trusted"),
    getRawConfig: vi.fn(() => null),
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(
      () =>
        ({
          enabled: true,
          features: { pathAccess: true },
          delegation: { timeoutMs: 1000 },
          prompts: { inputGuardMs: 0 },
          ...(h.hasAway ? { away: { ...baseAway, ...h.away } } : {}),
          policies: { rules: h.policies },
          pathAccess: {
            mode: h.mode,
            applyTo: "all",
            allowedPaths: [],
            alwaysScope: "local",
          },
        }) as unknown as ResolvedConfig,
    ),
  },
}));

vi.mock("./dynamic-resources", () => ({
  piDocumentationPaths: vi.fn(() => []),
}));

// biome-ignore lint/suspicious/noExplicitAny: loosely typed event payloads in tests
type Loose = any;
type Answer = ReturnType<GuardrailsDelegate["decide"]>;

const allow: Answer = { verdict: "allow", reason: "fine" };
const ask = (extra: object = {}): Answer => ({
  verdict: "ask",
  reason: "unsure",
  ...extra,
});
const block = (extra: object = {}): Answer => ({
  verdict: "block",
  reason: "nope",
  ...extra,
});

interface SetupOptions {
  decide?: GuardrailsDelegate["decide"];
  hasUI?: boolean;
  custom?: (factory: Loose) => Promise<unknown>;
}

async function setup(options: SetupOptions = {}) {
  const bus = createEventBus();
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    events: bus,
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler);
    }),
    appendEntry: vi.fn(),
    registerEntryRenderer: vi.fn(),
    exec: undefined,
  } as unknown as ExtensionAPI;
  const decide = vi.fn(options.decide ?? (() => undefined));
  if (options.decide) {
    registerDelegate(pi, { id: "d", name: "d", decide });
  }
  await pathAccess(pi);

  const custom = vi.fn(options.custom ?? (async () => "allow-file-once"));
  const ctx = {
    cwd: "/workspace",
    hasUI: options.hasUI ?? true,
    mode: "tui",
    signal: undefined,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
      getCwd: () => "/workspace",
    },
    modelRegistry: {},
    ui: { custom, notify: vi.fn(), select: vi.fn(), setWidget: vi.fn() },
    abort: vi.fn(),
  } as unknown as ExtensionContext;

  const seen = (event: string) => {
    const list: Loose[] = [];
    bus.on(event, (data) => list.push(data));
    return list;
  };
  const events = {
    blocked: seen(GUARDRAILS_ACTION_BLOCKED_EVENT),
    item: seen(GUARDRAILS_AWAY_ITEM_EVENT),
    presence: seen(GUARDRAILS_PRESENCE_CHANGED_EVENT),
    tripwire: seen(GUARDRAILS_TRIPWIRE_EVENT),
    closed: seen(GUARDRAILS_PROMPT_CLOSED_EVENT),
    park: seen("pi-live:park"),
  };
  const toolCall = handlers.get("tool_call") as unknown as (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ) => Promise<Loose>;
  const call = (toolName: string, input: Record<string, unknown>) =>
    toolCall(
      { type: "tool_call", toolCallId: "c1", toolName, input } as ToolCallEvent,
      ctx,
    );
  const read = (path = "/outside/secret.txt") => call("read", { path });
  const write = (path = "/outside/secret.txt") =>
    call("write", { path, content: "x" });
  return { read, write, call, ctx, custom, decide, events, bus };
}

async function items() {
  return readItems();
}

beforeEach(() => {
  h.away = {};
  h.mode = "ask";
  h.hasAway = true;
  h.policies = [];
  clearAwayState();
  // Bash path extraction only reports paths that exist.
  vol.fromJSON({
    "/outside/a.txt": "a",
    "/outside/b.txt": "b",
    "/tmp/a.txt": "a",
    "/tmp/b.txt": "b",
  });
});

describe("path access, away mode off", () => {
  it("keeps today's non-interactive block", async () => {
    h.away = { mode: "off" };
    const { read, events } = await setup({ hasUI: false });
    const result = await read();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("no UI to confirm");
    expect(events.blocked[0].block.source).toBe("nonInteractive");
    const written = await items();
    expect(written).toEqual([]);
    expect(events.item).toEqual([]);
  });

  it("prompts as before and emits no new fields or events", async () => {
    h.away = { mode: "off" };
    const { read, custom, events, bus } = await setup();
    const emit = vi.spyOn(bus, "emit");
    await expect(read()).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
    expect(events.closed[0]).not.toHaveProperty("by");
    expect(emit).not.toHaveBeenCalledWith(
      GUARDRAILS_ADVISOR_REQUEST_EVENT,
      expect.anything(),
    );
  });

  it("works without an away section", async () => {
    h.hasAway = false;
    const { read, custom } = await setup();
    await expect(read()).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
  });
});

describe("path access, always mode", () => {
  it("defers a path outside the workspace and lists it in the reason", async () => {
    const { read, custom, events } = await setup();
    const result = await read();
    expect(result).toEqual({
      block: true,
      reason: `${DEFERRED}\n/outside/secret.txt`,
    });
    expect(custom).not.toHaveBeenCalled();
    const written = await items();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "waiting",
      cause: "away",
      risk: "high",
      feature: "pathAccess",
      toolName: "read",
      action: { kind: "file", path: "/outside/secret.txt" },
    });
    expect(events.blocked[0].block.source).toBe("deferred");
    expect(events.item).toHaveLength(1);
  });

  it("lets paths inside the workspace through", async () => {
    const { read } = await setup();
    await expect(read("/workspace/a.txt")).resolves.toBeUndefined();
    const written = await items();
    expect(written).toEqual([]);
  });

  it("does nothing when pathAccess.mode is allow, and blocks as before on block", async () => {
    h.mode = "allow";
    const a = await setup();
    await expect(a.read()).resolves.toBeUndefined();
    h.mode = "block";
    const b = await setup();
    const result = await b.read();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("is blocked (outside working directory)");
    expect(b.events.blocked[0].block.source).toBe("policy");
  });

  it("allows when a delegate allows, no item", async () => {
    const { read } = await setup({ decide: () => allow });
    await expect(read()).resolves.toBeUndefined();
    const written = await items();
    expect(written).toEqual([]);
  });

  it("allows a low-risk read and records an allowed item", async () => {
    const { read } = await setup({ decide: () => ask({ risk: "low" }) });
    await expect(read()).resolves.toBeUndefined();
    const written = await items();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: "allowed", risk: "low" });
  });

  it("floors writes outside a temp dir to high risk", async () => {
    const { write } = await setup({ decide: () => ask({ risk: "low" }) });
    const result = await write();
    expect(result.reason).toBe(`${DEFERRED}\n/outside/secret.txt`);
    const written = await items();
    expect(written[0]).toMatchObject({ kind: "waiting", risk: "high" });
  });

  it("lets a low-risk write inside a temp dir through", async () => {
    const { write } = await setup({ decide: () => ask({ risk: "low" }) });
    await expect(write("/tmp/scratch/out.txt")).resolves.toBeUndefined();
    const written = await items();
    expect(written[0]).toMatchObject({ kind: "allowed" });
  });

  it("floors paths a policy rule matches to high risk", async () => {
    h.policies = [
      {
        id: "secrets",
        protection: "noAccess",
        patterns: [{ pattern: "/outside/secret.txt" }],
        onlyIfExists: false,
      },
    ];
    const { read } = await setup({ decide: () => ask({ risk: "low" }) });
    const result = await read();
    expect(result.reason).toBe(`${DEFERRED}\n/outside/secret.txt`);
    const other = await read("/outside/other.txt");
    expect(other).toBeUndefined();
  });

  it("blocks on a delegate block with the denied suffix and no item", async () => {
    const { read, events } = await setup({ decide: () => block() });
    const result = await read();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("nope");
    expect(result.reason).toContain(DENIED_SUFFIX);
    expect(events.blocked[0].block.source).toBe("delegate");
    const written = await items();
    expect(written).toEqual([]);
    expect(getAwayState("s1").blocked[0]).toMatchObject({ outcome: "denied" });
  });

  it("raises a tripwire on a severe block", async () => {
    const { read, events } = await setup({
      decide: () => block({ severe: true }),
    });
    const result = await read();
    expect(result.terminate).toBe(true);
    expect(events.tripwire).toHaveLength(1);
    expect(getAwayState("s1").paused).toBeDefined();
    const written = await items();
    expect(written[0]).toMatchObject({ kind: "urgent", cause: "tripwire" });
  });

  it("holds every handled tool while paused, even when mode is allow", async () => {
    const { read, call, events } = await setup();
    await read();
    const state = getAwayState("s1");
    state.paused = { reason: "x", since: new Date().toISOString() };
    h.mode = "allow";
    for (const [tool, input] of [
      ["read", { path: "/workspace/a" }],
      ["write", { path: "/workspace/a", content: "" }],
      ["bash", { command: "ls" }],
    ] as const) {
      const result = await call(tool, { ...input });
      expect(result).toEqual({
        block: true,
        reason: PAUSED_HOLD,
        terminate: true,
      });
    }
    expect(events.blocked.at(-1).block.source).toBe("paused");
    await expect(call("something_else", {})).resolves.toBeUndefined();
  });

  it("a once-grant lets the path run once", async () => {
    const { read } = await setup();
    getAwayState("s1").onceGrants.add(
      actionKey({ kind: "file", path: "/outside/secret.txt" }),
    );
    await expect(read()).resolves.toBeUndefined();
    const second = await read();
    expect(second.block).toBe(true);
  });

  describe("repeat", () => {
    it("a deferred path is already queued, no second item", async () => {
      const { read, events } = await setup();
      await read();
      const again = await read();
      expect(again).toEqual({ block: true, reason: REPEAT_QUEUED });
      const written = await items();
      expect(written).toHaveLength(1);
      expect(events.blocked.at(-1).block.source).toBe("repeat");
    });

    it("a denied path is already denied, delegates not asked again", async () => {
      const { read, decide } = await setup({ decide: () => block() });
      await read();
      const again = await read();
      expect(again).toEqual({ block: true, reason: REPEAT_DENIED });
      expect(decide).toHaveBeenCalledTimes(1);
    });

    it("refills the watch window", async () => {
      const { read } = await setup();
      await read();
      const state = getAwayState("s1");
      state.watchRemaining = 0;
      await read();
      expect(state.watchRemaining).toBe(3);
    });
  });

  describe("several paths in one call", () => {
    const two = "cat /outside/a.txt /outside/b.txt";

    it("blocks once, one waiting item per deferred path, one ladder block", async () => {
      const { call, events } = await setup();
      const result = await call("bash", { command: two });
      expect(result.block).toBe(true);
      expect(result.reason).toBe(`${DEFERRED}\n/outside/a.txt\n/outside/b.txt`);
      const written = await items();
      expect(written.map((item) => item.kind)).toEqual(["waiting", "waiting"]);
      expect(events.blocked).toHaveLength(1);
      expect(getAwayState("s1").ladder.blocksSinceAway).toBe(1);
    });

    it("writes no allowed items when the call is blocked", async () => {
      const { call } = await setup({
        decide: (request: Loose) =>
          request.action.path === "/tmp/a.txt" ? ask({ risk: "low" }) : ask(),
      });
      // bash can write, so only the temp-dir path can be low risk.
      const result = await call("bash", {
        command: "cat /tmp/a.txt /outside/b.txt",
      });
      expect(result.reason).toBe(`${DEFERRED}\n/outside/b.txt`);
      const written = await items();
      expect(written.map((item) => item.kind)).toEqual(["waiting"]);
    });

    it("lets the call run and writes allowed items when all paths are low risk", async () => {
      const { call } = await setup({
        decide: () => ask({ risk: "low" }),
      });
      // bash is not read-only: use temp dirs so the floor doesn't apply.
      await expect(
        call("bash", { command: "cat /tmp/a.txt /tmp/b.txt" }),
      ).resolves.toBeUndefined();
      const written = await items();
      expect(written.map((item) => item.kind)).toEqual(["allowed", "allowed"]);
    });

    it("keeps once-grants when another path blocks the call", async () => {
      const { call } = await setup();
      const state = getAwayState("s1");
      const key = actionKey({ kind: "file", path: "/outside/a.txt" });
      state.onceGrants.add(key);
      const result = await call("bash", { command: two });
      expect(result.reason).toBe(`${DEFERRED}\n/outside/b.txt`);
      expect(state.onceGrants.has(key)).toBe(true);
    });

    it("asks delegates once per path with one watch tick", async () => {
      const { call, decide } = await setup({ decide: () => allow });
      const state = getAwayState("s1", {
        mode: "always",
        stuckBlocks: 3,
        maxBlocks: 50,
      });
      state.watchRemaining = 2;
      await call("bash", { command: two });
      expect(decide).toHaveBeenCalledTimes(2);
      expect(state.watchRemaining).toBe(1);
      expect(decide.mock.calls[0][0]).toHaveProperty("watch");
    });
  });

  it("passes standing permissions to delegates when set", async () => {
    h.away = { standingPermissions: ["Reading logs is fine"] };
    const { read, decide } = await setup({ decide: () => allow });
    await read();
    expect(decide.mock.calls[0][0]).toMatchObject({
      standingPermissions: ["Reading logs is fine"],
    });
  });

  it("counts a block toward the stuck ladder and nudges", async () => {
    h.away = { stuckBlocks: 2 };
    const { read } = await setup();
    await read("/outside/1");
    const stuck = await read("/outside/2");
    expect(stuck.reason).toContain("Several actions in a row");
  });
});

describe("path access, auto mode", () => {
  beforeEach(() => {
    h.away = { mode: "auto" };
  });

  function hanging() {
    return async (factory: Loose) =>
      new Promise((resolve) => {
        factory(
          { terminal: { columns: 100 }, requestRender: vi.fn() },
          {
            fg: (_c: string, t: string) => t,
            bg: (_c: string, t: string) => t,
            bold: (t: string) => t,
          },
          undefined,
          resolve,
        );
      });
  }

  it("prompts when present and proceeds on allow once", async () => {
    const { read, custom } = await setup();
    await expect(read()).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
    const written = await items();
    expect(written).toEqual([]);
  });

  it("blocks with the user's denial and no item", async () => {
    const { read } = await setup({ custom: async () => "deny" });
    const result = await read();
    expect(result).toEqual({
      block: true,
      reason: "User denied access outside working directory",
    });
    const written = await items();
    expect(written).toEqual([]);
    expect(getAwayState("s1").ladder.blocksSinceAway).toBe(0);
  });

  it("without a UI goes through delegation and the away rules (headless)", async () => {
    const { read, custom, decide } = await setup({
      hasUI: false,
      decide: () => ask(),
    });
    const result = await read();
    expect(result.reason).toBe(`${DEFERRED}\n/outside/secret.txt`);
    expect(custom).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalled();
    const written = await items();
    expect(written[0]).toMatchObject({ cause: "headless" });
  });

  it("without a UI a delegate allow still lets the call through", async () => {
    const { read } = await setup({ hasUI: false, decide: () => allow });
    await expect(read()).resolves.toBeUndefined();
  });

  it("without a UI and pathAccess.mode block, still blocks", async () => {
    h.mode = "block";
    const { read } = await setup({ hasUI: false });
    const result = await read();
    expect(result.reason).toContain("is blocked (outside working directory)");
  });

  it("a prompt timeout marks the user away and defers every remaining path without prompting", async () => {
    vi.useFakeTimers();
    try {
      h.away = { mode: "auto", promptTimeoutMs: 60_000 };
      const { call, custom, events } = await setup({ custom: hanging() });
      const pending = call("bash", {
        command: "cat /outside/a.txt /outside/b.txt",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.park).toHaveLength(1);
      expect(events.park[0].expiresAt).toBe(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(result.reason).toBe(`${DEFERRED}\n/outside/a.txt\n/outside/b.txt`);
      expect(custom).toHaveBeenCalledOnce();
      expect(events.closed[0].by).toBe("timeout");
      expect(getAwayState("s1").presence).toBe("away");
      expect(events.presence).toContainEqual(
        expect.objectContaining({ presence: "away", cause: "timeout" }),
      );
      const written = await items();
      expect(written.map((item) => item.cause)).toEqual(["timeout", "timeout"]);
      expect(getAwayState("s1").ladder.blocksSinceAway).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
