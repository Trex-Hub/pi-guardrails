import { describe, expect, it } from "vitest";
import {
  AwayLadder,
  actionKey,
  hasHighRiskAllow,
  isSevereBlock,
  normalizeCommand,
  pickCard,
  resolveRisk,
} from "./away";
import {
  type DelegateAnswer,
  type DelegateOutcome,
  isDelegateAnswer,
  sanitizeAnswerExtras,
} from "./delegation";

function outcome(
  name: string,
  answer?: Partial<DelegateAnswer>,
  status: DelegateOutcome["status"] = "answered",
): DelegateOutcome {
  return {
    delegateId: name,
    delegateName: name,
    status,
    answer: answer
      ? { verdict: "ask", reason: `${name} reason`, ...answer }
      : undefined,
    elapsedMs: 1,
  };
}

describe("sanitizeAnswerExtras", () => {
  const base: DelegateAnswer = { verdict: "block", reason: "no" };

  it("keeps valid extras", () => {
    const card = {
      summary: "Delete build output",
      why: "recursive delete",
      steps: [{ part: "rm", meaning: "remove" }],
      risk: "low: inside project",
      worthKnowing: "-r recurses",
      category: "delete build output",
    };
    expect(
      sanitizeAnswerExtras({ ...base, risk: "low", severe: true, card }),
    ).toEqual({ ...base, risk: "low", severe: true, card });
  });

  it("drops invalid risk and severe", () => {
    const clean = sanitizeAnswerExtras({
      ...base,
      risk: "medium" as never,
      severe: false,
    });
    expect(clean).toEqual(base);
    expect("risk" in clean).toBe(false);
    expect("severe" in clean).toBe(false);
    expect(sanitizeAnswerExtras({ ...base, severe: "yes" as never })).toEqual(
      base,
    );
  });

  it("drops a card without a non-empty string summary", () => {
    for (const card of [
      undefined,
      null,
      "text",
      {},
      { summary: "" },
      { summary: "  " },
      { summary: 3 },
    ]) {
      expect(sanitizeAnswerExtras({ ...base, card: card as never })).toEqual(
        base,
      );
    }
  });

  it("drops non-string optional card fields and bad steps", () => {
    const clean = sanitizeAnswerExtras({
      ...base,
      card: {
        summary: "s",
        why: 1,
        risk: {},
        worthKnowing: null,
        category: ["x"],
        steps: [
          { part: "a", meaning: "b" },
          { part: "a" },
          { meaning: "b" },
          null,
          "x",
          { part: 1, meaning: 2 },
        ],
      } as never,
    });
    expect(clean.card).toEqual({
      summary: "s",
      steps: [{ part: "a", meaning: "b" }],
    });
  });

  it("does not mutate the input and keeps details", () => {
    const input = { ...base, risk: "nope" as never, details: { a: 1 } };
    const clean = sanitizeAnswerExtras(input);
    expect(input.risk).toBe("nope");
    expect(clean.details).toEqual({ a: 1 });
  });

  it("does not change what makes an answer valid", () => {
    expect(isDelegateAnswer({ ...base, risk: "bogus", card: 5 })).toBe(true);
    expect(isDelegateAnswer({ verdict: "block" })).toBe(false);
  });
});

describe("resolveRisk", () => {
  it("is low when one answers low and none high", () => {
    expect(
      resolveRisk([outcome("a", { risk: "low" }), outcome("b", {})], false),
    ).toBe("low");
  });

  it("is high when any answers high", () => {
    expect(
      resolveRisk(
        [outcome("a", { risk: "low" }), outcome("b", { risk: "high" })],
        false,
      ),
    ).toBe("high");
  });

  it("is high with no delegates or no reported risk", () => {
    expect(resolveRisk([], false)).toBe("high");
    expect(resolveRisk([outcome("a", {})], false)).toBe("high");
  });

  it("ignores outcomes that did not answer", () => {
    const timedOut = outcome("t", undefined, "timeout");
    timedOut.answer = { verdict: "ask", reason: "x", risk: "high" };
    expect(resolveRisk([timedOut, outcome("a", { risk: "low" })], false)).toBe(
      "low",
    );
    expect(resolveRisk([timedOut], false)).toBe("high");
  });

  it("is high when the floor is set", () => {
    expect(resolveRisk([outcome("a", { risk: "low" })], true)).toBe("high");
  });
});

describe("hasHighRiskAllow", () => {
  it("is true only for an answered allow with risk high", () => {
    expect(
      hasHighRiskAllow([outcome("a", { verdict: "allow", risk: "high" })]),
    ).toBe(true);
    expect(
      hasHighRiskAllow([
        outcome("a", { verdict: "allow", risk: "low" }),
        outcome("b", { verdict: "allow", risk: "high" }),
      ]),
    ).toBe(true);
  });

  it("ignores asks, blocks, low or absent risk and unanswered outcomes", () => {
    expect(
      hasHighRiskAllow([outcome("a", { verdict: "ask", risk: "high" })]),
    ).toBe(false);
    expect(
      hasHighRiskAllow([outcome("a", { verdict: "block", risk: "high" })]),
    ).toBe(false);
    expect(hasHighRiskAllow([outcome("a", { verdict: "allow" })])).toBe(false);
    const failed = outcome("e", undefined, "error");
    failed.answer = { verdict: "allow", reason: "x", risk: "high" };
    expect(hasHighRiskAllow([failed])).toBe(false);
    expect(hasHighRiskAllow([])).toBe(false);
  });
});

describe("pickCard", () => {
  it("returns the first answered card in roster order", () => {
    const first = { summary: "first" };
    const second = { summary: "second" };
    expect(
      pickCard([
        outcome("a", {}),
        outcome("b", { card: first }),
        outcome("c", { card: second }),
      ]),
    ).toBe(first);
  });

  it("returns undefined when no answered outcome has a card", () => {
    const failed = outcome("e", undefined, "error");
    failed.answer = { verdict: "ask", reason: "x", card: { summary: "s" } };
    expect(pickCard([failed, outcome("a", {})])).toBeUndefined();
    expect(pickCard([])).toBeUndefined();
  });
});

describe("isSevereBlock", () => {
  it("is true for an answered block with severe", () => {
    expect(
      isSevereBlock([outcome("a", { verdict: "block", severe: true })]),
    ).toBe(true);
  });

  it("ignores severe on other verdicts and non-severe blocks", () => {
    expect(
      isSevereBlock([outcome("a", { verdict: "ask", severe: true })]),
    ).toBe(false);
    expect(isSevereBlock([outcome("a", { verdict: "block" })])).toBe(false);
    expect(isSevereBlock([])).toBe(false);
  });

  it("ignores outcomes that did not answer", () => {
    const o = outcome("a", undefined, "cancelled");
    o.answer = { verdict: "block", reason: "x", severe: true };
    expect(isSevereBlock([o])).toBe(false);
  });
});

describe("normalizeCommand / actionKey", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeCommand("  rm   -rf\t build \n")).toBe("rm -rf build");
  });

  it("keys commands by normalized text and files by path", () => {
    expect(actionKey({ kind: "command", command: " rm  -rf x " })).toBe(
      "command:rm -rf x",
    );
    expect(actionKey({ kind: "file", path: "/a/b" })).toBe("file:/a/b");
    expect(
      actionKey({ kind: "command", command: "a  b", origin: "bash" }),
    ).toBe(actionKey({ kind: "command", command: "a b" }));
  });
});

describe("AwayLadder", () => {
  const make = (stuckBlocks = 3, maxBlocks = 50) =>
    new AwayLadder({ stuckBlocks, maxBlocks });

  it("returns none until stuckBlocks blocks without progress", () => {
    const ladder = make();
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("stuck");
    expect(ladder.blocksSinceAway).toBe(3);
  });

  it("gives stuck-again after another stuckBlocks blocks without progress", () => {
    const ladder = make();
    for (let i = 0; i < 3; i++) ladder.recordBlock("block");
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("stuck-again");
  });

  it("progress resets the streak and clears the nudge", () => {
    const ladder = make();
    ladder.recordBlock("block");
    ladder.recordBlock("block");
    ladder.recordProgress();
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("stuck");
    ladder.recordProgress();
    for (let i = 0; i < 2; i++)
      expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("stuck");
  });

  it("progress does not reset blocksSinceAway", () => {
    const ladder = make();
    ladder.recordBlock("block");
    ladder.recordProgress();
    expect(ladder.blocksSinceAway).toBe(1);
  });

  it("repeats count toward the limit but not toward stuck", () => {
    const ladder = make();
    for (let i = 0; i < 10; i++)
      expect(ladder.recordBlock("repeat")).toBe("none");
    expect(ladder.blocksSinceAway).toBe(10);
    ladder.recordBlock("block");
    ladder.recordBlock("block");
    expect(ladder.recordBlock("block")).toBe("stuck");
  });

  it("returns limit at maxBlocks and it takes precedence", () => {
    const ladder = make(2, 3);
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("stuck");
    expect(ladder.recordBlock("block")).toBe("limit");
    expect(ladder.recordBlock("repeat")).toBe("limit");
  });

  it("limit applies to repeats too", () => {
    const ladder = make(3, 2);
    ladder.recordBlock("repeat");
    expect(ladder.recordBlock("repeat")).toBe("limit");
  });

  it("with stuckBlocks 1 every block without progress alternates stuck then stuck-again", () => {
    const ladder = make(1, 50);
    expect(ladder.recordBlock("block")).toBe("stuck");
    expect(ladder.recordBlock("block")).toBe("stuck-again");
  });

  it("reset sets everything back to zero", () => {
    const ladder = make();
    for (let i = 0; i < 3; i++) ladder.recordBlock("block");
    ladder.reset();
    expect(ladder.blocksSinceAway).toBe(0);
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("none");
    expect(ladder.recordBlock("block")).toBe("stuck");
  });
});

describe("AwayLadder.configure", () => {
  it("changes the limits and keeps the counters", () => {
    const ladder = new AwayLadder({ stuckBlocks: 5, maxBlocks: 50 });
    ladder.recordBlock("block");
    ladder.recordBlock("block");
    ladder.configure({ stuckBlocks: 3, maxBlocks: 4 });
    expect(ladder.blocksSinceAway).toBe(2);
    expect(ladder.recordBlock("block")).toBe("stuck");
    expect(ladder.recordBlock("block")).toBe("limit");
  });
});
