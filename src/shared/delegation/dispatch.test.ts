import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegateAnswer } from "../../core/delegation";
import { GUARDRAILS_DECISION_DELEGATED_EVENT } from "../events";
import { delegateDecision, runDelegates } from "./dispatch";
import { DELEGATION_ENTRY_TYPE } from "./entry";
import { createDelegateRoster, registerDelegate } from "./roster";
import type { DelegationRequest, GuardrailsDelegate } from "./types";

const request: DelegationRequest = {
  feature: "permissionGate",
  action: { kind: "command", command: "rm -rf build", origin: "bash" },
  reason: "recursive force delete",
  toolName: "bash",
  input: { command: "rm -rf build" },
};

const sessionCtx = {
  cwd: "/workspace",
  sessionManager: {} as never,
  modelRegistry: {} as never,
};

function delegate(
  id: string,
  decide: GuardrailsDelegate["decide"],
  extra: Partial<GuardrailsDelegate> = {},
): GuardrailsDelegate {
  return { id, name: id, decide, ...extra };
}

function fakePi() {
  const bus = createEventBus();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    events: bus,
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    appendEntry: vi.fn(),
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    appendEntry: pi.appendEntry,
    bus,
    fire: (event: string) => handlers.get(event)?.(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runDelegates", () => {
  it("records answers, abstentions, errors, and malformed answers", async () => {
    const outcomes = await runDelegates(
      [
        delegate("allow", () => ({ verdict: "allow", reason: "fine" })),
        delegate("abstain", () => undefined),
        delegate("throws", () => {
          throw new Error("boom");
        }),
        delegate("malformed", () => ({ verdict: "yes" }) as never),
      ],
      request,
      sessionCtx,
      { timeoutMs: 1000 },
    );

    expect(outcomes.map((o) => [o.delegateId, o.status])).toEqual([
      ["allow", "answered"],
      ["abstain", "abstained"],
      ["throws", "error"],
      ["malformed", "error"],
    ]);
    expect(outcomes[2]?.error).toBe("boom");
  });

  it("times out slow delegates and aborts their signal", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const pending = runDelegates(
      [
        delegate("slow", (_req, ctx) => {
          seenSignal = ctx.signal;
          return new Promise<DelegateAnswer>(() => {});
        }),
      ],
      request,
      sessionCtx,
      { timeoutMs: 500 },
    );

    await vi.advanceTimersByTimeAsync(500);
    const [outcome] = await pending;
    expect(outcome?.status).toBe("timeout");
    expect(seenSignal?.aborted).toBe(true);
  });

  it("cancels the remaining delegates once one blocks", async () => {
    let slowSignal: AbortSignal | undefined;
    const outcomes = await runDelegates(
      [
        delegate("slow", (_req, ctx) => {
          slowSignal = ctx.signal;
          return new Promise<DelegateAnswer>(() => {});
        }),
        delegate("blocker", async () => ({ verdict: "block", reason: "no" })),
      ],
      request,
      sessionCtx,
      { timeoutMs: 10_000 },
    );

    expect(outcomes.map((o) => o.status)).toEqual(["cancelled", "answered"]);
    expect(slowSignal?.aborted).toBe(true);
  });

  it("cancels delegates when the agent aborts", async () => {
    const parent = new AbortController();
    const pending = runDelegates(
      [delegate("slow", () => new Promise<DelegateAnswer>(() => {}))],
      request,
      sessionCtx,
      { timeoutMs: 10_000, signal: parent.signal },
    );
    parent.abort();
    const [outcome] = await pending;
    expect(outcome?.status).toBe("cancelled");
  });
});

describe("runDelegates progress", () => {
  it("reports each outcome as it finishes", async () => {
    const seen: string[] = [];
    await runDelegates(
      [
        delegate("slow", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { verdict: "allow", reason: "ok" };
        }),
        delegate("fast", () => ({ verdict: "allow", reason: "ok" })),
      ],
      request,
      sessionCtx,
      {
        timeoutMs: 1000,
        onOutcome: (index, outcome) =>
          seen.push(`${index}:${outcome.delegateId}`),
      },
    );
    expect(seen).toEqual(["1:fast", "0:slow"]);
  });

  it("ignores progress callbacks that throw", async () => {
    const outcomes = await runDelegates(
      [delegate("a", () => ({ verdict: "allow", reason: "ok" }))],
      request,
      sessionCtx,
      {
        timeoutMs: 1000,
        onOutcome: () => {
          throw new Error("render failed");
        },
      },
    );
    expect(outcomes[0]?.status).toBe("answered");
  });
});

describe("delegateDecision", () => {
  it("shows a live widget in the TUI and clears it when done", async () => {
    const { pi } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("d", () => ({ verdict: "allow", reason: "ok" })),
    );
    const setWidget = vi.fn();

    await delegateDecision(
      pi,
      roster,
      request,
      { ...sessionCtx, mode: "tui", ui: { setWidget } } as never,
      { timeoutMs: 1000 },
    );

    expect(setWidget).toHaveBeenNthCalledWith(
      1,
      "guardrails:delegation",
      expect.any(Function),
    );
    expect(setWidget).toHaveBeenLastCalledWith(
      "guardrails:delegation",
      undefined,
    );
  });

  it("shares one widget across concurrent decisions", async () => {
    const { pi } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("slow", async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { verdict: "allow", reason: "ok" };
      }),
    );
    const setWidget = vi.fn();
    const ctx = { ...sessionCtx, mode: "tui", ui: { setWidget } } as never;

    await Promise.all([
      delegateDecision(pi, roster, request, ctx, { timeoutMs: 1000 }),
      delegateDecision(pi, roster, request, ctx, { timeoutMs: 1000 }),
    ]);

    expect(setWidget.mock.calls.map(([, content]) => typeof content)).toEqual([
      "function",
      "undefined",
    ]);
  });

  it("does not use component widgets outside the TUI", async () => {
    const { pi } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("d", () => ({ verdict: "allow", reason: "ok" })),
    );
    const setWidget = vi.fn();

    await delegateDecision(
      pi,
      roster,
      request,
      { ...sessionCtx, mode: "rpc", ui: { setWidget } } as never,
      { timeoutMs: 1000 },
    );

    expect(setWidget).not.toHaveBeenCalled();
  });

  it("returns undefined without touching the session when no delegate is enabled", async () => {
    const { pi, appendEntry } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("off", () => ({ verdict: "allow", reason: "x" }), {
        isEnabled: () => false,
      }),
    );

    const result = await delegateDecision(
      pi,
      roster,
      request,
      sessionCtx as never,
      {
        timeoutMs: 1000,
      },
    );

    expect(result).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("records the decision as a session entry and emits an event", async () => {
    const { pi, appendEntry, bus } = fakePi();
    const delegated = vi.fn();
    bus.on(GUARDRAILS_DECISION_DELEGATED_EVENT, delegated);
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("classifier", () => ({ verdict: "allow", reason: "in scope" })),
    );

    const result = await delegateDecision(
      pi,
      roster,
      request,
      sessionCtx as never,
      {
        timeoutMs: 1000,
      },
    );

    expect(result).toMatchObject({
      verdict: "allow",
      reason: "classifier: in scope",
      feature: "permissionGate",
      flaggedReason: "recursive force delete",
    });
    expect(appendEntry).toHaveBeenCalledWith(DELEGATION_ENTRY_TYPE, result);
    expect(delegated).toHaveBeenCalledWith(
      expect.objectContaining({ source: "guardrails", verdict: "allow" }),
    );
  });
});

describe("delegate roster", () => {
  it("picks up delegates registered before the feature loads", () => {
    const { pi } = fakePi();
    registerDelegate(
      pi,
      delegate("early", () => undefined),
    );
    const roster = createDelegateRoster(pi);
    expect(roster.list().map((d) => d.id)).toEqual(["early"]);
  });

  it("picks up delegates registered after the feature loads", () => {
    const { pi } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("late", () => undefined),
    );
    expect(roster.list().map((d) => d.id)).toEqual(["late"]);
  });

  it("replaces a delegate re-registered with the same id", () => {
    const { pi } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("same", () => undefined, { name: "old" }),
    );
    registerDelegate(
      pi,
      delegate("same", () => undefined, { name: "new" }),
    );
    expect(roster.list().map((d) => d.name)).toEqual(["new"]);
  });

  it("ignores malformed registrations", () => {
    const { pi, bus } = fakePi();
    const roster = createDelegateRoster(pi);
    bus.emit("guardrails:delegate:register", { delegate: { id: "x" } });
    bus.emit("guardrails:delegate:register", undefined);
    expect(roster.list()).toEqual([]);
  });

  it("skips disabled delegates and delegates whose switch throws", () => {
    const { pi } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("on", () => undefined),
    );
    registerDelegate(
      pi,
      delegate("off", () => undefined, { isEnabled: () => false }),
    );
    registerDelegate(
      pi,
      delegate("broken", () => undefined, {
        isEnabled: () => {
          throw new Error("x");
        },
      }),
    );
    expect(roster.list().map((d) => d.id)).toEqual(["on"]);
  });

  it("forgets delegates on session shutdown", () => {
    const { pi, fire } = fakePi();
    const roster = createDelegateRoster(pi);
    registerDelegate(
      pi,
      delegate("d", () => undefined),
    );
    fire("session_shutdown");
    expect(roster.list()).toEqual([]);
  });
});

describe("runDelegates answer extras", () => {
  it("stores the sanitized answer on the outcome", async () => {
    const outcomes = await runDelegates(
      [
        delegate("a", () => ({
          verdict: "ask",
          reason: "unsure",
          risk: "medium" as never,
          severe: "yes" as never,
          card: { summary: "" } as never,
        })),
        delegate("b", () => ({
          verdict: "ask",
          reason: "unsure",
          risk: "low",
          card: { summary: "Does a thing", category: "thing" },
        })),
      ],
      request,
      sessionCtx,
      { timeoutMs: 1000 },
    );
    expect(outcomes[0]?.answer).toEqual({ verdict: "ask", reason: "unsure" });
    expect(outcomes[1]?.answer).toEqual({
      verdict: "ask",
      reason: "unsure",
      risk: "low",
      card: { summary: "Does a thing", category: "thing" },
    });
  });
});

describe("delegateDecision watchOnly", () => {
  const ctx = { ...sessionCtx } as never;

  it("asks only delegates with watch: true and still records the decision", async () => {
    const { pi, appendEntry } = fakePi();
    const normal = vi.fn(() => ({ verdict: "allow" as const, reason: "n" }));
    const watcher = vi.fn(() => ({ verdict: "block" as const, reason: "w" }));
    registerDelegate(pi, delegate("normal", normal));
    registerDelegate(pi, delegate("watcher", watcher, { watch: true }));
    const roster = createDelegateRoster(pi);

    const decision = await delegateDecision(pi, roster, request, ctx, {
      timeoutMs: 1000,
      watchOnly: true,
    });

    expect(normal).not.toHaveBeenCalled();
    expect(watcher).toHaveBeenCalledOnce();
    expect(decision?.verdict).toBe("block");
    expect(appendEntry).toHaveBeenCalledWith(
      DELEGATION_ENTRY_TYPE,
      expect.objectContaining({ verdict: "block" }),
    );
  });

  it("returns undefined when no delegate watches, and asks everyone otherwise", async () => {
    const { pi } = fakePi();
    const normal = vi.fn(() => ({ verdict: "allow" as const, reason: "n" }));
    registerDelegate(pi, delegate("normal", normal));
    const roster = createDelegateRoster(pi);

    const none = await delegateDecision(pi, roster, request, ctx, {
      timeoutMs: 1000,
      watchOnly: true,
    });
    expect(none).toBeUndefined();
    expect(normal).not.toHaveBeenCalled();

    const all = await delegateDecision(pi, roster, request, ctx, {
      timeoutMs: 1000,
    });
    expect(all?.verdict).toBe("allow");
  });
});
