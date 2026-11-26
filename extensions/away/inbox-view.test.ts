import { describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../../src/shared/away/inbox";
import type { InboxRow, InboxSnapshot } from "./inbox-model";
import { createInboxView, detailLines, rowText } from "./inbox-view";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const NOW = Date.parse("2026-03-10T12:00:00");

function row(
  id: string,
  extra: Partial<InboxRow> = {},
  item: Partial<InboxItem> = {},
): InboxRow {
  const base: InboxItem = {
    version: 1,
    id,
    kind: "waiting",
    cause: "away",
    createdAt: "2026-03-10T10:00:00",
    session: { id: "abcdef123456", cwd: "/work/proj" },
    feature: "permissionGate",
    toolName: "bash",
    toolCallId: "tc",
    action: { kind: "command", command: "sudo rm -rf /var/tmp/x" },
    flaggedReason: "superuser command",
    reason: "both reviewers unsure",
    risk: "high",
    ...item,
  };
  return {
    item: base,
    section: "waiting",
    project: "proj",
    sessionLabel: "abcdef12",
    sessionState: "idle",
    label: "sudo rm -rf /var/tmp/x",
    ...extra,
  };
}

describe("rowText", () => {
  it("has project, session, state, time and label, truncated to the width", () => {
    const text = rowText(row("a"), 200, NOW);
    expect(text).toBe("proj  abcdef12  idle  10:00  sudo rm -rf /var/tmp/x");
    const short = rowText(row("a"), 20, NOW);
    expect(short.length).toBeLessThanOrEqual(20);
  });
});

describe("detailLines", () => {
  it("leads with the plain-language card, then the raw command, then both reasons", () => {
    const lines = detailLines(
      row(
        "a",
        {},
        {
          card: {
            summary: "Deletes a temp folder as root",
            steps: [{ part: "sudo", meaning: "run as admin" }],
            risk: "medium",
          },
        },
      ),
      theme,
      NOW,
    );
    const text = lines.join("\n");
    const iCard = text.indexOf("Deletes a temp folder as root");
    const iRaw = text.indexOf("Command:");
    const iFlag = text.indexOf("Flagged: superuser command");
    const iReason = text.indexOf("Reviewers: both reviewers unsure");
    expect(iCard).toBeGreaterThan(-1);
    expect(iCard).toBeLessThan(iRaw);
    expect(iRaw).toBeLessThan(iFlag);
    expect(iFlag).toBeLessThan(iReason);
    expect(text).toContain("sudo rm -rf /var/tmp/x");
    expect(text).toContain("risk high");
  });

  it("without a card shows the raw command and both reasons", () => {
    const text = detailLines(row("a"), theme, NOW).join("\n");
    expect(text).toContain("Command:");
    expect(text).toContain("sudo rm -rf /var/tmp/x");
    expect(text).toContain("Flagged: superuser command");
    expect(text).toContain("Reviewers: both reviewers unsure");
    expect(text).not.toContain("What it wants to do");
  });

  it("shows a file path for file actions", () => {
    const text = detailLines(
      row(
        "a",
        {},
        { action: { kind: "file", path: "/etc/hosts" }, toolName: "write" },
      ),
      theme,
      NOW,
    ).join("\n");
    expect(text).toContain("Path: /etc/hosts");
  });

  it("caps very long commands", () => {
    const command = Array.from({ length: 80 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const text = detailLines(
      row("a", {}, { action: { kind: "command", command } }),
      theme,
      NOW,
    ).join("\n");
    expect(text).toContain("… 50 more lines");
  });

  it("a closed session shows how to reopen it", () => {
    const text = detailLines(
      row("a", { sessionState: "closed", sessionFile: "/s/a b.jsonl" }),
      theme,
      NOW,
    ).join("\n");
    expect(text).toContain("pi --session /s/a b.jsonl");
    const open = detailLines(
      row("a", { sessionFile: "/s/a.jsonl" }),
      theme,
      NOW,
    ).join("\n");
    expect(open).not.toContain("pi --session");
  });
});

function setup(
  rows: InboxRow[],
  act = vi.fn(async (_row: InboxRow, _decision: string) => "Approved once."),
) {
  let snapshot: InboxSnapshot = { rows, handled24h: 3 };
  const load = vi.fn(async () => snapshot);
  const requestRender = vi.fn();
  const done = vi.fn();
  const view = createInboxView({
    tui: { requestRender },
    theme,
    done,
    load,
    act,
    now: () => NOW,
  });
  return {
    view,
    act,
    done,
    load,
    setRows: (next: InboxRow[]) => {
      snapshot = { rows: next, handled24h: 4 };
    },
    text: (width = 100) => view.render(width).join("\n"),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("inbox view", () => {
  it("shows sections in order with the 24h footer and selection marker", async () => {
    const { text } = setup([
      row("u", { section: "urgent" }),
      row("w"),
      row("a", { section: "allowed" }),
    ]);
    await settle();
    const out = text();
    expect(out.indexOf("Urgent")).toBeLessThan(out.indexOf("Waiting for you"));
    expect(out.indexOf("Waiting for you")).toBeLessThan(
      out.indexOf("Allowed while you were away"),
    );
    expect(out).toContain("▸");
    expect(out).toContain("Handled in the last 24h: 3");
  });

  it("says so when empty", async () => {
    const { text } = setup([]);
    await settle();
    expect(text()).toContain("Nothing waiting for you.");
  });

  it("↑/↓ select; keys act on the selected row only", async () => {
    const t = setup([row("one"), row("two")]);
    await settle();
    t.view.handleInput("j");
    t.view.handleInput("r");
    await settle();
    expect(t.act).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ id: "two" }) }),
      "reject",
    );
  });

  it("a, A and r on a waiting row; f and w do nothing", async () => {
    const t = setup([row("one")]);
    await settle();
    t.view.handleInput("f");
    t.view.handleInput("w");
    await settle();
    expect(t.act).not.toHaveBeenCalled();
    t.view.handleInput("a");
    await settle();
    t.view.handleInput("A");
    await settle();
    t.view.handleInput("r");
    await settle();
    expect(t.act.mock.calls.map((c) => c[1])).toEqual([
      "approve",
      "approve-always",
      "reject",
    ]);
  });

  it("A on an urgent row does nothing and its help does not offer it", async () => {
    const t = setup([row("one", { section: "urgent" })]);
    await settle();
    t.view.handleInput("A");
    await settle();
    expect(t.act).not.toHaveBeenCalled();
    const out = t.text();
    expect(out).toContain("a: approve once");
    expect(out).toContain("r: reject");
    expect(out).not.toContain("always allow");
    t.view.handleInput("a");
    await settle();
    expect(t.act.mock.calls.map((c) => c[1])).toEqual(["approve"]);
  });

  it("f and w on an allowed row; a does nothing", async () => {
    const t = setup([row("one", { section: "allowed" })]);
    await settle();
    t.view.handleInput("a");
    t.view.handleInput("f");
    await settle();
    t.view.handleInput("w");
    await settle();
    expect(t.act.mock.calls.map((c) => c[1])).toEqual(["fine", "wrong"]);
  });

  it("shows the action message and reloads after a decision", async () => {
    const t = setup([row("one"), row("two")]);
    await settle();
    t.setRows([row("two")]);
    t.view.handleInput("a");
    await settle();
    const out = t.text();
    expect(out).toContain("Approved once.");
    expect(out).toContain("Handled in the last 24h: 4");
    expect(out).not.toContain("one");
    expect(t.load).toHaveBeenCalledTimes(2);
  });

  it("enter opens the detail, esc goes back, then esc closes", async () => {
    const t = setup([row("one")]);
    await settle();
    t.view.handleInput("\r");
    expect(t.text()).toContain("Flagged: superuser command");
    t.view.handleInput("\x1b");
    expect(t.done).not.toHaveBeenCalled();
    expect(t.text()).toContain("Waiting for you");
    t.view.handleInput("\x1b");
    expect(t.done).toHaveBeenCalledTimes(1);
  });

  it("decision keys work from the detail view", async () => {
    const t = setup([row("one")]);
    await settle();
    t.view.handleInput("\r");
    t.view.handleInput("r");
    await settle();
    expect(t.act).toHaveBeenCalledTimes(1);
  });

  it("ignores input while an action is running", async () => {
    let release: (value: string) => void = () => undefined;
    const slow = vi.fn(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const t = setup([row("one")], slow);
    await settle();
    t.view.handleInput("a");
    t.view.handleInput("r");
    expect(slow).toHaveBeenCalledTimes(1);
    release("Rejected.");
    await settle();
  });
});
