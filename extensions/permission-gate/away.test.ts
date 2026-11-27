import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionKey } from "../../src/core/away";
import { registerAdvisor } from "../../src/shared/away/advisor";
import { readItems } from "../../src/shared/away/inbox";
import {
  DEFERRED,
  DENIED_SUFFIX,
  NUDGE,
  PAUSED_HOLD,
  REPEAT_DENIED,
  REPEAT_QUEUED,
} from "../../src/shared/away/messages";
import {
  clearAwayState,
  getAwayState,
  setPresence,
} from "../../src/shared/away/state";
import type { GuardrailsAdvisor } from "../../src/shared/away/types";
import type { ResolvedConfig } from "../../src/shared/config";
import {
  type GuardrailsDelegate,
  registerDelegate,
} from "../../src/shared/delegation";
import {
  GUARDRAILS_ACTION_BLOCKED_EVENT,
  GUARDRAILS_ADVISOR_REQUEST_EVENT,
  GUARDRAILS_AWAY_ITEM_EVENT,
  GUARDRAILS_AWAY_PAUSED_EVENT,
  GUARDRAILS_PRESENCE_CHANGED_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_TRIPWIRE_EVENT,
} from "../../src/shared/events";
import permissionGate from "./index";

const h = vi.hoisted(() => ({
  away: {} as Record<string, unknown>,
  autoDeny: [] as string[],
  allowed: [] as string[],
  requireConfirmation: true,
  hasAway: true,
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
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(
      () =>
        ({
          enabled: true,
          features: { permissionGate: true },
          delegation: { timeoutMs: 1000 },
          prompts: { inputGuardMs: 0 },
          ...(h.hasAway ? { away: { ...baseAway, ...h.away } } : {}),
          permissionGate: {
            patterns: [
              { pattern: "dangerous-cmd", description: "test danger" },
            ],
            useBuiltinMatchers: false,
            requireConfirmation: h.requireConfirmation,
            allowedPatterns: h.allowed.map((pattern) => ({ pattern })),
            autoDenyPatterns: h.autoDeny.map((pattern) => ({ pattern })),
          },
        }) as unknown as ResolvedConfig,
    ),
  },
}));

// biome-ignore lint/suspicious/noExplicitAny: loosely typed event payloads in tests
type Loose = any;

type Answer = ReturnType<GuardrailsDelegate["decide"]>;

interface SetupOptions {
  delegates?: Array<{
    id?: string;
    watch?: boolean;
    decide: GuardrailsDelegate["decide"];
  }>;
  advisors?: Array<GuardrailsAdvisor["advise"]>;
  hasUI?: boolean;
  custom?: (factory: unknown) => Promise<unknown>;
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
  } as unknown as ExtensionAPI;

  const specs = (options.delegates ?? []).map((spec, index) => {
    const decide = vi.fn(spec.decide);
    registerDelegate(pi, {
      id: spec.id ?? `d${index}`,
      name: spec.id ?? `d${index}`,
      ...(spec.watch ? { watch: true } : {}),
      decide,
    });
    return decide;
  });
  (options.advisors ?? []).forEach((advise, index) => {
    registerAdvisor(pi, {
      id: `a${index}`,
      name: `a${index}`,
      advise: vi.fn(advise),
    });
  });
  await permissionGate(pi);

  const custom = vi.fn(options.custom ?? (async () => "allow"));
  const ctx = {
    cwd: "/workspace",
    hasUI: options.hasUI ?? true,
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
    paused: seen(GUARDRAILS_AWAY_PAUSED_EVENT),
    presence: seen(GUARDRAILS_PRESENCE_CHANGED_EVENT),
    tripwire: seen(GUARDRAILS_TRIPWIRE_EVENT),
    closed: seen(GUARDRAILS_PROMPT_CLOSED_EVENT),
    park: seen("pi-live:park"),
  };

  const toolCall = handlers.get("tool_call") as unknown as (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ) => Promise<Loose>;
  const run = (command: string) =>
    toolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command },
      } as ToolCallEvent,
      ctx,
    );
  return { run, ctx, custom, specs, events, bus, pi };
}

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

async function firstItem() {
  const items = await readItems();
  return items[0];
}

async function itemCount() {
  const items = await readItems();
  return items.length;
}

async function expectNoItems() {
  const items = await readItems();
  expect(items).toEqual([]);
}

beforeEach(() => {
  h.away = {};
  h.autoDeny = [];
  h.allowed = [];
  h.requireConfirmation = true;
  h.hasAway = true;
  clearAwayState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("away mode off", () => {
  it("behaves as before and writes nothing", async () => {
    h.away = { mode: "off" };
    const { run, custom, events } = await setup({
      delegates: [{ decide: () => ask() }],
    });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
    await expectNoItems();
    expect(events.item).toEqual([]);
    expect(events.presence).toEqual([]);
    expect(events.paused).toEqual([]);
    expect(events.closed[0]).not.toHaveProperty("by");
  });

  it("does not create the advisor roster", async () => {
    h.away = { mode: "off" };
    const { run, bus } = await setup();
    const emit = vi.spyOn(bus, "emit");
    await run("dangerous-cmd");
    expect(emit).not.toHaveBeenCalledWith(
      GUARDRAILS_ADVISOR_REQUEST_EVENT,
      expect.anything(),
    );
  });

  it("works when the config has no away section", async () => {
    h.hasAway = false;
    const { run, custom } = await setup();
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
  });
});

describe("always mode", () => {
  it("defers a flagged command without delegates and never prompts", async () => {
    const { run, custom, events } = await setup();
    const result = await run("dangerous-cmd");
    expect(result).toEqual({ block: true, reason: DEFERRED });
    expect(custom).not.toHaveBeenCalled();
    const items = await readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "waiting",
      cause: "away",
      risk: "high",
      action: { kind: "command", command: "dangerous-cmd" },
      session: { id: "s1", cwd: "/workspace" },
    });
    expect(events.item).toHaveLength(1);
    expect(events.blocked[0].block.source).toBe("deferred");
    const state = getAwayState("s1");
    expect(state.memory.get(actionKey(events.blocked[0].action))).toEqual({
      outcome: "deferred",
      itemId: items[0].id,
    });
    expect(state.blocked).toHaveLength(1);
  });

  it("lets safe commands through with no delegates", async () => {
    const { run } = await setup();
    await expect(run("echo hi")).resolves.toBeUndefined();
    await expectNoItems();
  });

  it("allows when a delegate allows, without an item", async () => {
    const { run, custom } = await setup({
      delegates: [{ decide: () => allow }],
    });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
    await expectNoItems();
  });

  it("allows an unsure low-risk action and records an allowed item", async () => {
    const { run, events } = await setup({
      delegates: [
        {
          decide: () =>
            ask({ risk: "low", card: { summary: "Cleans build output" } }),
        },
      ],
    });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    const items = await readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "allowed",
      risk: "low",
      card: { summary: "Cleans build output" },
    });
    expect(events.item).toHaveLength(1);
    expect(getAwayState("s1").memory.size).toBe(0);
  });

  it("defers an unsure low-risk action when lowRisk is defer", async () => {
    h.away = { lowRisk: "defer" };
    const { run } = await setup({
      delegates: [{ decide: () => ask({ risk: "low" }) }],
    });
    const result = await run("dangerous-cmd");
    expect(result.reason).toBe(DEFERRED);
    const got1 = await firstItem();
    expect(got1).toMatchObject({
      kind: "waiting",
      risk: "low",
    });
  });

  it("defers when risk is high or unstated", async () => {
    for (const answer of [ask({ risk: "high" }), ask()]) {
      clearAwayState();
      const { run } = await setup({ delegates: [{ decide: () => answer }] });
      const result = await run("dangerous-cmd");
      expect(result.reason).toBe(DEFERRED);
    }
  });

  it("never lets a never-low-risk command through, even if a delegate says low", async () => {
    h.away = { lowRisk: "allow" };
    const { run } = await setup({
      delegates: [{ decide: () => ask({ risk: "low" }) }],
    });
    // "sudo dangerous-cmd" matches the dangerous pattern and the floor.
    const result = await run("sudo dangerous-cmd");
    expect(result.reason).toBe(DEFERRED);
    const got2 = await firstItem();
    expect(got2).toMatchObject({
      kind: "waiting",
      risk: "high",
    });
  });

  it("blocks with the denied suffix when a delegate blocks, no item", async () => {
    const { run, events } = await setup({
      delegates: [{ decide: () => block() }],
    });
    const result = await run("dangerous-cmd");
    expect(result.block).toBe(true);
    expect(result.reason).toContain("nope");
    expect(result.reason).toContain(DENIED_SUFFIX);
    expect(result.terminate).toBeUndefined();
    await expectNoItems();
    expect(events.blocked[0].block.source).toBe("delegate");
    expect(getAwayState("s1").blocked[0]).toMatchObject({
      outcome: "denied",
    });
  });

  it("auto-deny patterns block as before and count as a denial", async () => {
    h.autoDeny = ["dangerous-cmd"];
    const { run, events } = await setup();
    const result = await run("dangerous-cmd now");
    expect(result.block).toBe(true);
    expect(events.blocked[0].block.source).toBe("permission");
    expect(getAwayState("s1").blocked).toHaveLength(1);
  });

  it("warn-only mode (requireConfirmation false) just notifies", async () => {
    h.requireConfirmation = false;
    const { run, ctx } = await setup();
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalled();
    await expectNoItems();
  });

  it("an allowed pattern wins before anything else", async () => {
    h.allowed = ["dangerous-cmd"];
    const { run } = await setup({ delegates: [{ decide: () => block() }] });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
  });

  it("a once-grant lets the action run exactly once", async () => {
    const { run } = await setup();
    const key = actionKey({
      kind: "command",
      command: "dangerous-cmd",
      origin: "bash",
    });
    getAwayState("s1").onceGrants.add(key);
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    const second = await run("dangerous-cmd");
    expect(second.block).toBe(true);
  });

  describe("tripwire", () => {
    it("writes an urgent item, pauses, terminates and holds later calls", async () => {
      const { run, events } = await setup({
        delegates: [{ decide: () => block({ severe: true }) }],
      });
      const result = await run("dangerous-cmd");
      expect(result.block).toBe(true);
      expect(result.terminate).toBe(true);
      expect(result.reason).toContain("Guardrails paused this run");
      const items = await readItems();
      expect(items[0]).toMatchObject({ kind: "urgent", cause: "tripwire" });
      expect(events.tripwire).toHaveLength(1);
      expect(events.paused).toContainEqual(
        expect.objectContaining({ paused: true }),
      );
      expect(getAwayState("s1").paused).toBeDefined();

      const next = await run("echo anything");
      expect(next).toEqual({
        block: true,
        reason: PAUSED_HOLD,
        terminate: true,
      });
      expect(events.blocked.at(-1).block.source).toBe("paused");
    });

    it("applies when the user is present too", async () => {
      h.away = { mode: "auto" };
      const { run, custom } = await setup({
        delegates: [{ decide: () => block({ severe: true }) }],
      });
      const result = await run("dangerous-cmd");
      expect(result.terminate).toBe(true);
      expect(custom).not.toHaveBeenCalled();
      const got3 = await firstItem();
      expect(got3).toMatchObject({ kind: "urgent" });
    });
  });

  describe("repeat", () => {
    it("tells the agent a deferred action is already queued, no second item", async () => {
      const { run, events } = await setup();
      await run("dangerous-cmd");
      const again = await run("dangerous-cmd");
      expect(again).toEqual({ block: true, reason: REPEAT_QUEUED });
      const got4 = await itemCount();
      expect(got4).toBe(1);
      expect(events.blocked.at(-1).block.source).toBe("repeat");
      expect(getAwayState("s1").blocked).toHaveLength(1);
    });

    it("tells the agent a denied action is already denied", async () => {
      const { run, specs } = await setup({
        delegates: [{ decide: () => block() }],
      });
      await run("dangerous-cmd");
      const again = await run("dangerous-cmd");
      expect(again).toEqual({ block: true, reason: REPEAT_DENIED });
      expect(specs[0]).toHaveBeenCalledTimes(1);
    });

    it("refills the watch window", async () => {
      const { run } = await setup();
      await run("dangerous-cmd");
      const state = getAwayState("s1");
      state.watchRemaining = 0;
      await run("dangerous-cmd");
      expect(state.watchRemaining).toBe(3);
    });
  });

  describe("ladder", () => {
    it("nudges when stuck and no advisor answers", async () => {
      h.away = { stuckBlocks: 2 };
      const { run } = await setup();
      await run("dangerous-cmd 1");
      const stuck = await run("dangerous-cmd 2");
      expect(stuck.reason).toBe(`${DEFERRED}\n\n${NUDGE}`);
      expect(stuck.terminate).toBeUndefined();
    });

    it("adds an advisor's advice", async () => {
      h.away = { stuckBlocks: 2 };
      const { run } = await setup({
        advisors: [() => ({ action: "advise", message: "try the tests" })],
      });
      await run("dangerous-cmd 1");
      const stuck = await run("dangerous-cmd 2");
      expect(stuck.reason).toBe(`${DEFERRED}\n\nSupervisor: try the tests`);
    });

    it("pauses when an advisor says so", async () => {
      h.away = { stuckBlocks: 2 };
      const { run, events } = await setup({
        advisors: [() => ({ action: "pause", reason: "going in circles" })],
      });
      await run("dangerous-cmd 1");
      const stuck = await run("dangerous-cmd 2");
      expect(stuck.terminate).toBe(true);
      expect(stuck.reason).toContain("going in circles");
      expect(events.paused).toContainEqual(
        expect.objectContaining({ paused: true }),
      );
    });

    it("pauses when stuck again after the nudge", async () => {
      h.away = { stuckBlocks: 2 };
      const { run } = await setup();
      await run("dangerous-cmd 1");
      await run("dangerous-cmd 2");
      await run("dangerous-cmd 3");
      const again = await run("dangerous-cmd 4");
      expect(again.terminate).toBe(true);
      expect(again.reason).toContain("kept getting blocked");
    });

    it("pauses at the block limit", async () => {
      h.away = { maxBlocks: 2 };
      const { run } = await setup();
      await run("dangerous-cmd 1");
      const limit = await run("dangerous-cmd 2");
      expect(limit.terminate).toBe(true);
      expect(limit.reason).toContain("too many blocked actions (2)");
    });
  });

  describe("watch window", () => {
    it("asks watch delegates about unflagged commands after a denial", async () => {
      const watcher = vi.fn((_request: unknown) => allow);
      const plain = vi.fn((_request: unknown) => allow);
      const { run, specs } = await setup({
        delegates: [
          { id: "main", decide: () => block() },
          { id: "watcher", watch: true, decide: watcher },
          { id: "plain", decide: plain },
        ],
      });
      await run("dangerous-cmd");
      // watcher saw the flagged command's request too; reset counts.
      watcher.mockClear();
      plain.mockClear();
      specs[0].mockClear();
      await expect(run("echo hi")).resolves.toBeUndefined();
      expect(watcher).toHaveBeenCalledOnce();
      expect(plain).not.toHaveBeenCalled();
      expect(specs[0]).not.toHaveBeenCalled();
      const request = watcher.mock.calls[0][0] as Loose;
      expect(request.watch.blocked).toHaveLength(1);
      expect(request.action).toMatchObject({ command: "echo hi" });
    });

    it("blocks an unflagged command a watch delegate blocks", async () => {
      const { run, events } = await setup({
        delegates: [
          {
            watch: true,
            decide: (request: Loose) =>
              request.action.command === "echo bad" ? block() : undefined,
          },
        ],
      });
      // A first denial opens the window (auto-deny).
      h.autoDeny = ["dangerous-cmd"];
      await run("dangerous-cmd");
      await expect(run("echo fine")).resolves.toBeUndefined();
      const result = await run("echo bad");
      expect(result.block).toBe(true);
      expect(result.reason).toContain(DENIED_SUFFIX);
      expect(events.blocked.at(-1).block.source).toBe("delegate");
    });

    it("lets unflagged commands run on ask or abstain", async () => {
      h.autoDeny = ["dangerous-cmd"];
      const { run } = await setup({
        delegates: [{ watch: true, decide: () => ask() }],
      });
      await run("dangerous-cmd");
      await expect(run("echo hi")).resolves.toBeUndefined();
    });

    it("counts down and stops after watchCommands commands", async () => {
      h.autoDeny = ["dangerous-cmd"];
      const watcher = vi.fn((_request: unknown) => allow);
      const { run } = await setup({
        delegates: [{ watch: true, decide: watcher }],
      });
      await run("dangerous-cmd");
      for (let i = 0; i < 5; i++) await run(`echo ${i}`);
      expect(watcher).toHaveBeenCalledTimes(3);
      expect(getAwayState("s1").watchRemaining).toBe(0);
    });

    it("attaches the watch context to flagged commands in the window", async () => {
      h.autoDeny = ["first"];
      h.autoDeny.push();
      const decide = vi.fn((_request: unknown) => allow);
      const { run } = await setup({ delegates: [{ decide }] });
      getAwayState("s1", { mode: "always", stuckBlocks: 3, maxBlocks: 50 });
      // Denial opens the window (first is auto-denied; pattern is not flagged).
      await run("first");
      await run("dangerous-cmd");
      const request = decide.mock.calls[0][0] as Loose;
      expect(request.watch.blocked).toHaveLength(1);
    });
  });

  it("passes standing permissions to delegates", async () => {
    h.away = { standingPermissions: ["Deleting build output is fine"] };
    const decide = vi.fn((_request: unknown) => allow);
    const { run } = await setup({ delegates: [{ decide }] });
    await run("dangerous-cmd");
    expect((decide.mock.calls[0][0] as Loose).standingPermissions).toEqual([
      "Deleting build output is fine",
    ]);
  });

  it("omits standing permissions when none are set", async () => {
    const decide = vi.fn((_request: unknown) => allow);
    const { run } = await setup({ delegates: [{ decide }] });
    await run("dangerous-cmd");
    expect(decide.mock.calls[0][0]).not.toHaveProperty("standingPermissions");
  });
});

describe("high-risk allows while away", () => {
  const allowHigh: Answer = {
    verdict: "allow",
    reason: "user asked to install jq",
    risk: "high",
    card: { summary: "Installs jq" },
  };

  it("records an allowed item and runs the command when a delegate allows with risk high", async () => {
    h.away = { mode: "always" };
    const { run, custom, events } = await setup({
      delegates: [{ decide: () => allowHigh }],
    });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
    const items = await readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "allowed",
      cause: "away",
      risk: "high",
      reason: "d0: user asked to install jq",
      card: { summary: "Installs jq" },
      action: { kind: "command", command: "dangerous-cmd" },
    });
    expect(events.item).toHaveLength(1);
    expect(events.blocked).toEqual([]);
    expect(getAwayState("s1").blocked).toEqual([]);
  });

  it("records an allowed item for a never-low-risk command even without a risk", async () => {
    h.away = { mode: "always" };
    const { run } = await setup({ delegates: [{ decide: () => allow }] });
    await expect(run("sudo dangerous-cmd")).resolves.toBeUndefined();
    const items = await readItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "allowed", risk: "high" });
  });

  it("writes nothing for a low or absent risk allow", async () => {
    h.away = { mode: "always" };
    const low = await setup({
      delegates: [{ decide: () => ({ ...allow, risk: "low" }) }],
    });
    await low.run("dangerous-cmd");
    await expectNoItems();
    const none = await setup({ delegates: [{ decide: () => allow }] });
    await none.run("dangerous-cmd");
    await expectNoItems();
  });

  it("uses cause headless without a UI in auto mode", async () => {
    h.away = { mode: "auto" };
    const { run } = await setup({
      hasUI: false,
      delegates: [{ decide: () => allowHigh }],
    });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    const item = await firstItem();
    expect(item).toMatchObject({ kind: "allowed", cause: "headless" });
  });

  it("records it in auto mode once the user is away", async () => {
    h.away = { mode: "auto" };
    const { run, pi } = await setup({
      delegates: [{ decide: () => allowHigh }],
    });
    setPresence(pi, getAwayState("s1"), "away", "command");
    await run("dangerous-cmd");
    const item = await firstItem();
    expect(item).toMatchObject({ kind: "allowed", cause: "away" });
  });

  it("writes nothing while the user is present", async () => {
    h.away = { mode: "auto" };
    const { run } = await setup({ delegates: [{ decide: () => allowHigh }] });
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    await expectNoItems();
  });

  it("writes nothing when away mode is off", async () => {
    h.away = { mode: "off" };
    const { run, events } = await setup({
      delegates: [{ decide: () => allowHigh }],
    });
    await expect(run("sudo dangerous-cmd")).resolves.toBeUndefined();
    await expectNoItems();
    expect(events.item).toEqual([]);
  });

  it("does not record watch-only checks that allow", async () => {
    h.away = { mode: "always" };
    const { run } = await setup({
      delegates: [{ watch: true, decide: () => allowHigh }],
    });
    getAwayState("s1").watchRemaining = 3;
    await expect(run("sudo echo hi")).resolves.toBeUndefined();
    await expectNoItems();
  });
});

describe("auto mode", () => {
  beforeEach(() => {
    h.away = { mode: "auto" };
  });

  it("prompts the user when present and applies the answer", async () => {
    const { run, custom, events } = await setup();
    await expect(run("dangerous-cmd")).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledOnce();
    await expectNoItems();
    expect(events.closed).toHaveLength(1);
  });

  it("denies when the user denies, with no inbox item", async () => {
    const { run } = await setup({ custom: async () => "deny" });
    const result = await run("dangerous-cmd");
    expect(result).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    await expectNoItems();
    expect(getAwayState("s1").presence).toBe("present");
  });

  it("stops the run when the user chooses stop", async () => {
    const { run, ctx } = await setup({ custom: async () => "stop" });
    const result = await run("dangerous-cmd");
    expect(result.reason).toBe("User declined and stopped dangerous command");
    expect(ctx.abort).toHaveBeenCalled();
  });

  it("skips the prompt when a delegate allows", async () => {
    const { run, custom } = await setup({
      delegates: [{ decide: () => allow }],
    });
    await run("dangerous-cmd");
    expect(custom).not.toHaveBeenCalled();
  });

  it("prompts with the card when delegates are unsure", async () => {
    const { run, events } = await setup({
      delegates: [{ decide: () => ask({ card: { summary: "Cleans up" } }) }],
      custom: async (factory: Loose) =>
        new Promise((resolve) => {
          factory(
            { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() },
            { fg: (_c: string, t: string) => t, bold: (t: string) => t },
            {},
            resolve,
          );
        }),
    });
    const pending = run("dangerous-cmd");
    await vi.waitFor(() => expect(events.park).toHaveLength(1));
    expect(events.park[0].view.card).toEqual({ summary: "Cleans up" });
    events.park[0].answer({ result: "deny" }, { connId: "1", name: "c" });
    await pending;
  });

  describe("prompt timeout", () => {
    function hangingPrompt() {
      return async (factory: Loose) =>
        new Promise((resolve) => {
          factory(
            { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() },
            { fg: (_c: string, t: string) => t, bold: (t: string) => t },
            {},
            resolve,
          );
        });
    }

    it("defers, marks the user away and closes the pi-live prompt with by timeout", async () => {
      vi.useFakeTimers();
      h.away = { mode: "auto", promptTimeoutMs: 60_000 };
      const accepted = vi.fn();
      const { run, events, bus } = await setup({ custom: hangingPrompt() });
      bus.on("pi-live:park", (request: Loose) => {
        request.accept({ close: accepted });
      });
      const pending = run("dangerous-cmd");
      await vi.advanceTimersByTimeAsync(0);
      expect(events.park).toHaveLength(1);
      expect(events.park[0].expiresAt).toBe(Date.now() + 60_000);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(result).toEqual({ block: true, reason: DEFERRED });
      expect(accepted).toHaveBeenCalledExactlyOnceWith({ by: "timeout" });
      expect(events.closed[0].by).toBe("timeout");
      expect(getAwayState("s1").presence).toBe("away");
      expect(events.presence).toContainEqual(
        expect.objectContaining({ presence: "away", cause: "timeout" }),
      );
      const got5 = await firstItem();
      expect(got5).toMatchObject({
        kind: "waiting",
        cause: "timeout",
      });
    });

    it("does not prompt again once the user is away", async () => {
      vi.useFakeTimers();
      h.away = { mode: "auto", promptTimeoutMs: 1000 };
      const { run, custom } = await setup({ custom: hangingPrompt() });
      const pending = run("dangerous-cmd");
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      const second = await run("dangerous-cmd other");
      expect(second.reason).toBe(DEFERRED);
      expect(custom).toHaveBeenCalledOnce();
    });

    it("a timed-out low-risk action is allowed and recorded as allowed", async () => {
      vi.useFakeTimers();
      h.away = { mode: "auto", promptTimeoutMs: 1000 };
      const { run } = await setup({
        custom: hangingPrompt(),
        delegates: [{ decide: () => ask({ risk: "low" }) }],
      });
      const pending = run("dangerous-cmd");
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBeUndefined();
      const got6 = await firstItem();
      expect(got6).toMatchObject({
        kind: "allowed",
        cause: "timeout",
      });
    });
  });

  it("a pi-live client answer closes with by client and marks the user present", async () => {
    const { run, events, bus } = await setup({
      custom: async (factory: Loose) =>
        new Promise((resolve) => {
          factory(
            { terminal: { rows: 40, columns: 80 }, requestRender: vi.fn() },
            { fg: (_c: string, t: string) => t, bold: (t: string) => t },
            {},
            resolve,
          );
        }),
    });
    const state = getAwayState("s1", {
      mode: "auto",
      stuckBlocks: 3,
      maxBlocks: 50,
    });
    state.presence = "present";
    const close = vi.fn();
    bus.on("pi-live:park", (request: Loose) => request.accept({ close }));
    const pending = run("dangerous-cmd");
    await vi.waitFor(() => expect(events.park).toHaveLength(1));
    events.park[0].answer({ result: "allow" }, { connId: "1", name: "phone" });
    await expect(pending).resolves.toBeUndefined();
    expect(events.closed[0].by).toBe("client");
    expect(close).toHaveBeenCalledWith({
      by: "client",
      client: { connId: "1", name: "phone" },
    });
    expect(state.presence).toBe("present");
    expect(events.presence).toEqual([]);
  });

  it("goes straight to the away rules when the user was already marked away", async () => {
    const { run, custom } = await setup();
    setPresence(
      { events: createEventBus() } as unknown as ExtensionAPI,
      getAwayState("s1", { mode: "auto", stuckBlocks: 3, maxBlocks: 50 }),
      "away",
      "command",
    );
    const result = await run("dangerous-cmd");
    expect(result.reason).toBe(DEFERRED);
    expect(custom).not.toHaveBeenCalled();
  });

  it("treats headless runs as away, with cause headless", async () => {
    const { run, custom } = await setup({ hasUI: false });
    const result = await run("dangerous-cmd");
    expect(result.reason).toBe(DEFERRED);
    expect(custom).not.toHaveBeenCalled();
    const got7 = await firstItem();
    expect(got7).toMatchObject({
      kind: "waiting",
      cause: "headless",
    });
  });

  it("a denial while present does not count toward the ladder or memory", async () => {
    const { run } = await setup({ custom: async () => "deny" });
    await run("dangerous-cmd");
    const state = getAwayState("s1");
    expect(state.ladder.blocksSinceAway).toBe(0);
    expect(state.memory.size).toBe(0);
    expect(state.blocked).toHaveLength(1);
  });
});
