import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { vol } from "memfs";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { actionKey } from "../../src/core/away";
import {
  type InboxDecision,
  type InboxItem,
  inboxDir,
  readDecisions,
  sessionsDir,
  writeDecision,
  writeItem,
} from "../../src/shared/away/inbox";
import { PAUSED_HOLD } from "../../src/shared/away/messages";
import {
  clearAwayState,
  getAwayState,
  pauseRun,
  setPresence,
} from "../../src/shared/away/state";
import { configLoader, type ResolvedConfig } from "../../src/shared/config";
import {
  emitAwayItem,
  GUARDRAILS_ACTION_BLOCKED_EVENT,
  GUARDRAILS_AWAY_ITEM_EVENT,
  GUARDRAILS_AWAY_PAUSED_EVENT,
  GUARDRAILS_PRESENCE_CHANGED_EVENT,
} from "../../src/shared/events";
import type { PiLiveRequest } from "../../src/shared/pi-live";
import away from "./index";

const h = vi.hoisted(() => ({
  mode: "auto" as "off" | "auto" | "always",
  enabled: true,
  hasAway: true,
}));

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    loadProject: vi.fn(async () => undefined),
    getProjectState: vi.fn(() => "trusted"),
    getRawConfig: vi.fn(() => null),
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(
      () =>
        ({
          enabled: h.enabled,
          ...(h.hasAway
            ? {
                away: {
                  mode: h.mode,
                  promptTimeoutMs: 120000,
                  lowRisk: "allow",
                  watchCommands: 3,
                  stuckBlocks: 3,
                  maxBlocks: 50,
                  standingPermissions: [],
                },
              }
            : {}),
        }) as unknown as ResolvedConfig,
    ),
  },
}));

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
  pi: ExtensionAPI;
  bus: ReturnType<typeof createEventBus>;
  ctx: ExtensionContext;
  setStatus: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  stopInput: ReturnType<typeof vi.fn>;
  onTerminalInput: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  emitted: Array<{ channel: string; data: unknown }>;
  parked: Array<{
    request: PiLiveRequest;
    ticket: { close: ReturnType<typeof vi.fn> };
  }>;
  fire: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown>;
  command: (args: string) => Promise<void>;
  keypress: () => void;
  idle: boolean;
  entries: unknown[];
}

function makeCtx(
  h2: { idle: boolean; entries: unknown[] },
  sessionId: string,
  extra: { hasUI?: boolean; mode?: string } = {},
) {
  const setStatus = vi.fn();
  const notify = vi.fn();
  const stopInput = vi.fn();
  const inputs: Array<() => unknown> = [];
  const onTerminalInput = vi.fn((fn: () => unknown) => {
    inputs.push(fn);
    return stopInput;
  });
  const ctx = {
    cwd: "/work",
    hasUI: extra.hasUI ?? true,
    mode: extra.mode ?? "tui",
    ui: { setStatus, notify, onTerminalInput },
    isIdle: () => h2.idle,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getSessionName: () => undefined,
      getCwd: () => "/work",
      getEntries: () => h2.entries,
    },
  } as unknown as ExtensionContext;
  return { ctx, setStatus, notify, stopInput, onTerminalInput, inputs };
}

async function boot(
  extra: { hasUI?: boolean; mode?: string; session?: string } = {},
): Promise<Harness> {
  const bus = createEventBus();
  const handlers = new Map<string, Handler[]>();
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const sendMessage = vi.fn();
  const appendEntry = vi.fn();
  const emitted: Harness["emitted"] = [];
  const parked: Harness["parked"] = [];
  bus.on("pi-live:park", (data) => {
    const request = data as PiLiveRequest;
    const ticket = { close: vi.fn() };
    parked.push({ request, ticket });
    request.accept(ticket);
  });
  const emit = bus.emit.bind(bus);
  bus.emit = (channel: string, data: unknown) => {
    emitted.push({ channel, data });
    emit(channel, data);
  };
  const pi = {
    events: bus,
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerCommand: vi.fn(
      (
        _name: string,
        options: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        command = options.handler;
      },
    ),
    sendMessage,
    appendEntry,
  } as unknown as ExtensionAPI;
  const shared = { idle: true, entries: [] as unknown[] };
  const made = makeCtx(shared, extra.session ?? "s1", extra);
  await away(pi);
  const harness: Harness = {
    pi,
    bus,
    ctx: made.ctx,
    setStatus: made.setStatus,
    notify: made.notify,
    stopInput: made.stopInput,
    onTerminalInput: made.onTerminalInput,
    sendMessage,
    appendEntry,
    emitted,
    parked,
    get idle() {
      return shared.idle;
    },
    set idle(value: boolean) {
      shared.idle = value;
    },
    get entries() {
      return shared.entries;
    },
    set entries(value: unknown[]) {
      shared.entries = value;
    },
    fire: async (event, payload = {}, ctx = made.ctx) => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const value = await handler(payload, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
    command: async (args) => {
      await command?.(args, made.ctx);
    },
    keypress: () => {
      for (const input of made.inputs) input();
    },
  };
  return harness;
}

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
    action: { kind: "command", command: "sudo ls" },
    flaggedReason: "superuser command",
    reason: "",
    risk: "high",
    ...extra,
  };
}

function decision(id: string, value: InboxDecision["decision"]): InboxDecision {
  return {
    version: 1,
    id,
    decision: value,
    decidedAt: new Date().toISOString(),
    decidedBy: { kind: "inbox", sessionId: "s2" },
  };
}

const channels = (harness: Harness, channel: string) =>
  harness.emitted.filter((e) => e.channel === channel).map((e) => e.data);

async function start(
  extra: { hasUI?: boolean; mode?: string; session?: string } = {},
) {
  const harness = await boot(extra);
  await harness.fire("session_start", { reason: "startup" });
  return harness;
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("away extension", () => {
  beforeEach(() => {
    h.mode = "auto";
    h.enabled = true;
    h.hasAway = true;
    clearAwayState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("off mode is inert", () => {
    beforeEach(() => {
      h.mode = "off";
    });

    it("touches nothing on start and for every hook", async () => {
      const harness = await start();
      await harness.fire("input", { source: "interactive", text: "hi" });
      await harness.fire("agent_start");
      await harness.fire("agent_end");
      await harness.fire("tool_result", { toolName: "bash" });
      const blocked = await harness.fire("tool_call", {
        toolName: "bash",
        input: { command: "ls" },
      });
      expect(blocked).toBeUndefined();
      expect(vol.toJSON()).toEqual({});
      expect(existsSync(inboxDir())).toBe(false);
      expect(existsSync(sessionsDir())).toBe(false);
      expect(harness.setStatus).not.toHaveBeenCalled();
      expect(harness.onTerminalInput).not.toHaveBeenCalled();
      expect(harness.emitted).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not hold a paused run and does not create state", async () => {
      const harness = await start();
      const blocked = await harness.fire("tool_call", {
        toolName: "read",
        input: { path: "a" },
      });
      expect(blocked).toBeUndefined();
      await harness.fire("session_shutdown");
      expect(vol.toJSON()).toEqual({});
    });

    it("stays inert when config has no away section or Guardrails is disabled", async () => {
      h.mode = "auto";
      h.hasAway = false;
      const first = await start();
      expect(vol.toJSON()).toEqual({});
      expect(first.onTerminalInput).not.toHaveBeenCalled();
      h.hasAway = true;
      h.enabled = false;
      const second = await start();
      expect(vol.toJSON()).toEqual({});
      expect(second.setStatus).not.toHaveBeenCalled();
    });

    it("the command only notifies", async () => {
      const harness = await start();
      await harness.command("");
      expect(harness.notify).toHaveBeenCalledWith(
        'Away mode is off. Set away.mode to "auto" in guardrails.json.',
        "info",
      );
      expect(harness.emitted).toEqual([]);
    });
  });

  describe("start and stop", () => {
    it("writes the session status and clears the status line", async () => {
      const harness = await start();
      const file = join(sessionsDir(), "s1.json");
      const status = JSON.parse(readFileSync(file, "utf-8"));
      expect(status).toMatchObject({
        sessionId: "s1",
        state: "idle",
        presence: "present",
        pid: process.pid,
        cwd: "/work",
      });
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        undefined,
      );
      expect(existsSync(inboxDir())).toBe(true);
    });

    it("updates the status file on agent start and end", async () => {
      const harness = await start();
      const file = join(sessionsDir(), "s1.json");
      await harness.fire("agent_start");
      expect(JSON.parse(readFileSync(file, "utf-8")).state).toBe("running");
      await harness.fire("agent_end");
      expect(JSON.parse(readFileSync(file, "utf-8")).state).toBe("idle");
    });

    it("reflects pause and presence changes", async () => {
      const harness = await start();
      const state = getAwayState("s1");
      setPresence(harness.pi, state, "away", "command");
      await flush();
      const file = join(sessionsDir(), "s1.json");
      expect(JSON.parse(readFileSync(file, "utf-8")).presence).toBe("away");
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        "away · 0 waiting",
      );
      pauseRun(harness.pi, state, "limit");
      await flush();
      expect(JSON.parse(readFileSync(file, "utf-8")).state).toBe("paused");
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        "paused · 0 waiting",
      );
    });

    it("counts open waiting and urgent items on the machine, not decided or allowed ones", async () => {
      await writeItem(item("a"));
      await writeItem(item("b", { kind: "urgent" }));
      await writeItem(item("c", { kind: "allowed" }));
      await writeItem(item("d", { session: { id: "other", cwd: "/x" } }));
      await writeDecision(decision("d", "reject"));
      const harness = await start();
      // Present with open items shows a bare count.
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        "2 waiting",
      );
      setPresence(harness.pi, getAwayState("s1"), "away", "command");
      await flush();
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        "away · 2 waiting",
      );
    });

    it("shows nothing without a UI", async () => {
      const harness = await start({ hasUI: false, mode: "rpc" });
      expect(harness.setStatus).not.toHaveBeenCalled();
      expect(existsSync(join(sessionsDir(), "s1.json"))).toBe(true);
    });

    it("session_shutdown releases everything", async () => {
      const harness = await start();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const listeners = harness.emitted.length;
      await harness.fire("session_shutdown");
      expect(existsSync(join(sessionsDir(), "s1.json"))).toBe(false);
      expect(harness.stopInput).toHaveBeenCalledTimes(1);
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        undefined,
      );
      expect(vi.getTimerCount()).toBe(0);
      // Events no longer rewrite the status file.
      harness.bus.emit(GUARDRAILS_AWAY_PAUSED_EVENT, { paused: true });
      await flush();
      expect(existsSync(join(sessionsDir(), "s1.json"))).toBe(false);
      expect(harness.emitted.length).toBeGreaterThan(listeners);
    });

    it("a second session_start swaps the watcher and status file", async () => {
      const harness = await start();
      const timers = vi.getTimerCount();
      await harness.fire("session_start", { reason: "reload" });
      expect(harness.stopInput).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(timers);
      expect(readdirSync(sessionsDir())).toEqual(["s1.json"]);
    });

    it("a different session id replaces the previous one", async () => {
      const harness = await start();
      const other = makeCtx({ idle: true, entries: [] }, "s2");
      await harness.fire("session_shutdown");
      await harness.fire("session_start", { reason: "new" }, other.ctx);
      expect(readdirSync(sessionsDir())).toEqual(["s2.json"]);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it("starts late when the mode changes from off, and stops when it goes back", async () => {
      h.mode = "off";
      const harness = await start();
      expect(existsSync(inboxDir())).toBe(false);
      h.mode = "auto";
      await harness.fire("agent_start");
      expect(existsSync(join(sessionsDir(), "s1.json"))).toBe(true);
      h.mode = "off";
      await harness.fire("agent_end");
      expect(existsSync(join(sessionsDir(), "s1.json"))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("presence", () => {
    it("subscribes to terminal input only in the tui", async () => {
      const rpc = await start({ mode: "rpc" });
      expect(rpc.onTerminalInput).not.toHaveBeenCalled();
      await rpc.fire("session_shutdown");
      const noUi = await start({ hasUI: false });
      expect(noUi.onTerminalInput).not.toHaveBeenCalled();
    });

    it("a keypress makes an away user present and never consumes the input", async () => {
      const harness = await start();
      const state = getAwayState("s1");
      setPresence(harness.pi, state, "away", "command");
      const fn = harness.onTerminalInput.mock.calls[0]?.[0] as () => unknown;
      expect(fn()).toBeUndefined();
      expect(state.presence).toBe("present");
      const events = channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT);
      expect(events.at(-1)).toMatchObject({
        presence: "present",
        cause: "keypress",
      });
    });

    it("a keypress does not clear a pause", async () => {
      const harness = await start();
      const state = getAwayState("s1");
      pauseRun(harness.pi, state, "limit");
      harness.keypress();
      expect(state.paused).toBeDefined();
      expect(channels(harness, GUARDRAILS_AWAY_PAUSED_EVENT)).toHaveLength(1);
    });

    it("a keypress in always mode changes nothing", async () => {
      h.mode = "always";
      const harness = await start();
      harness.keypress();
      expect(getAwayState("s1").presence).toBe("present");
      expect(channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT)).toEqual([]);
    });

    it("an interactive input makes the user present (cause input)", async () => {
      const harness = await start();
      const state = getAwayState("s1");
      setPresence(harness.pi, state, "away", "command");
      const result = await harness.fire("input", {
        source: "interactive",
        text: "hello",
      });
      expect(result).toBeUndefined();
      expect(state.presence).toBe("present");
      const events = channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT);
      expect(events.at(-1)).toMatchObject({ cause: "input" });
    });

    it("rpc and extension inputs change nothing", async () => {
      const harness = await start();
      const state = getAwayState("s1");
      setPresence(harness.pi, state, "away", "command");
      pauseRun(harness.pi, state, "limit");
      await harness.fire("input", { source: "rpc", text: "x" });
      await harness.fire("input", { source: "extension", text: "x" });
      expect(state.presence).toBe("away");
      expect(state.paused).toBeDefined();
    });

    for (const mode of ["auto", "always"] as const) {
      it(`${mode}: an interactive input clears a pause and resets the ladder even when presence is unchanged`, async () => {
        h.mode = mode;
        const harness = await start();
        const state = getAwayState("s1");
        if (mode === "auto") setPresence(harness.pi, state, "away", "command");
        state.ladder.recordBlock("block");
        state.ladder.recordBlock("block");
        pauseRun(harness.pi, state, "limit");
        const before = channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT);
        await harness.fire("input", { source: "interactive", text: "go on" });
        expect(state.paused).toBeUndefined();
        expect(state.ladder.recordBlock("block")).toBe("none");
        const paused = channels(harness, GUARDRAILS_AWAY_PAUSED_EVENT);
        expect(paused.at(-1)).toMatchObject({ paused: false });
        if (mode === "always") {
          expect(channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT)).toEqual(
            before,
          );
          expect(state.presence).toBe("present");
        }
      });
    }

    it("an interactive input emits nothing when not paused and presence is unchanged", async () => {
      const harness = await start();
      await harness.fire("input", { source: "interactive", text: "hi" });
      expect(channels(harness, GUARDRAILS_AWAY_PAUSED_EVENT)).toEqual([]);
      expect(channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT)).toEqual([]);
    });
  });

  describe("progress", () => {
    it("bash, powershell, edit and write results reset the stuck count; others do not", async () => {
      const harness = await start();
      const state = getAwayState("s1");
      for (const toolName of ["bash", "powershell", "edit", "write"]) {
        state.ladder.recordBlock("block");
        state.ladder.recordBlock("block");
        await harness.fire("tool_result", { toolName, isError: true });
        expect(state.ladder.recordBlock("block")).toBe("none");
        state.ladder.reset();
      }
      state.ladder.recordBlock("block");
      state.ladder.recordBlock("block");
      await harness.fire("tool_result", { toolName: "read" });
      expect(state.ladder.recordBlock("block")).toBe("stuck");
    });
  });

  describe("pause hold", () => {
    it("blocks every tool with PAUSED_HOLD, terminate and one action-blocked event", async () => {
      const harness = await start();
      pauseRun(harness.pi, getAwayState("s1"), "limit");
      const result = await harness.fire("tool_call", {
        toolName: "web_fetch",
        toolCallId: "t1",
        input: { url: "https://x" },
      });
      expect(result).toEqual({
        block: true,
        reason: PAUSED_HOLD,
        terminate: true,
      });
      const events = channels(harness, GUARDRAILS_ACTION_BLOCKED_EVENT);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        reason: PAUSED_HOLD,
        block: { source: "paused" },
        action: { kind: "command", command: "web_fetch" },
      });
    });

    it("describes file and bash tools by their own action", async () => {
      const harness = await start();
      pauseRun(harness.pi, getAwayState("s1"), "limit");
      await harness.fire("tool_call", {
        toolName: "read",
        input: { path: "src/a.ts" },
      });
      await harness.fire("tool_call", {
        toolName: "bash",
        input: { command: "ls" },
      });
      const events = channels(harness, GUARDRAILS_ACTION_BLOCKED_EVENT);
      expect(events[0]).toMatchObject({
        action: { kind: "file", path: "/work/src/a.ts" },
      });
      expect(events[1]).toMatchObject({
        action: { kind: "command", command: "ls" },
      });
    });

    it("lets calls through when not paused", async () => {
      const harness = await start();
      const result = await harness.fire("tool_call", {
        toolName: "read",
        input: { path: "a" },
      });
      expect(result).toBeUndefined();
      expect(channels(harness, GUARDRAILS_ACTION_BLOCKED_EVENT)).toEqual([]);
    });
  });

  describe("applying decisions", () => {
    async function setup(id = "i1", extra: Partial<InboxItem> = {}) {
      const harness = await start();
      const state = getAwayState("s1");
      const it = item(id, extra);
      await writeItem(it);
      state.ownItemIds.add(id);
      return { harness, state, key: actionKey(it.action) };
    }

    it("approve: once-grant, memory cleared, APPROVED message that triggers a turn when idle", async () => {
      const { harness, state, key } = await setup();
      state.memory.set(key, { outcome: "deferred", itemId: "i1" });
      await writeDecision(decision("i1", "approve"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(state.onceGrants.has(key)).toBe(true);
      expect(state.memory.has(key)).toBe(false);
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      const [message, options] = harness.sendMessage.mock.calls[0] ?? [];
      expect(message).toMatchObject({
        customType: "guardrails:away",
        display: true,
      });
      expect(message.content).toContain("approved");
      expect(options).toEqual({ triggerTurn: true });
      expect(harness.appendEntry).toHaveBeenCalledWith(
        "guardrails:inbox-applied",
        { id: "i1", decision: "approve" },
      );
    });

    it("approve-always behaves like approve", async () => {
      const { state, key } = await setup();
      await writeDecision(decision("i1", "approve-always"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(state.onceGrants.has(key)).toBe(true);
    });

    it("sends as a follow-up while the agent is streaming", async () => {
      const { harness } = await setup();
      harness.idle = false;
      await writeDecision(decision("i1", "approve"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(harness.sendMessage.mock.calls[0]?.[1]).toEqual({
        deliverAs: "followUp",
      });
    });

    it("reject: memory denied and REJECTED message", async () => {
      const { harness, state, key } = await setup();
      await writeDecision(decision("i1", "reject"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(state.memory.get(key)).toMatchObject({ outcome: "denied" });
      expect(state.onceGrants.has(key)).toBe(false);
      expect(harness.sendMessage.mock.calls[0]?.[0].content).toContain(
        "rejected",
      );
    });

    it("fine and wrong are recorded but send nothing and keep a pause", async () => {
      const { harness, state } = await setup();
      await writeItem(item("i2"));
      state.ownItemIds.add("i2");
      pauseRun(harness.pi, state, "limit");
      await writeDecision(decision("i1", "fine"));
      await writeDecision(decision("i2", "wrong"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(harness.sendMessage).not.toHaveBeenCalled();
      expect(harness.appendEntry).toHaveBeenCalledTimes(2);
      expect(state.paused).toBeDefined();
    });

    it("a queued message lifts a pause, tells listeners and resets the ladder", async () => {
      const { harness, state } = await setup();
      state.ladder.recordBlock("block");
      state.ladder.recordBlock("block");
      pauseRun(harness.pi, state, "limit");
      await writeDecision(decision("i1", "approve"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(state.paused).toBeUndefined();
      const events = channels(harness, GUARDRAILS_AWAY_PAUSED_EVENT);
      expect(events.at(-1)).toMatchObject({ paused: false });
      expect(state.ladder.recordBlock("block")).toBe("none");
    });

    it("sends one message for several decisions", async () => {
      const { harness, state } = await setup();
      await writeItem(
        item("i2", { action: { kind: "command", command: "rm -rf x" } }),
      );
      state.ownItemIds.add("i2");
      await writeDecision(decision("i1", "approve"));
      await writeDecision(decision("i2", "reject"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(
        harness.sendMessage.mock.calls[0]?.[0].content.split("\n"),
      ).toHaveLength(2);
    });

    it("emits guardrails:away:item with {item, decision} once per applied decision, after the applied entry", async () => {
      const { harness, state } = await setup();
      await writeItem(item("i2"));
      state.ownItemIds.add("i2");
      const order: string[] = [];
      harness.appendEntry.mockImplementation(() => order.push("entry"));
      const emit = harness.pi.events.emit.bind(harness.pi.events);
      harness.pi.events.emit = (channel: string, data: unknown) => {
        if (channel === GUARDRAILS_AWAY_ITEM_EVENT) order.push("event");
        emit(channel, data);
      };
      await writeDecision(decision("i1", "approve"));
      await writeDecision(decision("i2", "fine"));
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(10000);
      const seen = channels(harness, GUARDRAILS_AWAY_ITEM_EVENT);
      expect(seen).toHaveLength(2);
      const byId = Object.fromEntries(
        seen.map((e) => {
          const data = e as {
            item: { id: string };
            decision: { decision: string };
          };
          return [data.item.id, data.decision.decision];
        }),
      );
      expect(byId).toEqual({ i1: "approve", i2: "fine" });
      expect(order.indexOf("entry")).toBeLessThan(order.indexOf("event"));
    });

    it("applies a decision once even when the watcher and the poll both fire", async () => {
      const { harness } = await setup();
      await writeDecision(decision("i1", "approve"));
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(10000);
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    });

    it("ignores decisions for another session's items", async () => {
      const harness = await start();
      await writeItem(item("x1", { session: { id: "s9", cwd: "/y" } }));
      await writeDecision(decision("x1", "approve"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(harness.sendMessage).not.toHaveBeenCalled();
      expect(getAwayState("s1").onceGrants.size).toBe(0);
    });

    it("applies missed decisions on start with nextTurn and no trigger", async () => {
      await writeItem(item("m1"));
      await writeDecision(decision("m1", "approve"));
      const harness = await start();
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.sendMessage.mock.calls[0]?.[1]).toEqual({
        deliverAs: "nextTurn",
      });
      expect(getAwayState("s1").ownItemIds.has("m1")).toBe(true);
    });

    it("does not re-apply decisions recorded in session entries", async () => {
      await writeItem(item("m1"));
      await writeDecision(decision("m1", "approve"));
      const harness = await boot();
      harness.entries = [
        {
          type: "custom",
          customType: "guardrails:inbox-applied",
          data: { id: "m1", decision: "approve" },
        },
      ];
      await harness.fire("session_start", { reason: "resume" });
      expect(harness.sendMessage).not.toHaveBeenCalled();
      expect(getAwayState("s1").onceGrants.size).toBe(0);
    });

    it("picks up a decision written later via the file watcher without waiting for the poll", async () => {
      const { harness } = await setup();
      await writeDecision(decision("i1", "approve"));
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("refreshes the open count after a decision", async () => {
      const { harness, state } = await setup();
      setPresence(harness.pi, state, "away", "command");
      await flush();
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        "away · 1 waiting",
      );
      await writeDecision(decision("i1", "reject"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(harness.setStatus).toHaveBeenLastCalledWith(
        "guardrails:away",
        "away · 0 waiting",
      );
    });
  });

  describe("pi-live inbox items", () => {
    const answer = (
      parked: Harness["parked"][number],
      result: string,
      name = "phone",
    ) => parked.request.answer({ result }, { connId: "c1", name } as never);

    it("parks this session's open waiting and urgent items at start", async () => {
      await writeItem(item("w1"));
      await writeItem(item("u1", { kind: "urgent" }));
      await writeItem(item("a1", { kind: "allowed" }));
      await writeItem(item("o1", { session: { id: "other", cwd: "/x" } }));
      await writeItem(item("d1"));
      await writeDecision(decision("d1", "reject"));
      const harness = await start();
      expect(harness.parked.map((p) => p.request.id).sort()).toEqual([
        "u1",
        "w1",
      ]);
      const request = harness.parked.find(
        (p) => p.request.id === "w1",
      )?.request;
      expect(request).toMatchObject({
        protocol: 1,
        owner: "guardrails",
        kind: "guardrails.inbox",
        title: "Waiting for approval: sudo ls",
        view: {
          itemId: "w1",
          cwd: "/work",
          toolName: "bash",
          action: { kind: "command", command: "sudo ls" },
          flaggedReason: "superuser command",
          risk: "high",
          options: [
            { result: "approve", label: "Approve once" },
            { result: "approve-always", label: "Always allow" },
            { result: "reject", label: "Reject" },
          ],
        },
      });
    });

    it("urgent items are offered without always allow and refuse it", async () => {
      await writeItem(item("u1", { kind: "urgent" }));
      await writeItem(item("w1"));
      const harness = await start();
      const urgent = harness.parked.find((p) => p.request.id === "u1");
      const waiting = harness.parked.find((p) => p.request.id === "w1");
      assert(urgent && waiting, "both items parked");
      const results = (p: typeof urgent) =>
        (p.request.view as { options: Array<{ result: string }> }).options.map(
          (o) => o.result,
        );
      expect(results(urgent)).toEqual(["approve", "reject"]);
      expect(results(waiting)).toEqual(["approve", "approve-always", "reject"]);
      const refused = answer(urgent, "approve-always");
      expect(refused).toMatchObject({ status: "invalid" });
      await vi.advanceTimersByTimeAsync(300);
      const stored = await readDecisions(["u1"]);
      expect(stored).toEqual([]);
    });

    it("parks a new item written by this session, not by another", async () => {
      const harness = await start();
      emitAwayItem(harness.pi, item("n1"));
      emitAwayItem(harness.pi, item("n2", { session: { id: "x", cwd: "/y" } }));
      emitAwayItem(harness.pi, item("n3", { kind: "allowed" }));
      expect(harness.parked.map((p) => p.request.id)).toEqual(["n1"]);
    });

    it("a client answer writes the decision, makes the user present, closes the ticket and applies it", async () => {
      await writeItem(item("w1"));
      const harness = await start();
      const state = getAwayState("s1");
      setPresence(harness.pi, state, "away", "command");
      const parked = harness.parked[0] as Harness["parked"][number];
      expect(answer(parked, "approve")).toEqual({ status: "delivered" });
      await vi.advanceTimersByTimeAsync(300);
      const stored = await readDecisions(["w1"]);
      expect(stored[0]).toMatchObject({
        decision: "approve",
        decidedBy: { kind: "pi-live", client: "phone" },
      });
      expect(parked.ticket.close).toHaveBeenCalledTimes(1);
      expect(parked.ticket.close.mock.calls[0]?.[0]).toMatchObject({
        by: "client",
        client: { name: "phone" },
      });
      expect(state.presence).toBe("present");
      const events = channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT);
      expect(events.at(-1)).toMatchObject({ cause: "client" });
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("always: a client answer does not change presence", async () => {
      h.mode = "always";
      await writeItem(item("w1"));
      const harness = await start();
      answer(harness.parked[0] as Harness["parked"][number], "reject");
      await vi.advanceTimersByTimeAsync(300);
      expect(channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT)).toEqual([]);
      const stored = await readDecisions(["w1"]);
      expect(stored[0]?.decision).toBe("reject");
    });

    it("a decision made elsewhere closes the ticket with by keyboard", async () => {
      await writeItem(item("w1"));
      const harness = await start();
      await writeDecision(decision("w1", "approve"));
      await vi.advanceTimersByTimeAsync(300);
      const parked = harness.parked[0] as Harness["parked"][number];
      expect(parked.ticket.close).toHaveBeenCalledTimes(1);
      expect(parked.ticket.close.mock.calls[0]?.[0]).toEqual({
        by: "keyboard",
      });
    });

    it("a client answer that lost the race closes quietly as answered", async () => {
      await writeItem(item("w1"));
      const harness = await start();
      const parked = harness.parked[0] as Harness["parked"][number];
      await writeDecision(decision("w1", "reject"));
      answer(parked, "approve");
      await vi.advanceTimersByTimeAsync(300);
      const stored = await readDecisions(["w1"]);
      expect(stored[0]?.decision).toBe("reject");
      expect(parked.ticket.close).toHaveBeenCalledTimes(1);
      expect(harness.parked).toHaveLength(1);
    });

    it("a failed global grant writes no decision, warns, and parks the item again", async () => {
      await writeItem(item("w1"));
      const harness = await start();
      vi.mocked(configLoader.save).mockRejectedValueOnce(
        new Error("disk full"),
      );
      answer(harness.parked[0] as Harness["parked"][number], "approve-always");
      await vi.advanceTimersByTimeAsync(300);
      const stored = await readDecisions(["w1"]);
      expect(stored).toEqual([]);
      const warned = harness.notify.mock.calls;
      expect(String(warned.at(-1)?.[0])).toContain("disk full");
      expect(harness.parked).toHaveLength(2);
      expect(harness.parked[1]?.request.id).toBe("w1");
    });

    it("closes every open ticket with by shutdown", async () => {
      await writeItem(item("w1"));
      await writeItem(item("w2"));
      const harness = await start();
      await harness.fire("session_shutdown");
      for (const parked of harness.parked) {
        expect(parked.ticket.close).toHaveBeenCalledTimes(1);
        expect(parked.ticket.close.mock.calls[0]?.[0]).toEqual({
          by: "shutdown",
        });
      }
    });

    it("off mode parks nothing", async () => {
      h.mode = "off";
      await writeItem(item("w1"));
      const harness = await start();
      expect(harness.parked).toEqual([]);
    });
  });

  describe("/guardrails:away", () => {
    it("auto: sets away with cause command and notifies", async () => {
      const harness = await start();
      await harness.command("");
      expect(getAwayState("s1").presence).toBe("away");
      const events = channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT);
      expect(events.at(-1)).toMatchObject({
        presence: "away",
        cause: "command",
      });
      expect(harness.notify).toHaveBeenCalledTimes(1);
    });

    it("always: only notifies", async () => {
      h.mode = "always";
      const harness = await start();
      await harness.command("");
      expect(harness.notify).toHaveBeenCalledWith(
        "Away mode is always on.",
        "info",
      );
      expect(channels(harness, GUARDRAILS_PRESENCE_CHANGED_EVENT)).toEqual([]);
    });
  });
});
