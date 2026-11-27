import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AdvisorSituation {
  reason: "stuck";
  /** Actions Guardrails stopped, newest last. */
  blocked: { toolName: string; outcome: "deferred" | "denied" }[];
  blocksSinceAway: number;
  standingPermissions: string[];
}

/**
 * A minimal advisor. Guardrails asks advisors what to do when a run is stuck
 * in away mode: it can advise the agent or pause the run. It can never allow
 * an action. Return undefined to abstain (Guardrails then sends its own nudge).
 */
export default function nudge(pi: ExtensionAPI) {
  const advisor = {
    id: "example:nudge",
    name: "nudge",
    advise(situation: AdvisorSituation) {
      if (situation.blocksSinceAway >= 20) {
        return {
          action: "pause" as const,
          reason: "many actions are waiting for approval",
        };
      }
      return {
        action: "advise" as const,
        message:
          "Skip the blocked steps, finish what you can without them, and list them under 'needs approval'.",
      };
    },
  };

  const register = () =>
    pi.events.emit("guardrails:advisor:register", { advisor });
  pi.events.on("guardrails:advisor:request", register);
  register();
}
