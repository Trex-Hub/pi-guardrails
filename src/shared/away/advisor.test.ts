import { afterEach, describe, expect, it, vi } from "vitest";
import { GUARDRAILS_ADVISOR_REQUEST_EVENT } from "../events";
import { createAdvisorRoster, registerAdvisor, runAdvisors } from "./advisor";
import { collect, fakePi } from "./test-utils";
import type { AdvisorSituation, GuardrailsAdvisor } from "./types";

const situation: AdvisorSituation = {
  reason: "stuck",
  blocked: [],
  blocksSinceAway: 3,
  standingPermissions: [],
};
const ctx = {
  cwd: "/w",
  sessionManager: {} as never,
  modelRegistry: {} as never,
};

function advisor(
  id: string,
  advise: GuardrailsAdvisor["advise"],
  extra: Partial<GuardrailsAdvisor> = {},
): GuardrailsAdvisor {
  return { id, name: id, advise, ...extra };
}

afterEach(() => vi.useRealTimers());

describe("advisor roster", () => {
  it("collects advisors registered before and after, and answers requests", () => {
    const { pi } = fakePi();
    const early = advisor("early", () => undefined);
    registerAdvisor(pi, early);
    const roster = createAdvisorRoster(pi);
    expect(roster.list().map((a) => a.id)).toEqual(["early"]);
    registerAdvisor(
      pi,
      advisor("late", () => undefined),
    );
    expect(roster.list().map((a) => a.id)).toEqual(["early", "late"]);
  });

  it("emits a request when the roster is created", () => {
    const { pi, bus } = fakePi();
    const seen = collect(bus, GUARDRAILS_ADVISOR_REQUEST_EVENT);
    createAdvisorRoster(pi);
    expect(seen).toHaveLength(1);
  });

  it("skips disabled or throwing isEnabled, and malformed registrations", () => {
    const { pi, bus } = fakePi();
    const roster = createAdvisorRoster(pi);
    registerAdvisor(
      pi,
      advisor("off", () => undefined, { isEnabled: () => false }),
    );
    registerAdvisor(
      pi,
      advisor("boom", () => undefined, {
        isEnabled: () => {
          throw new Error("x");
        },
      }),
    );
    bus.emit("guardrails:advisor:register", { advisor: { id: "bad" } });
    registerAdvisor(
      pi,
      advisor("ok", () => undefined),
    );
    expect(roster.list().map((a) => a.id)).toEqual(["ok"]);
  });

  it("clears on session_shutdown", () => {
    const { pi, fire } = fakePi();
    const roster = createAdvisorRoster(pi);
    registerAdvisor(
      pi,
      advisor("a", () => undefined),
    );
    fire("session_shutdown");
    expect(roster.list()).toEqual([]);
  });
});

describe("runAdvisors", () => {
  const run = (advisors: GuardrailsAdvisor[], timeoutMs = 1000) =>
    runAdvisors(advisors, situation, ctx, { timeoutMs });

  it("returns undefined with no advisors", async () => {
    const r1 = await run([]);
    expect(r1).toBeUndefined();
  });

  it("joins advise messages with a newline in roster order", async () => {
    const answer = await run([
      advisor("a", () => ({ action: "advise", message: "first" })),
      advisor("b", async () => ({ action: "advise", message: "second" })),
    ]);
    expect(answer).toEqual({ action: "advise", message: "first\nsecond" });
  });

  it("pause wins over advise, first pause in roster order", async () => {
    const answer = await run([
      advisor("a", () => ({ action: "advise", message: "hm" })),
      advisor("b", async () => ({ action: "pause", reason: "slow pause" })),
      advisor("c", () => ({ action: "pause", reason: "other" })),
    ]);
    expect(answer).toEqual({ action: "pause", reason: "slow pause" });
  });

  it("ignores abstentions, errors and malformed answers", async () => {
    const answer = await run([
      advisor("a", () => undefined),
      advisor("b", () => {
        throw new Error("boom");
      }),
      advisor("c", () => ({ action: "allow" }) as never),
      advisor("d", () => ({ action: "advise", message: "  " })),
      advisor("e", () => ({ action: "advise", message: " ok " })),
    ]);
    expect(answer).toEqual({ action: "advise", message: "ok" });
    const none = await run([
      advisor("a", () => undefined),
      advisor("b", () => {
        throw new Error("x");
      }),
    ]);
    expect(none).toBeUndefined();
  });

  it("times out to undefined and aborts the signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = run(
      [
        advisor("slow", (_s, c) => {
          signal = c.signal;
          return new Promise(() => undefined);
        }),
      ],
      500,
    );
    await vi.advanceTimersByTimeAsync(501);
    const r2 = await pending;
    expect(r2).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps answers that arrived before the deadline", async () => {
    vi.useFakeTimers();
    const pending = run(
      [
        advisor("fast", () => ({ action: "advise", message: "quick" })),
        advisor("slow", () => new Promise(() => undefined)),
      ],
      500,
    );
    await vi.advanceTimersByTimeAsync(501);
    const r3 = await pending;
    expect(r3).toEqual({ action: "advise", message: "quick" });
  });

  it("honors an already aborted outer signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const answer = await runAdvisors(
      [advisor("a", () => new Promise(() => undefined))],
      situation,
      ctx,
      { timeoutMs: 1000, signal: controller.signal },
    );
    expect(answer).toBeUndefined();
  });
});
