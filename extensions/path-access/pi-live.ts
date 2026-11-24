import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PathAccessAlwaysScope } from "../../src/shared/config/types";
import { parkPrompt } from "../../src/shared/pi-live";

const SAVED_TO: Record<PathAccessAlwaysScope, "project" | "global"> = {
  local: "project",
  global: "global",
};

import {
  type createPathAccessPromptComponent,
  type PromptResult,
  promptOptions,
} from "./prompt";

export function pathPark(params: {
  events: ExtensionAPI["events"];
  id: string;
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
  component: ReturnType<typeof createPathAccessPromptComponent>;
}) {
  let park: ReturnType<typeof parkPrompt<PromptResult>> | undefined;
  let removeAbort: (() => void) | undefined;
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
    park = parkPrompt({
      events: params.events,
      id: params.id,
      kind: "guardrails.path",
      title: `Outside workspace: ${params.displayPath}`,
      view: {
        toolName: params.toolName,
        path: params.path,
        displayPath: params.displayPath,
        directory: params.directory,
        cwd: params.cwd,
        target: params.showFileOptions ? "file" : "directory",
        ...(params.toolName === "bash" && params.command !== undefined
          ? { command: params.command }
          : {}),
        reason: params.reason,
        alwaysSavedTo: SAVED_TO[params.alwaysScope],
        options,
      },
      options,
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
    return params.component(tui, theme, kb, (value) =>
      currentPark.keyboard(value),
    );
  };
  return {
    factory,
    dispose: () => {
      removeAbort?.();
      park?.dispose();
    },
  };
}
