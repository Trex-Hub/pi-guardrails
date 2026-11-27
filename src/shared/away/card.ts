import type { GuardrailsCard } from "../../core/delegation";

export interface CardTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Plain-language card as themed lines for a prompt or the inbox. */
export function cardLines(card: GuardrailsCard, theme: CardTheme): string[] {
  const label = (text: string) => theme.fg("dim", theme.bold(text));
  const lines = [`${label("What it wants to do")}  ${card.summary}`];
  if (card.why) lines.push(`${label("Why it was stopped")}  ${card.why}`);
  if (card.steps?.length) {
    lines.push(label("Step by step"));
    for (const step of card.steps) {
      lines.push(`  ${theme.fg("accent", step.part)}  ${step.meaning}`);
    }
  }
  if (card.risk) lines.push(`${label("Risk")}  ${card.risk}`);
  if (card.worthKnowing) {
    lines.push(`${label("Worth knowing")}  ${card.worthKnowing}`);
  }
  return lines;
}

/** `m:ss` for a remaining time in milliseconds, never negative. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
