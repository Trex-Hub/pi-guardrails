import { resolve } from "node:path";
import type { Action } from "../../src/core/types";

/** The action a held tool call stands for, in the shape `action-blocked` listeners expect. */
export function pausedHoldAction(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Action {
  if (toolName === "bash" || toolName === "powershell") {
    return {
      kind: "command",
      command: String(input.command ?? ""),
      origin: toolName,
    };
  }
  const raw = input.file_path ?? input.path;
  if (typeof raw === "string" && raw.trim()) {
    return { kind: "file", path: resolve(cwd, raw.trim()), origin: toolName };
  }
  return { kind: "command", command: toolName, origin: toolName };
}
