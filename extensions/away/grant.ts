import type { Action } from "../../src/core/types";
import { configLoader } from "../../src/shared/config";
import type { PatternConfig } from "../../src/shared/config/types";
import { createPendingGrant, persistGrant } from "../path-access/grants";
import { exactCommandPattern } from "../permission-gate/grants";

/**
 * Saves "always allow" for an action to the GLOBAL config: an exact-command
 * pattern for a command, or an exact file grant for a file. Throws when the
 * save fails, so the caller can skip writing the decision.
 */
export async function saveGlobalGrant(action: Action): Promise<void> {
  if (action.kind === "file") {
    await persistGrant(createPendingGrant(action.path, false, "global"));
    return;
  }
  const raw = (configLoader.getRawConfig("global") ?? {}) as Record<
    string,
    unknown
  >;
  const gate = (raw.permissionGate ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(gate.allowedPatterns)
    ? (gate.allowedPatterns as PatternConfig[])
    : [];
  const pattern = exactCommandPattern(action.command);
  const present = existing.some(
    (entry) =>
      typeof entry === "object" && entry !== null && entry.pattern === pattern,
  );
  if (present) return;
  await configLoader.save("global", {
    ...raw,
    permissionGate: {
      ...gate,
      allowedPatterns: [...existing, { pattern, regex: true }],
    },
  });
}
