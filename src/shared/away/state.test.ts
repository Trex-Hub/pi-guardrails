import { afterEach, describe, expect, it } from "vitest";
import {
  GUARDRAILS_AWAY_PAUSED_EVENT,
  GUARDRAILS_PRESENCE_CHANGED_EVENT,
} from "../events";
import {
  clearAwayState,
  effectivePresence,
  getAwayState,
  MAX_BLOCKED_ACTIONS,
  pauseRun,
  recordBlockedAction,
  resumeRun,
  setPresence,
} from "./state";
import { collect, fakePi } from "./test-utils";

const base = { stuckBlocks: 3, maxBlocks: 50 };

afterEach(() => clearAwayState());

describe("getAwayState", () => {
  it("returns the same state for the same session", () => {
    const a = getAwayState("s1");
    a.watchRemaining = 4;
    expect(getAwayState("s1")).toBe(a);
    expect(getAwayState("s1").watchRemaining).toBe(4);
  });

  it("replaces the state when the session id changes", () => {
    const a = getAwayState("s1");
    a.presence = "away";
    a.onceGrants.add("command:x");
    const b = getAwayState("s2");
    expect(b).not.toBe(a);
    expect(b).toMatchObject({
      sessionId: "s2",
      presence: "present",
      watchRemaining: 0,
    });
    expect(b.onceGrants.size).toBe(0);
    expect(b.blocked).toEqual([]);
  });

  it("is shared through globalThis, so another module instance sees it", () => {
    const key = Symbol.for("@aliou/pi-guardrails/away@1");
    const state = getAwayState("s1");
    expect((globalThis as Record<symbol, unknown>)[key]).toBe(state);
  });

  it("refreshes mode and ladder limits from config without losing counters", () => {
    const state = getAwayState("s1", { mode: "auto", ...base });
    state.ladder.recordBlock("block");
    getAwayState("s1", { mode: "always", stuckBlocks: 1, maxBlocks: 2 });
    expect(state.mode).toBe("always");
    expect(state.ladder.blocksSinceAway).toBe(1);
    expect(state.ladder.recordBlock("block")).toBe("limit");
  });
});

describe("effectivePresence", () => {
  const ctx = (hasUI: boolean, id = "s1") => ({
    hasUI,
    sessionManager: { getSessionId: () => id },
  });

  it.each([
    ["off", true, "present"],
    ["off", false, "present"],
    ["always", true, "away"],
    ["always", false, "away"],
    ["auto", false, "away"],
    ["auto", true, "present"],
  ] as const)("%s with hasUI=%s is %s", (mode, hasUI, expected) => {
    expect(effectivePresence({ mode, ...base }, ctx(hasUI))).toBe(expected);
  });

  it("auto with a UI follows the tracked presence", () => {
    getAwayState("s1").presence = "away";
    expect(effectivePresence({ mode: "auto", ...base }, ctx(true))).toBe(
      "away",
    );
  });

  it("off ignores a tracked away presence", () => {
    getAwayState("s1").presence = "away";
    expect(effectivePresence({ mode: "off", ...base }, ctx(true))).toBe(
      "present",
    );
  });
});

describe("setPresence", () => {
  it("does nothing when unchanged", () => {
    const { pi, bus } = fakePi();
    const seen = collect(bus, GUARDRAILS_PRESENCE_CHANGED_EVENT);
    setPresence(pi, getAwayState("s1"), "present", "keypress");
    expect(seen).toEqual([]);
  });

  it("emits presence:changed on a change", () => {
    const { pi, bus } = fakePi();
    const seen = collect(bus, GUARDRAILS_PRESENCE_CHANGED_EVENT);
    const state = getAwayState("s1", { mode: "auto", ...base });
    setPresence(pi, state, "away", "timeout");
    expect(state.presence).toBe("away");
    expect(seen).toEqual([
      expect.objectContaining({
        source: "guardrails",
        presence: "away",
        cause: "timeout",
      }),
    ]);
  });

  it("going present resets the ladder, clears the pause and emits paused:false", () => {
    const { pi, bus } = fakePi();
    const paused = collect(bus, GUARDRAILS_AWAY_PAUSED_EVENT);
    const state = getAwayState("s1", { mode: "auto", ...base });
    setPresence(pi, state, "away", "command");
    state.ladder.recordBlock("block");
    pauseRun(pi, state, "why");
    setPresence(pi, state, "present", "keypress");
    expect(state.ladder.blocksSinceAway).toBe(0);
    expect(state.paused).toBeUndefined();
    expect(paused).toEqual([
      expect.objectContaining({ paused: true, reason: "why" }),
      expect.objectContaining({ paused: false }),
    ]);
    expect((paused[1] as { reason?: string }).reason).toBeUndefined();
  });

  it("going present emits paused:false only if the run was paused", () => {
    const { pi, bus } = fakePi();
    const paused = collect(bus, GUARDRAILS_AWAY_PAUSED_EVENT);
    const state = getAwayState("s1", { mode: "auto", ...base });
    setPresence(pi, state, "away", "command");
    setPresence(pi, state, "present", "keypress");
    expect(paused).toEqual([]);
  });

  it("going away leaves the ladder and pause alone", () => {
    const { pi } = fakePi();
    const state = getAwayState("s1", { mode: "auto", ...base });
    state.ladder.recordBlock("block");
    setPresence(pi, state, "away", "command");
    expect(state.ladder.blocksSinceAway).toBe(1);
  });

  it("never goes present in always mode", () => {
    const { pi, bus } = fakePi();
    const seen = collect(bus, GUARDRAILS_PRESENCE_CHANGED_EVENT);
    const state = getAwayState("s1", { mode: "always", ...base });
    setPresence(pi, state, "away", "command");
    seen.length = 0;
    setPresence(pi, state, "present", "keypress");
    expect(state.presence).toBe("away");
    expect(seen).toEqual([]);
  });
});

describe("pauseRun / resumeRun", () => {
  it("sets and clears paused and emits", () => {
    const { pi, bus } = fakePi();
    const seen = collect(bus, GUARDRAILS_AWAY_PAUSED_EVENT);
    const state = getAwayState("s1");
    pauseRun(pi, state, "too many");
    expect(state.paused?.reason).toBe("too many");
    resumeRun(pi, state);
    expect(state.paused).toBeUndefined();
    resumeRun(pi, state);
    expect(seen).toHaveLength(2);
  });
});

describe("recordBlockedAction", () => {
  it("keeps the newest 20, newest last", () => {
    const state = getAwayState("s1");
    for (let i = 0; i < MAX_BLOCKED_ACTIONS + 5; i++) {
      recordBlockedAction(state, {
        feature: "permissionGate",
        toolName: "bash",
        action: { kind: "command", command: `c${i}` },
        outcome: "denied",
        reason: "r",
      });
    }
    expect(state.blocked).toHaveLength(MAX_BLOCKED_ACTIONS);
    expect(state.blocked[0]?.action).toEqual({
      kind: "command",
      command: "c5",
    });
    expect(state.blocked.at(-1)?.action).toEqual({
      kind: "command",
      command: "c24",
    });
    expect(Number.isNaN(Date.parse(state.blocked[0]?.at ?? ""))).toBe(false);
  });
});
