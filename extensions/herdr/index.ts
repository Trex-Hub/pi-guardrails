import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  GUARDRAILS_AWAY_PAUSED_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  type GuardrailsPromptClosedPayload,
  type GuardrailsPromptOpenedPayload,
} from "../../src/shared/events";

const HERDR_BLOCKED_EVENT = "herdr:blocked";

export default function herdr(pi: ExtensionAPI): void {
  const activePrompts = new Set<string>();

  const stopListeningForOpened = pi.events.on(
    GUARDRAILS_PROMPT_OPENED_EVENT,
    (data) => {
      const payload = data as GuardrailsPromptOpenedPayload | undefined;
      const id = payload?.prompt?.id;
      if (!id || activePrompts.has(id)) return;

      activePrompts.add(id);
      pi.events.emit(HERDR_BLOCKED_EVENT, {
        active: true,
        label: "Guardrails approval required",
      });
    },
  );

  const stopListeningForClosed = pi.events.on(
    GUARDRAILS_PROMPT_CLOSED_EVENT,
    (data) => {
      const payload = data as GuardrailsPromptClosedPayload | undefined;
      const id = payload?.prompt?.id;
      if (!id || !activePrompts.delete(id)) return;

      pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    },
  );

  // Subscribed per session (not at load) so a reload does not leave a stale listener.
  let stopListeningForPaused: (() => void) | undefined;

  pi.on("session_start", () => {
    stopListeningForPaused?.();
    stopListeningForPaused = pi.events.on(
      GUARDRAILS_AWAY_PAUSED_EVENT,
      (data) => {
        const payload = data as { paused?: boolean } | undefined;
        if (payload?.paused === true) {
          pi.events.emit(HERDR_BLOCKED_EVENT, {
            active: true,
            label: "Guardrails paused: waiting for you",
          });
        } else if (payload?.paused === false) {
          pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
        }
      },
    );
  });

  pi.on("session_shutdown", () => {
    for (const _id of activePrompts) {
      pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    }
    activePrompts.clear();
    stopListeningForOpened();
    stopListeningForClosed();
    stopListeningForPaused?.();
    stopListeningForPaused = undefined;
  });
}
