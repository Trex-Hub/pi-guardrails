import type { Action } from "../../core/types";

/** Exact strings sent to the agent in away mode. */
export const DEFERRED =
  "Queued for the user's approval; the user is away. Don't retry this or do the same thing another way. Continue with other work, and list this under \"needs approval\" in your final summary.";
export const DENIED_SUFFIX =
  "Don't do this, and don't do the same thing another way.";
export const REPEAT_QUEUED =
  "Already queued for the user's approval. Don't retry it; continue with other work.";
export const REPEAT_DENIED =
  "Already denied. Don't retry it or do the same thing another way.";
export const NUDGE =
  "Several actions in a row need the user's approval. Continue with work that doesn't need them, or wrap up with a summary of what is waiting.";
export const PAUSED_HOLD =
  "Guardrails paused this run until the user returns. Stop and summarize.";

export const advice = (message: string): string => `Supervisor: ${message}`;
export const paused = (why: string): string =>
  `Guardrails paused this run: ${why.replace(/[.\s]+$/, "")}. Stop here and summarize what you did and what is waiting for the user's approval.`;
export const approved = (label: string): string =>
  `Guardrails: the user approved this action. You can run it now: ${label}`;
export const rejected = (label: string): string =>
  `Guardrails: the user rejected this action. Don't do it, or the same thing another way: ${label}`;

/** The `<why>` values for `paused()`. */
export const pausedWhy = {
  limit: (maxBlocks: number) => `too many blocked actions (${maxBlocks})`,
  stuck: () => "the agent kept getting blocked without progress",
  advisor: (reason: string) => reason,
  severe: (reason: string) => `a severe action was blocked: ${reason}`,
};

/** Appends a suffix (nudge, advice) to a block reason after a blank line. */
export function withSuffix(reason: string, suffix: string): string {
  return `${reason}\n\n${suffix}`;
}

/** `<label>`: the command for commands, `<toolName> <absolute path>` for files. */
export function actionLabel(action: Action, toolName: string): string {
  return action.kind === "command"
    ? action.command
    : `${toolName} ${action.path}`;
}
