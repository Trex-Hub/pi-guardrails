import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GuardrailsCard, Risk } from "../../core/delegation";
import type { Action } from "../../core/types";
import { emitAwayItem, type GuardrailsFeatureId } from "../events";

export interface InboxItem {
  version: 1;
  id: string;
  kind: "waiting" | "allowed" | "urgent";
  cause: "away" | "timeout" | "headless" | "tripwire";
  createdAt: string;
  session: { id: string; file?: string; name?: string; cwd: string };
  feature: GuardrailsFeatureId;
  toolName: string;
  toolCallId: string;
  action: Action;
  /** Why the gate flagged it. */
  flaggedReason: string;
  /** Merged delegate reason, or "" when there were no delegates. */
  reason: string;
  risk: Risk;
  card?: GuardrailsCard;
}

export interface InboxDecision {
  version: 1;
  /** The item id. */
  id: string;
  decision: "approve" | "approve-always" | "reject" | "fine" | "wrong";
  decidedAt: string;
  decidedBy:
    | { kind: "inbox"; sessionId: string }
    | { kind: "pi-live"; client: string };
}

export interface SessionStatus {
  version: 1;
  sessionId: string;
  file?: string;
  name?: string;
  cwd: string;
  pid: number;
  state: "running" | "idle" | "paused";
  presence: "present" | "away";
  updatedAt: string;
}

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ALIVE_WINDOW_MS = 10 * 60 * 1000;

const ITEM_SUFFIX = ".item.json";
const DECISION_SUFFIX = ".decision.json";
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const ITEM_KINDS = ["waiting", "allowed", "urgent"];
const DECISIONS = ["approve", "approve-always", "reject", "fine", "wrong"];

export function inboxDir(): string {
  return join(getAgentDir(), "guardrails", "inbox");
}

export function sessionsDir(): string {
  return join(getAgentDir(), "guardrails", "sessions");
}

function isItem(value: unknown): value is InboxItem {
  const item = value as Partial<InboxItem> | null;
  return (
    typeof item === "object" &&
    item !== null &&
    item.version === 1 &&
    typeof item.id === "string" &&
    ITEM_KINDS.includes(item.kind as string) &&
    typeof item.session === "object" &&
    item.session !== null &&
    typeof item.action === "object" &&
    item.action !== null
  );
}

function isDecision(value: unknown): value is InboxDecision {
  const decision = value as Partial<InboxDecision> | null;
  return (
    typeof decision === "object" &&
    decision !== null &&
    decision.version === 1 &&
    typeof decision.id === "string" &&
    DECISIONS.includes(decision.decision as string) &&
    typeof decision.decidedAt === "string"
  );
}

function isStatus(value: unknown): value is SessionStatus {
  const status = value as Partial<SessionStatus> | null;
  return (
    typeof status === "object" &&
    status !== null &&
    status.version === 1 &&
    typeof status.sessionId === "string" &&
    typeof status.pid === "number"
  );
}

function tempName(final: string): string {
  return `${final}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function isTemp(name: string): boolean {
  return name.includes(".tmp-");
}

async function writeTemp(final: string, data: unknown): Promise<string> {
  await mkdir(join(final, ".."), { recursive: true });
  const tmp = tempName(final);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return tmp;
}

async function writeAtomic(final: string, data: unknown): Promise<void> {
  const tmp = await writeTemp(final, data);
  try {
    await rename(tmp, final);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Writes `final` only if it does not exist. The data lands in a temp file
 * first; a hard link then claims the final name atomically, so a reader never
 * sees a partial file and the first writer wins. Returns false when the file
 * already exists.
 */
async function writeExclusive(final: string, data: unknown): Promise<boolean> {
  const tmp = await writeTemp(final, data);
  try {
    try {
      await link(tmp, final);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      // Filesystem without hard links: check, then rename (small race).
      if (await exists(final)) return false;
      await rename(tmp, final);
      return true;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Parsed JSON of a file, or undefined when it is unreadable or half-written. */
async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJsonFiles<T>(
  dir: string,
  suffix: string,
  guard: (value: unknown) => value is T,
  idOf: (value: T) => string,
): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    if (isTemp(name) || !name.endsWith(suffix)) continue;
    const parsed = await readJson(join(dir, name));
    if (!guard(parsed)) continue;
    if (name !== `${idOf(parsed)}${suffix}`) continue;
    out.push(parsed);
  }
  return out;
}

function safeId(id: string): boolean {
  return SAFE_ID.test(id) && id !== "." && id !== "..";
}

function sessionFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** Writes an item once. Returns false when it could not be written. */
export async function writeItem(item: InboxItem): Promise<boolean> {
  if (!safeId(item.id)) return false;
  try {
    return await writeExclusive(
      join(inboxDir(), `${item.id}${ITEM_SUFFIX}`),
      item,
    );
  } catch {
    return false;
  }
}

/** Writes an item and emits `guardrails:away:item`. Every item goes through here. */
export async function publishItem(
  pi: ExtensionAPI,
  item: InboxItem,
): Promise<boolean> {
  const written = await writeItem(item);
  if (written) emitAwayItem(pi, item);
  return written;
}

/**
 * Writes a decision once. Returns false if a decision already exists (the
 * first decision wins) or the write failed.
 */
export async function writeDecision(decision: InboxDecision): Promise<boolean> {
  if (!safeId(decision.id)) return false;
  try {
    return await writeExclusive(
      join(inboxDir(), `${decision.id}${DECISION_SUFFIX}`),
      decision,
    );
  } catch {
    return false;
  }
}

export async function readItems(): Promise<InboxItem[]> {
  return readJsonFiles(inboxDir(), ITEM_SUFFIX, isItem, (i) => i.id);
}

/** One item by id, or undefined when it is missing or unreadable. */
export async function readItem(id: string): Promise<InboxItem | undefined> {
  if (!safeId(id)) return undefined;
  const parsed = await readJson(join(inboxDir(), `${id}${ITEM_SUFFIX}`));
  return isItem(parsed) && parsed.id === id ? parsed : undefined;
}

export async function readDecisions(
  ids?: readonly string[],
): Promise<InboxDecision[]> {
  if (ids) {
    // Read only the files asked for: the dir is shared by every session.
    const out: InboxDecision[] = [];
    for (const id of ids) {
      if (!safeId(id)) continue;
      const parsed = await readJson(
        join(inboxDir(), `${id}${DECISION_SUFFIX}`),
      );
      if (isDecision(parsed) && parsed.id === id) out.push(parsed);
    }
    return out;
  }
  return readJsonFiles(inboxDir(), DECISION_SUFFIX, isDecision, (d) => d.id);
}

export async function writeSessionStatus(
  status: SessionStatus,
): Promise<boolean> {
  try {
    await writeAtomic(
      join(sessionsDir(), sessionFileName(status.sessionId)),
      status,
    );
    return true;
  } catch {
    return false;
  }
}

export async function removeSessionStatus(sessionId: string): Promise<void> {
  try {
    await unlink(join(sessionsDir(), sessionFileName(sessionId)));
  } catch {
    return;
  }
}

export async function readSessionStatuses(): Promise<SessionStatus[]> {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionStatus[] = [];
  for (const name of names) {
    if (isTemp(name) || !name.endsWith(".json")) continue;
    const parsed = await readJson(join(dir, name));
    if (isStatus(parsed)) out.push(parsed);
  }
  return out;
}

/**
 * Whether the session behind a status file is still running: its pid is alive,
 * or the pid check was refused (EPERM) and the status is under 10 minutes old.
 */
export function isSessionAlive(
  status: SessionStatus,
  now: number = Date.now(),
): boolean {
  try {
    process.kill(status.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    const updated = Date.parse(status.updatedAt);
    return Number.isFinite(updated) && now - updated <= ALIVE_WINDOW_MS;
  }
}

/**
 * Deletes items whose decision is older than 14 days along with that decision,
 * and orphan decisions older than 14 days. Items without a decision stay.
 */
export async function prune(now: number = Date.now()): Promise<void> {
  const dir = inboxDir();
  const [items, decisions] = await Promise.all([readItems(), readDecisions()]);
  const itemIds = new Set(items.map((i) => i.id));
  for (const decision of decisions) {
    const decided = Date.parse(decision.decidedAt);
    if (!Number.isFinite(decided) || now - decided <= RETENTION_MS) continue;
    await unlink(join(dir, `${decision.id}${DECISION_SUFFIX}`)).catch(
      () => undefined,
    );
    if (itemIds.has(decision.id)) {
      await unlink(join(dir, `${decision.id}${ITEM_SUFFIX}`)).catch(
        () => undefined,
      );
    }
  }
}
