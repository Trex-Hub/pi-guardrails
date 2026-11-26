import { bindProjectConfig } from "@aliou/pi-utils-settings";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { prune, removeSessionStatus } from "../../src/shared/away/inbox";
import { PAUSED_HOLD } from "../../src/shared/away/messages";
import {
  type AwayState,
  effectivePresence,
  getAwayState,
  setPresence,
} from "../../src/shared/away/state";
import { configLoader } from "../../src/shared/config";
import type { ResolvedConfig } from "../../src/shared/config/types";
import {
  emitActionBlocked,
  GUARDRAILS_AWAY_PAUSED_EVENT,
  GUARDRAILS_PRESENCE_CHANGED_EVENT,
} from "../../src/shared/events";
import { applyDecisions, liftPause, restoreSession } from "./decisions";
import { pausedHoldAction } from "./hold";
import { openCount, statusLine, writeStatus } from "./status";
import { startWatching, type Watching } from "./watch";

const STATUS_KEY = "guardrails:away";
const POLL_MS = 5000;
const PROGRESS_TOOLS = new Set(["bash", "powershell", "edit", "write"]);

type Delivery = "live" | "nextTurn";
type AwayConfig = ResolvedConfig;

/** What one running session holds on to. `stop` releases all of it. */
interface Active {
  sessionId: string;
  ctx: ExtensionContext;
  applied: Set<string>;
  watching?: Watching;
  stops: Array<() => void>;
  runState: "running" | "idle";
  /** Open waiting and urgent items on this machine. */
  open: number;
  /** Tail of the serialized tick chain, and the tick waiting behind it. */
  tail: Promise<void>;
  queued?: Promise<void>;
  closed: boolean;
}

/** The config when away mode is on, else undefined. Read on every call so a reload takes effect. */
function awayConfig(): AwayConfig | undefined {
  const config = configLoader.getConfig();
  if (!config.enabled || !config.away || config.away.mode === "off") return;
  return config;
}

export default async function away(pi: ExtensionAPI): Promise<void> {
  await configLoader.load();
  bindProjectConfig(pi, configLoader);

  let active: Active | undefined;
  let starting: Promise<void> | undefined;

  const stateOf = (ctx: ExtensionContext, config: AwayConfig): AwayState =>
    getAwayState(ctx.sessionManager.getSessionId(), config.away);

  async function refresh(a: Active): Promise<void> {
    const config = awayConfig();
    if (!config || a.closed) return;
    const state = getAwayState(a.sessionId, config.away);
    await writeStatus(a.ctx, state, config.away, a.runState);
    a.open = await openCount();
    if (!a.ctx.hasUI || a.closed) return;
    a.ctx.ui.setStatus(
      STATUS_KEY,
      statusLine(
        effectivePresence(config.away, a.ctx),
        Boolean(state.paused),
        a.open,
      ),
    );
  }

  /** Applies decisions, then refreshes the status file and line. */
  async function tick(a: Active, delivery: Delivery): Promise<void> {
    const config = awayConfig();
    if (!config || a.closed) return;
    const state = getAwayState(a.sessionId, config.away);
    await applyDecisions(pi, a.ctx, state, a.applied, delivery);
    await refresh(a);
  }

  /**
   * Runs ticks one at a time. A tick asked for while another waits behind the
   * running one is dropped: the waiting one reads the same files anyway.
   */
  function schedule(a: Active, delivery: Delivery): Promise<void> {
    if (a.queued) return a.queued;
    const next = a.tail.then(() => {
      a.queued = undefined;
      return tick(a, delivery);
    });
    a.queued = next.catch(() => undefined);
    a.tail = a.queued;
    return a.queued;
  }

  async function stop(): Promise<void> {
    const a = active;
    active = undefined;
    if (!a) return;
    a.closed = true;
    a.watching?.close();
    for (const unsubscribe of a.stops) unsubscribe();
    if (a.ctx.hasUI) a.ctx.ui.setStatus(STATUS_KEY, undefined);
    // Let a running tick finish first, so it cannot rewrite the status file.
    await a.tail;
    await removeSessionStatus(a.sessionId);
  }

  async function start(
    ctx: ExtensionContext,
    config: AwayConfig,
    delivery: Delivery,
  ): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = stateOf(ctx, config);
    const a: Active = {
      sessionId,
      ctx,
      applied: await restoreSession(ctx, state),
      stops: [],
      runState: ctx.isIdle() ? "idle" : "running",
      open: 0,
      tail: Promise.resolve(),
      closed: false,
    };
    active = a;
    const onChange = () => {
      refresh(a).catch(() => undefined);
    };
    a.stops.push(
      pi.events.on(GUARDRAILS_AWAY_PAUSED_EVENT, onChange),
      pi.events.on(GUARDRAILS_PRESENCE_CHANGED_EVENT, onChange),
    );
    if (ctx.mode === "tui" && ctx.hasUI) {
      a.stops.push(
        ctx.ui.onTerminalInput(() => {
          const now = awayConfig();
          if (now?.away.mode === "auto") {
            setPresence(pi, stateOf(a.ctx, now), "present", "keypress");
          }
          return undefined;
        }),
      );
    }
    await schedule(a, delivery);
    await prune(Date.now());
    if (a.closed) return;
    a.watching = await startWatching(POLL_MS, () => {
      schedule(a, "live");
    });
    if (a.closed) a.watching.close();
  }

  /** Starts the extension for this session when away mode is on, stops it when it is off. */
  async function ensure(
    ctx: ExtensionContext,
  ): Promise<AwayConfig | undefined> {
    const config = awayConfig();
    if (!config) {
      if (active) await stop();
      return;
    }
    if (starting) await starting;
    if (active?.sessionId !== ctx.sessionManager.getSessionId()) {
      starting = (async () => {
        await stop();
        await start(ctx, config, "nextTurn");
      })();
      try {
        await starting;
      } finally {
        starting = undefined;
      }
    }
    if (active) active.ctx = ctx;
    return config;
  }

  pi.on("session_start", async (_event, ctx) => {
    await stop();
    const config = awayConfig();
    if (config) await ensure(ctx);
  });

  pi.on("session_shutdown", async () => {
    await stop();
  });

  pi.on("input", async (event, ctx) => {
    const config = await ensure(ctx);
    if (!config || event.source !== "interactive") return;
    const state = stateOf(ctx, config);
    if (config.away.mode === "auto") {
      setPresence(pi, state, "present", "input");
    }
    // A typed message also lifts a pause when presence did not change.
    liftPause(pi, state);
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = await ensure(ctx);
    if (!config || !PROGRESS_TOOLS.has(event.toolName)) return;
    stateOf(ctx, config).ladder.recordProgress();
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = await ensure(ctx);
    if (!config || !stateOf(ctx, config).paused) return;
    emitActionBlocked(pi, {
      feature: "permissionGate",
      action: pausedHoldAction(event.toolName, event.input, ctx.cwd),
      reason: PAUSED_HOLD,
      block: { source: "paused" },
      context: { toolName: event.toolName, input: event.input },
    });
    return { block: true, reason: PAUSED_HOLD, terminate: true };
  });

  pi.on("agent_start", async (_event, ctx) => {
    const config = await ensure(ctx);
    if (!config || !active) return;
    active.runState = "running";
    await refresh(active);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const config = await ensure(ctx);
    if (!config || !active) return;
    active.runState = "idle";
    await refresh(active);
  });

  pi.registerCommand("guardrails:away", {
    description: "Count as away: Guardrails applies its away rules",
    handler: async (_args, ctx) => {
      const config = configLoader.getConfig();
      const mode = config.away?.mode ?? "off";
      if (!config.enabled || mode === "off") {
        ctx.ui.notify(
          'Away mode is off. Set away.mode to "auto" in guardrails.json.',
          "info",
        );
        return;
      }
      if (mode === "always") {
        ctx.ui.notify("Away mode is always on.", "info");
        return;
      }
      const awayOn = await ensure(ctx);
      if (!awayOn) return;
      setPresence(pi, stateOf(ctx, awayOn), "away", "command");
      ctx.ui.notify(
        "Away mode on. Guardrails applies its away rules until you type or press a key.",
        "info",
      );
    },
  });
}
