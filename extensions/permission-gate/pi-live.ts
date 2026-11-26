import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardrailsCard } from "../../src/core/delegation";
import { parkPrompt } from "../../src/shared/pi-live";
import { createPermissionGateConfirmComponent } from "./prompt";

export const COMMAND_OPTIONS = [
  { result: "allow", label: "Allow once" },
  { result: "allow-session", label: "Allow for session" },
  { result: "deny", label: "Deny" },
  { result: "stop", label: "Decline and stop" },
] as const;

/** `"timeout"` is internal: it is never offered to clients or shown as an option. */
type ConfirmResult = (typeof COMMAND_OPTIONS)[number]["result"] | "timeout";

export function commandPark(params: {
  events: ExtensionAPI["events"];
  id: string;
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  command: string;
  reason: string;
  signal?: AbortSignal;
  inputGuardMs?: number;
  /** Away mode: close the prompt with `{ by: "timeout" }` after this many ms. */
  timeoutMs?: number;
  card?: GuardrailsCard;
}) {
  let park: ReturnType<typeof parkPrompt<ConfirmResult>> | undefined;
  let removeAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiresAt =
    params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
  const component = createPermissionGateConfirmComponent(
    params.command,
    params.reason,
    params.inputGuardMs,
    { expiresAt, card: params.card },
  );
  const factory: typeof component = (tui, theme, kb, onResult) => {
    park = parkPrompt<ConfirmResult>({
      events: params.events,
      id: params.id,
      kind: "guardrails.command",
      title: `Dangerous command: ${params.reason}`,
      view: {
        toolCallId: params.toolCallId,
        ...(params.parentToolCallId !== undefined
          ? { parentToolCallId: params.parentToolCallId }
          : {}),
        toolName: params.toolName,
        command: params.command,
        reason: params.reason,
        ...(params.card ? { card: params.card } : {}),
        options: COMMAND_OPTIONS,
      },
      expiresAt,
      options: COMMAND_OPTIONS,
      onResult,
    });
    const currentPark = park;
    if (params.timeoutMs !== undefined) {
      timer = setTimeout(
        () => currentPark.timeout("timeout"),
        params.timeoutMs,
      );
    }
    const abort = () => {
      currentPark.abort("deny");
    };
    if (params.signal) {
      params.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => params.signal?.removeEventListener("abort", abort);
      if (params.signal.aborted) abort();
    }
    return component(tui, theme, kb, (value) => currentPark.keyboard(value));
  };
  return {
    factory,
    /** How the prompt closed, once the custom prompt has been shown. */
    closedBy: () => park?.closedBy(),
    dispose: () => {
      if (timer) clearTimeout(timer);
      removeAbort?.();
      park?.dispose();
    },
  };
}
