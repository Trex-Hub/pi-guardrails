import { readDecisions, readItems } from "../../src/shared/away/inbox";
import { configLoader } from "../../src/shared/config";

/** Approvals of one category needed before a standing permission is suggested. */
export const SUGGEST_MIN_APPROVALS = 5;
/** How far back approvals count. */
export const SUGGEST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const POSITIVE = new Set(["approve", "approve-always", "fine"]);

/** Categories already asked about, per session: a "no" is never asked again. */
const asked = new Map<string, Set<string>>();

export function resetSuggestions(): void {
  asked.clear();
}

/** Items of `category` decided approve, approve-always or fine within the window. */
export async function countApprovals(
  category: string,
  now = Date.now(),
): Promise<number> {
  const all = await readItems();
  const items = all.filter((item) => item.card?.category === category);
  if (items.length === 0) return 0;
  const decisions = await readDecisions(items.map((item) => item.id));
  return decisions.filter((decision) => {
    const at = Date.parse(decision.decidedAt);
    return (
      POSITIVE.has(decision.decision) &&
      Number.isFinite(at) &&
      now - at <= SUGGEST_WINDOW_MS
    );
  }).length;
}

/**
 * Whether to suggest `category` now: positive decision on a categorised item,
 * enough recent approvals, not already a standing permission, and not asked
 * about earlier in this session. Marks it as asked.
 */
export async function shouldSuggest(
  sessionId: string,
  category: string | undefined,
): Promise<boolean> {
  const trimmed = category?.trim();
  if (!trimmed) return false;
  const done = asked.get(sessionId) ?? new Set<string>();
  if (done.has(trimmed)) return false;
  const existing = configLoader.getConfig().away?.standingPermissions ?? [];
  if (existing.includes(trimmed)) return false;
  const approvals = await countApprovals(trimmed);
  if (approvals < SUGGEST_MIN_APPROVALS) return false;
  done.add(trimmed);
  asked.set(sessionId, done);
  return true;
}

/** Appends `category` to the GLOBAL `away.standingPermissions`. Throws if the save fails. */
export async function addStandingPermission(category: string): Promise<void> {
  const raw = (configLoader.getRawConfig("global") ?? {}) as Record<
    string,
    unknown
  >;
  const away = (raw.away ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(away.standingPermissions)
    ? (away.standingPermissions as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  if (existing.includes(category)) return;
  await configLoader.save("global", {
    ...raw,
    away: { ...away, standingPermissions: [...existing, category] },
  });
}

export function isPositiveDecision(decision: string): boolean {
  return POSITIVE.has(decision);
}
