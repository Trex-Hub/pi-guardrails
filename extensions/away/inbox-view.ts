import { truncateToWidth } from "@aliou/pi-utils-ui";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { cardLines } from "../../src/shared/away/card";
import type { DecisionKind } from "./decide";
import {
  decisionForKey,
  formatTime,
  type InboxRow,
  type InboxSnapshot,
  SECTION_TITLES,
} from "./inbox-model";

export interface ViewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const MAX_COMMAND_LINES = 30;

/** Short list row: project, session, state, time, then the label to fill the width. */
export function rowText(
  row: InboxRow,
  width: number,
  now: number = Date.now(),
): string {
  const head = [
    row.project,
    row.sessionLabel,
    row.sessionState,
    formatTime(row.item.createdAt, now),
  ].join("  ");
  return truncateToWidth(`${head}  ${row.label}`, Math.max(1, width));
}

function rawLines(row: InboxRow): string[] {
  const { action } = row.item;
  if (action.kind === "file") return [`Path: ${action.path}`];
  const lines = action.command.split("\n");
  const shown = lines.slice(0, MAX_COMMAND_LINES);
  if (lines.length > shown.length) {
    shown.push(`… ${lines.length - shown.length} more lines`);
  }
  return ["Command:", ...shown.map((line) => `  ${line}`)];
}

/**
 * The item's detail view. A card leads, in plain language, and the raw command
 * or path follows it. Without a card, the raw action and both reasons.
 */
export function detailLines(
  row: InboxRow,
  theme: ViewTheme,
  now: number = Date.now(),
): string[] {
  const { item } = row;
  const lines = [
    theme.bold(row.label),
    theme.fg(
      "dim",
      [
        row.project,
        row.sessionLabel,
        row.sessionState,
        formatTime(item.createdAt, now),
        `risk ${item.risk ?? "unrated"}`,
      ].join(" · "),
    ),
    "",
  ];
  if (item.card) {
    lines.push(...cardLines(item.card, theme), "");
  }
  lines.push(...rawLines(row));
  lines.push(`Flagged: ${item.flaggedReason}`);
  if (item.reason) lines.push(`Reviewers: ${item.reason}`);
  if (row.sessionState === "closed" && row.sessionFile) {
    lines.push(
      "",
      `Session is closed. Reopen it with: pi --session ${row.sessionFile}`,
    );
  }
  return lines;
}

function keysHelp(row: InboxRow | undefined, detail: boolean): string {
  const parts: string[] = [];
  if (row?.section === "allowed") {
    parts.push("f: fine", "w: shouldn't have run");
  } else if (row) {
    parts.push("a: approve once");
    if (row.section !== "urgent") parts.push("A: always allow");
    parts.push("r: reject");
  }
  if (!detail) parts.push("↑/↓: select", "enter: details");
  parts.push(detail ? "esc: back" : "esc: close");
  return parts.join(" • ");
}

export interface InboxViewDeps {
  tui: { requestRender(): void };
  theme: ViewTheme;
  done: () => void;
  load(): Promise<InboxSnapshot>;
  /** Applies a decision and returns a one-line message for the footer. */
  act(row: InboxRow, decision: DecisionKind): Promise<string>;
  now?: () => number;
}

/** The `/guardrails:inbox` list and detail view. */
export function createInboxView(deps: InboxViewDeps) {
  const now = deps.now ?? Date.now;
  let snapshot: InboxSnapshot = { rows: [], handled24h: 0 };
  let loaded = false;
  let selected = 0;
  let detail = false;
  let message = "";
  let busy = false;

  const current = () => snapshot.rows[selected];

  const reload = async () => {
    snapshot = await deps.load();
    loaded = true;
    selected = Math.max(0, Math.min(selected, snapshot.rows.length - 1));
    if (snapshot.rows.length === 0) detail = false;
    deps.tui.requestRender();
  };
  reload().catch(() => {
    loaded = true;
    deps.tui.requestRender();
  });

  const apply = async (row: InboxRow, decision: DecisionKind) => {
    busy = true;
    try {
      message = await deps.act(row, decision);
    } finally {
      busy = false;
    }
    detail = false;
    await reload();
  };

  return {
    render(width: number): string[] {
      const { theme } = deps;
      const out: string[] = [theme.bold("Guardrails inbox"), ""];
      const row = current();
      if (detail && row) {
        for (const line of detailLines(row, theme, now())) {
          out.push(...wrapTextWithAnsi(line, Math.max(1, width)));
        }
      } else if (!loaded) {
        out.push(theme.fg("dim", "Loading…"));
      } else if (snapshot.rows.length === 0) {
        out.push(theme.fg("dim", "Nothing waiting for you."));
      } else {
        let section: string | undefined;
        for (const [index, item] of snapshot.rows.entries()) {
          if (item.section !== section) {
            section = item.section;
            if (index > 0) out.push("");
            out.push(theme.fg("accent", SECTION_TITLES[item.section]));
          }
          const text = rowText(item, width - 2, now());
          out.push(
            index === selected
              ? `${theme.fg("accent", "▸")} ${theme.bold(text)}`
              : `  ${text}`,
          );
        }
      }
      out.push("");
      out.push(
        theme.fg("dim", `Handled in the last 24h: ${snapshot.handled24h}`),
      );
      if (message) out.push(message);
      out.push(theme.fg("dim", keysHelp(row, detail)));
      return out;
    },
    invalidate() {},
    handleInput(data: string): void {
      if (busy) return;
      if (matchesKey(data, Key.escape)) {
        if (detail) {
          detail = false;
          deps.tui.requestRender();
        } else {
          deps.done();
        }
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        selected = Math.max(0, selected - 1);
        deps.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        selected = Math.min(snapshot.rows.length - 1, selected + 1);
        deps.tui.requestRender();
        return;
      }
      const row = current();
      if (!row) return;
      if (matchesKey(data, Key.enter)) {
        detail = true;
        message = "";
        deps.tui.requestRender();
        return;
      }
      const decision = decisionForKey(row, data);
      if (decision) {
        apply(row, decision).catch(() => undefined);
      }
    },
    dispose() {},
  };
}
