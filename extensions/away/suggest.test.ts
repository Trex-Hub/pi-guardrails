import { describe, expect, it, vi } from "vitest";
import { configLoader } from "../../src/shared/config";
import {
  addStandingPermission,
  countApprovals,
  resetSuggestions,
} from "./suggest";

const h = vi.hoisted(() => ({ raw: null as Record<string, unknown> | null }));

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    getRawConfig: vi.fn(() => h.raw),
    save: vi.fn(async () => undefined),
    getConfig: vi.fn(() => ({ away: { standingPermissions: [] } })),
  },
}));

describe("addStandingPermission", () => {
  it("creates away.standingPermissions in an empty global config", async () => {
    h.raw = null;
    await addStandingPermission("delete build output");
    expect(configLoader.save).toHaveBeenCalledWith("global", {
      away: { standingPermissions: ["delete build output"] },
    });
  });

  it("keeps other settings and never adds a duplicate", async () => {
    h.raw = { away: { mode: "auto", standingPermissions: ["a"] }, x: 1 };
    await addStandingPermission("a");
    expect(configLoader.save).not.toHaveBeenCalled();
    await addStandingPermission("b");
    expect(configLoader.save).toHaveBeenCalledWith("global", {
      away: { mode: "auto", standingPermissions: ["a", "b"] },
      x: 1,
    });
  });
});

describe("countApprovals", () => {
  it("is 0 when nothing matches", async () => {
    resetSuggestions();
    await expect(countApprovals("nothing")).resolves.toBe(0);
  });
});
