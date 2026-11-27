import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DelegationContext } from "../delegation/types";
import {
  GUARDRAILS_ADVISOR_REGISTER_EVENT,
  GUARDRAILS_ADVISOR_REQUEST_EVENT,
  type GuardrailsAdvisorRequestPayload,
} from "../events";
import type {
  AdvisorAnswer,
  AdvisorRegisterPayload,
  AdvisorSituation,
  GuardrailsAdvisor,
} from "./types";

export interface AdvisorRoster {
  list(): GuardrailsAdvisor[];
}

function isAdvisor(value: unknown): value is GuardrailsAdvisor {
  if (!value || typeof value !== "object") return false;
  const advisor = value as Record<string, unknown>;
  return (
    typeof advisor.id === "string" &&
    advisor.id.trim() !== "" &&
    typeof advisor.name === "string" &&
    typeof advisor.advise === "function"
  );
}

export function createAdvisorRoster(pi: ExtensionAPI): AdvisorRoster {
  const advisors = new Map<string, GuardrailsAdvisor>();

  const stopListening = pi.events.on(
    GUARDRAILS_ADVISOR_REGISTER_EVENT,
    (data) => {
      const advisor = (data as AdvisorRegisterPayload | undefined)?.advisor;
      if (!isAdvisor(advisor)) return;
      advisors.set(advisor.id, advisor);
    },
  );
  pi.on("session_shutdown", () => {
    stopListening();
    advisors.clear();
  });

  const request: GuardrailsAdvisorRequestPayload = {
    source: "guardrails",
    timestamp: new Date().toISOString(),
  };
  pi.events.emit(GUARDRAILS_ADVISOR_REQUEST_EVENT, request);

  return {
    list: () =>
      [...advisors.values()].filter((advisor) => {
        try {
          return advisor.isEnabled?.() ?? true;
        } catch {
          return false;
        }
      }),
  };
}

export function registerAdvisor(
  pi: ExtensionAPI,
  advisor: GuardrailsAdvisor,
): () => void {
  const payload: AdvisorRegisterPayload = { advisor };
  const stopListening = pi.events.on(GUARDRAILS_ADVISOR_REQUEST_EVENT, () => {
    pi.events.emit(GUARDRAILS_ADVISOR_REGISTER_EVENT, payload);
  });
  pi.events.emit(GUARDRAILS_ADVISOR_REGISTER_EVENT, payload);
  return stopListening;
}

/**
 * Runs every advisor in parallel under one deadline. A `pause` from any
 * advisor wins (first in roster order); otherwise the `advise` messages are
 * joined by a newline. Abstentions, errors and timeouts are ignored; if nothing
 * is left the result is `undefined`.
 */
export async function runAdvisors(
  advisors: readonly GuardrailsAdvisor[],
  situation: AdvisorSituation,
  ctx: Omit<DelegationContext, "signal">,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<AdvisorAnswer | undefined> {
  if (advisors.length === 0) return undefined;

  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = setTimeout(stop, options.timeoutMs);

  const aborted = new Promise<"aborted">((resolve) => {
    if (controller.signal.aborted) resolve("aborted");
    controller.signal.addEventListener("abort", () => resolve("aborted"), {
      once: true,
    });
  });
  const context: DelegationContext = { ...ctx, signal: controller.signal };

  const ask = async (
    advisor: GuardrailsAdvisor,
  ): Promise<AdvisorAnswer | undefined> => {
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => advisor.advise(situation, context)),
        aborted,
      ]);
      if (answer === "aborted") return undefined;
      if (answer?.action === "pause" && typeof answer.reason === "string") {
        return { action: "pause", reason: answer.reason };
      }
      if (
        answer?.action === "advise" &&
        typeof answer.message === "string" &&
        answer.message.trim() !== ""
      ) {
        return { action: "advise", message: answer.message.trim() };
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  try {
    const answers = await Promise.all(advisors.map(ask));
    const pause = answers.find((a) => a?.action === "pause");
    if (pause) return pause;
    const messages = answers.flatMap((a) =>
      a?.action === "advise" ? [a.message] : [],
    );
    return messages.length > 0
      ? { action: "advise", message: messages.join("\n") }
      : undefined;
  } finally {
    clearTimeout(timer);
    stop();
    options.signal?.removeEventListener("abort", stop);
  }
}

/** Roster factory for an extension: lazy, so off mode never emits the advisor request. */
export function lazyAdvisors(pi: ExtensionAPI): () => AdvisorRoster {
  let roster: AdvisorRoster | undefined;
  return () => {
    roster ??= createAdvisorRoster(pi);
    return roster;
  };
}
