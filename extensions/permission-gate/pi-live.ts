import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parkPrompt } from "../../src/shared/pi-live";
import { createPermissionGateConfirmComponent } from "./prompt";

export const COMMAND_OPTIONS = [
  { result: "allow", label: "Allow once" },
  { result: "allow-session", label: "Allow for session" },
  { result: "deny", label: "Deny" },
  { result: "stop", label: "Decline and stop" },
] as const;

type ConfirmResult = (typeof COMMAND_OPTIONS)[number]["result"];

export function commandPark(params: {
  events: ExtensionAPI["events"];
  id: string;
  toolName: string;
  command: string;
  reason: string;
  signal?: AbortSignal;
  inputGuardMs?: number;
}) {
  let park: ReturnType<typeof parkPrompt<ConfirmResult>> | undefined;
  let removeAbort: (() => void) | undefined;
  const component = createPermissionGateConfirmComponent(
    params.command,
    params.reason,
    params.inputGuardMs,
  );
  const factory: typeof component = (tui, theme, kb, onResult) => {
    park = parkPrompt({
      events: params.events,
      id: params.id,
      kind: "guardrails.command",
      title: `Dangerous command: ${params.reason}`,
      view: {
        toolName: params.toolName,
        command: params.command,
        reason: params.reason,
        options: COMMAND_OPTIONS,
      },
      options: COMMAND_OPTIONS,
      onResult,
    });
    const currentPark = park;
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
    dispose: () => {
      removeAbort?.();
      park?.dispose();
    },
  };
}
