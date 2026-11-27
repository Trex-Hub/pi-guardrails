import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardrailsCard } from "../../src/core/delegation";
import type { PathAccessAlwaysScope } from "../../src/shared/config/types";
import { parkPrompt } from "../../src/shared/pi-live";
import {
  type createPathAccessPromptComponent,
  type PromptResult,
  promptOptions,
} from "./prompt";

const SAVED_TO: Record<PathAccessAlwaysScope, "project" | "global"> = {
  local: "project",
  global: "global",
};

export function pathPark(params: {
  events: ExtensionAPI["events"];
  id: string;
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  path: string;
  displayPath: string;
  directory: string;
  cwd: string;
  command?: string;
  reason: string;
  alwaysScope: PathAccessAlwaysScope;
  showFileOptions: boolean;
  dirGrantable: boolean;
  alwaysEnabled: boolean;
  signal?: AbortSignal;
  /** Away mode: close the prompt with `{ by: "timeout" }` after this many ms. */
  timeoutMs?: number;
  card?: GuardrailsCard;
  component: ReturnType<typeof createPathAccessPromptComponent>;
}) {
  let park: ReturnType<typeof parkPrompt<PromptResult | "timeout">> | undefined;
  let removeAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiresAt =
    params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
  const options = promptOptions(
    params.showFileOptions,
    params.dirGrantable,
    params.alwaysEnabled,
  ).map(({ result, label, disabled }) => ({
    result,
    label,
    ...(disabled
      ? { disabled: true as const, disabledReason: "project not trusted" }
      : {}),
  }));
  const factory: typeof params.component = (tui, theme, kb, onResult) => {
    park = parkPrompt<PromptResult | "timeout">({
      events: params.events,
      id: params.id,
      kind: "guardrails.path",
      title: `Outside workspace: ${params.displayPath}`,
      view: {
        toolCallId: params.toolCallId,
        ...(params.parentToolCallId !== undefined
          ? { parentToolCallId: params.parentToolCallId }
          : {}),
        toolName: params.toolName,
        path: params.path,
        displayPath: params.displayPath,
        directory: params.directory,
        cwd: params.cwd,
        target: params.showFileOptions ? "file" : "directory",
        ...(params.command !== undefined ? { command: params.command } : {}),
        reason: params.reason,
        ...(params.card ? { card: params.card } : {}),
        alwaysSavedTo: SAVED_TO[params.alwaysScope],
        options,
      },
      options,
      expiresAt,
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
    return params.component(tui, theme, kb, (value) =>
      currentPark.keyboard(value),
    );
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
