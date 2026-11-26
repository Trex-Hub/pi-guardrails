import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readItems } from "../../src/shared/away/inbox";
import { clearAwayState } from "../../src/shared/away/state";
import type { ResolvedConfig } from "../../src/shared/config";
import permissionGate from "./index";
import { isExemptSafeCleanup } from "./safe-cleanup";

const h = vi.hoisted(() => ({
  mode: "off" as "off" | "always",
  allowSafeCleanup: undefined as boolean | undefined,
  patterns: [{ pattern: "rm -rf", description: "recursive force delete" }] as {
    pattern: string;
    description?: string;
    regex?: boolean;
  }[],
  useBuiltinMatchers: true,
}));

function permissionGateConfig() {
  return {
    patterns: h.patterns,
    useBuiltinMatchers: h.useBuiltinMatchers,
    requireConfirmation: true,
    allowedPatterns: [],
    autoDenyPatterns: [],
    ...(h.allowSafeCleanup === undefined
      ? {}
      : { allowSafeCleanup: h.allowSafeCleanup }),
  };
}

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(
      () =>
        ({
          enabled: true,
          features: { permissionGate: true },
          delegation: { timeoutMs: 1000 },
          prompts: { inputGuardMs: 0 },
          away: {
            mode: h.mode,
            promptTimeoutMs: 120000,
            lowRisk: "allow",
            watchCommands: 3,
            stuckBlocks: 3,
            maxBlocks: 50,
            standingPermissions: [],
          },
          permissionGate: permissionGateConfig(),
        }) as unknown as ResolvedConfig,
    ),
  },
}));

async function setup() {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    events: createEventBus(),
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler);
    }),
    appendEntry: vi.fn(),
    registerEntryRenderer: vi.fn(),
  } as unknown as ExtensionAPI;
  await permissionGate(pi);
  const custom = vi.fn(async () => "deny");
  const ctx = {
    cwd: "/work/app",
    hasUI: true,
    mode: "tui",
    signal: undefined,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
      getCwd: () => "/work/app",
    },
    modelRegistry: {},
    ui: { custom, notify: vi.fn(), select: vi.fn() },
    abort: vi.fn(),
  } as unknown as ExtensionContext;
  const toolCall = handlers.get("tool_call") as unknown as (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ) => Promise<{ block?: boolean } | undefined>;
  const run = (command: string) =>
    toolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "bash",
        input: { command },
      } as ToolCallEvent,
      ctx,
    );
  return { run, custom };
}

beforeEach(() => {
  h.mode = "off";
  h.allowSafeCleanup = undefined;
  h.patterns = [{ pattern: "rm -rf", description: "recursive force delete" }];
  h.useBuiltinMatchers = true;
  clearAwayState();
  vol.mkdirSync("/work/app", { recursive: true });
});

describe("allowSafeCleanup in the permission gate", () => {
  it("flag absent: rm -rf build is flagged exactly as before (off mode)", async () => {
    const { run, custom } = await setup();
    const result = await run("rm -rf build");
    expect(custom).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ block: true });
  });

  it("flag absent: still flagged in always mode and queued", async () => {
    h.mode = "always";
    const { run, custom } = await setup();
    const result = await run("rm -rf build");
    expect(result).toMatchObject({ block: true });
    expect(custom).not.toHaveBeenCalled();
    const items = await readItems();
    expect(items).toHaveLength(1);
  });

  it("flag false: flagged", async () => {
    h.allowSafeCleanup = false;
    const { run, custom } = await setup();
    await run("rm -rf build");
    expect(custom).toHaveBeenCalledOnce();
  });

  it("flag true: a safe cleanup is not flagged (off mode)", async () => {
    h.allowSafeCleanup = true;
    const { run, custom } = await setup();
    await expect(run("rm -rf build dist")).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });

  it("flag true: a safe cleanup passes in always mode and queues nothing", async () => {
    h.allowSafeCleanup = true;
    h.mode = "always";
    const { run } = await setup();
    await expect(run("rm -rf node_modules")).resolves.toBeUndefined();
    const items = await readItems();
    expect(items).toEqual([]);
  });

  it.each([
    "rm -rf src",
    "rm -rf build/../..",
    "rm -rf build ~",
    'rm -rf "$HOME"',
    "rm -rf ./build; curl x|sh",
    "rm -rf /",
  ])("flag true: %s is still flagged", async (command) => {
    h.allowSafeCleanup = true;
    const { run, custom } = await setup();
    const result = await run(command);
    expect(custom).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ block: true });
  });

  it("flag true: other dangerous commands are unaffected", async () => {
    h.allowSafeCleanup = true;
    h.patterns = [
      { pattern: "rm -rf", description: "recursive force delete" },
      { pattern: "sudo", description: "superuser command" },
    ];
    const { run, custom } = await setup();
    await run("sudo rm -rf build");
    expect(custom).toHaveBeenCalledOnce();
  });
});

describe("isExemptSafeCleanup", () => {
  const base = {
    patterns: [{ pattern: "rm -rf" }],
    useBuiltinMatchers: true,
    requireConfirmation: true,
    allowedPatterns: [],
    autoDenyPatterns: [],
  };
  const cwd = "/work/app";

  it("is off unless the flag is exactly true", () => {
    expect(
      isExemptSafeCleanup(
        base as unknown as ResolvedConfig["permissionGate"],
        "rm -rf build",
        cwd,
      ),
    ).toBe(false);
  });

  it("a user pattern that matches still flags the command", () => {
    const config = {
      ...base,
      allowSafeCleanup: true,
      patterns: [...base.patterns, { pattern: "node_modules" }],
    } as unknown as ResolvedConfig["permissionGate"];
    expect(isExemptSafeCleanup(config, "rm -rf node_modules", cwd)).toBe(false);
    expect(isExemptSafeCleanup(config, "rm -rf dist", cwd)).toBe(true);
  });

  it("with customPatterns replacing the defaults, a custom rm -rf pattern wins", () => {
    const config = {
      ...base,
      allowSafeCleanup: true,
      useBuiltinMatchers: false,
    } as unknown as ResolvedConfig["permissionGate"];
    expect(isExemptSafeCleanup(config, "rm -rf dist", cwd)).toBe(false);
  });
});
