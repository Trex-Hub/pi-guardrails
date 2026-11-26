import { join } from "node:path";
import { vol } from "memfs";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import { DEFAULT_CONFIG } from "./defaults";
import { createGuardrailsConfigLoader } from "./loader";
import type { GuardrailsConfig } from "./types";

const DIR = "/tmp/pi-agent-away-config";

async function loadAway(
  global?: Record<string, unknown>,
  local?: Record<string, unknown>,
  memory?: GuardrailsConfig,
) {
  vi.stubEnv("PI_CODING_AGENT_DIR", DIR);
  const files: Record<string, string> = { [`${DIR}/.keep`]: "" };
  if (global) {
    files[`${DIR}/extensions/guardrails.json`] = JSON.stringify({
      version: pkg.version,
      ...global,
    });
  }
  if (local) {
    files[join(process.cwd(), ".pi/extensions/guardrails.json")] =
      JSON.stringify({ version: pkg.version, ...local });
  }
  vol.fromJSON(files);
  const loader = createGuardrailsConfigLoader();
  await loader.load();
  if (local) {
    await loader.loadProject({
      cwd: process.cwd(),
      isProjectTrusted: () => true,
    });
  }
  if (memory) await loader.save("memory", memory);
  return loader.getConfig().away;
}

describe("away config resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vol.reset();
  });

  it("defaults to off with the documented values", async () => {
    const away = await loadAway();
    expect(away).toEqual({
      mode: "off",
      promptTimeoutMs: 120000,
      lowRisk: "allow",
      watchCommands: 10,
      stuckBlocks: 3,
      maxBlocks: 50,
      standingPermissions: [],
    });
    expect(DEFAULT_CONFIG.away.mode).toBe("off");
  });

  describe("mode", () => {
    it.each(["off", "auto", "always"])("accepts %s", async (mode) => {
      const away = await loadAway({ away: { mode } });
      expect(away.mode).toBe(mode);
    });

    it.each([["on"], [1], [true], [null], [""]])(
      "turns invalid %j into off",
      async (mode) => {
        const away = await loadAway({ away: { mode } });
        expect(away.mode).toBe("off");
      },
    );

    it("lets local override global and memory override local", async () => {
      const local = await loadAway(
        { away: { mode: "always" } },
        { away: { mode: "auto" } },
      );
      expect(local.mode).toBe("auto");
      vol.reset();
      const memory = await loadAway(
        { away: { mode: "always" } },
        { away: { mode: "auto" } },
        { away: { mode: "off" } },
      );
      expect(memory.mode).toBe("off");
    });

    it("lets an invalid higher scope turn it off instead of leaking a lower one", async () => {
      const away = await loadAway(
        { away: { mode: "always" } },
        { away: { mode: "bogus" } },
      );
      expect(away.mode).toBe("off");
    });
  });

  describe("numeric bounds", () => {
    it.each([
      ["promptTimeoutMs", 500, 1000],
      ["promptTimeoutMs", 5_000_000, 3_600_000],
      ["promptTimeoutMs", 30000, 30000],
      ["promptTimeoutMs", "soon", 120000],
      ["promptTimeoutMs", null, 120000],
      ["watchCommands", 0, 0],
      ["watchCommands", -4, 0],
      ["watchCommands", 500, 100],
      ["watchCommands", 2.5, 10],
      ["watchCommands", "x", 10],
      ["stuckBlocks", 0, 1],
      ["stuckBlocks", 99, 50],
      ["stuckBlocks", 4, 4],
      ["stuckBlocks", 1.5, 3],
      ["maxBlocks", 0, 1],
      ["maxBlocks", 5000, 1000],
      ["maxBlocks", 20, 20],
      ["maxBlocks", "many", 50],
    ])("%s %j resolves to %j", async (key, value, expected) => {
      const away = await loadAway({ away: { [key]: value } });
      expect(away[key as keyof typeof away]).toBe(expected);
    });
  });

  describe("lowRisk", () => {
    it.each([
      ["allow", "allow"],
      ["defer", "defer"],
      ["never", "allow"],
      [1, "allow"],
    ])("%j resolves to %s", async (value, expected) => {
      const away = await loadAway({ away: { lowRisk: value } });
      expect(away.lowRisk).toBe(expected);
    });
  });

  describe("standingPermissions", () => {
    it("unions global, local and memory, trimmed, deduped, order kept", async () => {
      const away = await loadAway(
        { away: { standingPermissions: ["  delete build output ", "a", ""] } },
        { away: { standingPermissions: ["b", "a", "   "] } },
        { away: { standingPermissions: ["c", "delete build output"] } },
      );
      expect(away.standingPermissions).toEqual([
        "delete build output",
        "a",
        "b",
        "c",
      ]);
    });

    it("ignores non-string entries and non-array values", async () => {
      const mixed = await loadAway({
        away: { standingPermissions: ["ok", 3, null] },
      });
      expect(mixed.standingPermissions).toEqual(["ok"]);
      vol.reset();
      const notArray = await loadAway({
        away: { standingPermissions: "nope" },
      });
      expect(notArray.standingPermissions).toEqual([]);
    });
  });
});
