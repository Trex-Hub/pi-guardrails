import { describe, expect, it } from "vitest";
import * as m from "./messages";

describe("away messages", () => {
  it("match the spec strings exactly", () => {
    expect(m.DEFERRED).toBe(
      "Queued for the user's approval; the user is away. Don't retry this or do the same thing another way. Continue with other work, and list this under \"needs approval\" in your final summary.",
    );
    expect(m.DENIED_SUFFIX).toBe(
      "Don't do this, and don't do the same thing another way.",
    );
    expect(m.REPEAT_QUEUED).toBe(
      "Already queued for the user's approval. Don't retry it; continue with other work.",
    );
    expect(m.REPEAT_DENIED).toBe(
      "Already denied. Don't retry it or do the same thing another way.",
    );
    expect(m.NUDGE).toBe(
      "Several actions in a row need the user's approval. Continue with work that doesn't need them, or wrap up with a summary of what is waiting.",
    );
    expect(m.advice("do x")).toBe("Supervisor: do x");
    expect(m.PAUSED_HOLD).toBe(
      "Guardrails paused this run until the user returns. Stop and summarize.",
    );
    expect(m.paused("because")).toBe(
      "Guardrails paused this run: because. Stop here and summarize what you did and what is waiting for the user's approval.",
    );
    expect(m.approved("ls")).toBe(
      "Guardrails: the user approved this action. You can run it now: ls",
    );
    expect(m.rejected("ls")).toBe(
      "Guardrails: the user rejected this action. Don't do it, or the same thing another way: ls",
    );
  });

  it("builds the <why> values", () => {
    expect(m.pausedWhy.limit(50)).toBe("too many blocked actions (50)");
    expect(m.pausedWhy.stuck()).toBe(
      "the agent kept getting blocked without progress",
    );
    expect(m.pausedWhy.advisor("hold on")).toBe("hold on");
    expect(m.pausedWhy.severe("exfil")).toBe(
      "a severe action was blocked: exfil",
    );
  });

  it("appends suffixes after a blank line", () => {
    expect(m.withSuffix("a", "b")).toBe("a\n\nb");
  });

  it("labels commands by text and files by tool and path", () => {
    expect(
      m.actionLabel({ kind: "command", command: "rm -rf x" }, "bash"),
    ).toBe("rm -rf x");
    expect(m.actionLabel({ kind: "file", path: "/a/b" }, "write")).toBe(
      "write /a/b",
    );
  });
});
