import type { DelegateOutcome, GuardrailsCard, Risk } from "./delegation";
import type { Action } from "./types";

/**
 * Pi-free primitives for away mode. Nothing here reads config or the
 * filesystem; callers pass everything in.
 */

/**
 * Combines delegate risk ratings. `"low"` only when nothing forces it up:
 * `floor` is false, at least one answered outcome says low, and none says
 * high. Outcomes without a risk are ignored, so no delegates means "high".
 */
export function resolveRisk(
  outcomes: readonly DelegateOutcome[],
  floor: boolean,
): Risk {
  if (floor) return "high";
  let sawLow = false;
  for (const outcome of outcomes) {
    if (outcome.status !== "answered") continue;
    const risk = outcome.answer?.risk;
    if (risk === "high") return "high";
    if (risk === "low") sawLow = true;
  }
  return sawLow ? "low" : "high";
}

/** First answered outcome's card, in roster order. */
export function pickCard(
  outcomes: readonly DelegateOutcome[],
): GuardrailsCard | undefined {
  for (const outcome of outcomes) {
    if (outcome.status === "answered" && outcome.answer?.card) {
      return outcome.answer.card;
    }
  }
  return undefined;
}

/** True when any answered outcome blocks and marks the block severe. */
export function isSevereBlock(outcomes: readonly DelegateOutcome[]): boolean {
  return outcomes.some(
    (o) =>
      o.status === "answered" &&
      o.answer?.verdict === "block" &&
      o.answer.severe === true,
  );
}

/** Trims and collapses whitespace runs to a single space. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** Stable key for repeat detection and once-grants. */
export function actionKey(action: Action): string {
  return action.kind === "command"
    ? `command:${normalizeCommand(action.command)}`
    : `file:${action.path}`;
}

export type LadderSignal = "none" | "stuck" | "stuck-again" | "limit";

/**
 * Counts blocks while the user is away and says when the run is stuck (several
 * blocks with no progress between them) or has hit the overall block limit.
 */
export class AwayLadder {
  private readonly stuckBlocks: number;
  private readonly maxBlocks: number;
  private sinceAway = 0;
  private sinceProgress = 0;
  private nudged = false;

  constructor(opts: { stuckBlocks: number; maxBlocks: number }) {
    this.stuckBlocks = opts.stuckBlocks;
    this.maxBlocks = opts.maxBlocks;
  }

  get blocksSinceAway(): number {
    return this.sinceAway;
  }

  recordBlock(kind: "block" | "repeat"): LadderSignal {
    this.sinceAway += 1;
    if (this.sinceAway >= this.maxBlocks) return "limit";
    if (kind === "repeat") return "none";

    this.sinceProgress += 1;
    if (this.sinceProgress < this.stuckBlocks) return "none";
    if (this.nudged) return "stuck-again";
    this.nudged = true;
    this.sinceProgress = 0;
    return "stuck";
  }

  recordProgress(): void {
    this.sinceProgress = 0;
    this.nudged = false;
  }

  reset(): void {
    this.sinceAway = 0;
    this.sinceProgress = 0;
    this.nudged = false;
  }
}
