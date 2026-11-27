export type DelegateVerdict = "allow" | "block" | "ask";

export const DELEGATE_VERDICTS: readonly DelegateVerdict[] = [
  "allow",
  "block",
  "ask",
];

export type Risk = "low" | "high";

export interface GuardrailsCard {
  /** What it wants to do, in one or two plain sentences. */
  summary: string;
  /** Why it was stopped, in plain words. */
  why?: string;
  /** Each part of the command and what it means. */
  steps?: { part: string; meaning: string }[];
  /** Low or higher risk, and why. */
  risk?: string;
  /** One thing worth learning from this item. */
  worthKnowing?: string;
  /** Short label grouping similar actions, e.g. "delete build output". Used for standing-permission suggestions. */
  category?: string;
}

export interface DelegateAnswer {
  verdict: DelegateVerdict;
  reason: string;
  details?: unknown;
  /** Risk of the action. Only `"low"` can let an unsure action run while the user is away. */
  risk?: Risk;
  /** Only read on verdict "block": high impact and clearly outside the user's request. */
  severe?: boolean;
  /** Plain-language explanation of the action. */
  card?: GuardrailsCard;
}

export type DelegateStatus =
  | "answered"
  | "abstained"
  | "timeout"
  | "error"
  | "cancelled";

export interface DelegateOutcome {
  delegateId: string;
  delegateName: string;
  status: DelegateStatus;
  answer?: DelegateAnswer;
  error?: string;
  elapsedMs: number;
}

export interface DelegationResult {
  verdict: DelegateVerdict;
  reason: string;
  outcomes: DelegateOutcome[];
}

export function isDelegateAnswer(value: unknown): value is DelegateAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Record<string, unknown>;
  return (
    typeof answer.verdict === "string" &&
    (DELEGATE_VERDICTS as readonly string[]).includes(answer.verdict) &&
    typeof answer.reason === "string"
  );
}

function sanitizeCard(value: unknown): GuardrailsCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") {
    return undefined;
  }
  const card: GuardrailsCard = { summary: raw.summary };
  for (const key of ["why", "risk", "worthKnowing", "category"] as const) {
    const field = raw[key];
    if (typeof field === "string") card[key] = field;
  }
  if (Array.isArray(raw.steps)) {
    const steps = raw.steps.flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const { part, meaning } = step as Record<string, unknown>;
      return typeof part === "string" && typeof meaning === "string"
        ? [{ part, meaning }]
        : [];
    });
    card.steps = steps;
  }
  return card;
}

/**
 * Drops invalid optional extras (`risk`, `severe`, `card`) from an answer
 * without affecting its validity. Returns a new object; the input is not
 * mutated.
 */
export function sanitizeAnswerExtras(answer: DelegateAnswer): DelegateAnswer {
  const { risk, severe, card, ...rest } = answer;
  const clean: DelegateAnswer = { ...rest };
  if (risk === "low" || risk === "high") clean.risk = risk;
  if (severe === true) clean.severe = true;
  const cleanCard = sanitizeCard(card);
  if (cleanCard) clean.card = cleanCard;
  return clean;
}

function describeNonAnswer(outcome: DelegateOutcome): string {
  switch (outcome.status) {
    case "abstained":
      return `${outcome.delegateName} abstained`;
    case "timeout":
      return `${outcome.delegateName} timed out`;
    case "error":
      return `${outcome.delegateName} failed${outcome.error ? ` (${outcome.error})` : ""}`;
    case "cancelled":
      return `${outcome.delegateName} was cancelled`;
    default:
      return `${outcome.delegateName} did not answer`;
  }
}

function labeled(outcome: DelegateOutcome, reason: string): string {
  return `${outcome.delegateName}: ${reason}`;
}

export function combineDelegateOutcomes(
  outcomes: readonly DelegateOutcome[],
): DelegationResult {
  const list = [...outcomes];

  const blocking = list.find(
    (o) => o.status === "answered" && o.answer?.verdict === "block",
  );
  if (blocking?.answer) {
    return {
      verdict: "block",
      reason: labeled(blocking, blocking.answer.reason),
      outcomes: list,
    };
  }

  if (list.length === 0) {
    return {
      verdict: "ask",
      reason: "no decision delegates are registered",
      outcomes: list,
    };
  }

  const allAllow = list.every(
    (o) => o.status === "answered" && o.answer?.verdict === "allow",
  );
  if (allAllow) {
    return {
      verdict: "allow",
      reason: list
        .map((o) => labeled(o, o.answer?.reason ?? "allowed"))
        .join("; "),
      outcomes: list,
    };
  }

  const asking = list.find(
    (o) => o.status === "answered" && o.answer?.verdict === "ask",
  );
  if (asking?.answer) {
    return {
      verdict: "ask",
      reason: labeled(asking, asking.answer.reason),
      outcomes: list,
    };
  }

  const missing = list.find((o) => o.status !== "answered");
  return {
    verdict: "ask",
    reason: missing ? describeNonAnswer(missing) : "delegates did not agree",
    outcomes: list,
  };
}
