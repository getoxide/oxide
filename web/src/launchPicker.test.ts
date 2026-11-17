import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./bindings";
import {
  launchChoice,
  launchableProviders,
  nextPermissionMode,
  permissionModeNote,
  permissionModesFor,
  resolveLaunchFavourite,
} from "./launchPicker";

const model = (id: string, supportedEfforts: string[] = ["low", "high"]): ModelInfo => ({
  id,
  name: id,
  supportedEfforts,
  defaultEffort: "high",
  isLegacy: false,
});

describe("launch recipes", () => {
  it("offers only Providers that have a terminal launch recipe and are installed", () => {
    const installed = new Map([["claude", true], ["codex", true], ["antigravity", true]]);
    expect(launchableProviders(installed)).toEqual(["claude", "codex"]);
    expect(launchableProviders(new Map([["claude", false], ["codex", true]]))).toEqual(["codex"]);
    expect(launchableProviders(new Map([["claude", false], ["antigravity", true]]))).toEqual([]);
    expect(launchableProviders(new Map())).toEqual([]);
  });

  it("offers every Permission mode Claude Code can honour", () => {
    expect(permissionModesFor("claude")).toEqual(["ask", "auto-edit", "full-access"]);
  });

  it("does not offer Ask for Codex, whose sandboxed commands never ask", () => {
    expect(permissionModesFor("codex")).toEqual(["auto-edit", "full-access"]);
  });

  it("says that Codex Auto-edit lets commands inside the workspace run without asking", () => {
    expect(permissionModeNote("codex", "auto-edit")).toMatch(/without asking/);
    expect(permissionModeNote("codex", "full-access")).toBeNull();
    expect(permissionModeNote("claude", "auto-edit")).toBeNull();
  });

  it("offers Ask for no other Provider that cannot honour it", () => {
    expect(permissionModesFor("antigravity")).not.toContain("ask");
  });
});

describe("Permission mode", () => {
  it("steps through the supported modes and wraps", () => {
    expect(nextPermissionMode("claude", "ask", 1)).toBe("auto-edit");
    expect(nextPermissionMode("claude", "full-access", 1)).toBe("ask");
    expect(nextPermissionMode("claude", "ask", -1)).toBe("full-access");
  });

  it("falls back to the first supported mode when the current one is not offered", () => {
    expect(nextPermissionMode("codex", "ask", 1)).toBe(permissionModesFor("codex")[0]);
  });
});

describe("launchChoice", () => {
  it("keeps the wanted mode when the Provider supports it, else the first it supports", () => {
    expect(launchChoice("claude", "m", "low", "full-access").permissionMode).toBe("full-access");
    expect(launchChoice("codex", "m", "low", "ask").permissionMode).toBe(permissionModesFor("codex")[0]);
    expect(launchChoice("claude", "m", null, null).permissionMode).toBe("auto-edit");
  });
});

describe("Favourite shortcut", () => {
  const catalogs = { claude: [model("opus"), model("sonnet")], codex: [model("gpt-5")] };

  it("starts the nth Favourite of an offered Provider with the default Permission mode", () => {
    const choice = resolveLaunchFavourite(2, catalogs, ["opus", "sonnet"], ["claude"], "ask");
    expect(choice).toEqual({ provider: "claude", model: "sonnet", effort: "high", permissionMode: "ask" });
  });

  it("ignores Favourites of Providers that cannot launch", () => {
    expect(resolveLaunchFavourite(1, catalogs, ["gpt-5"], ["claude"], "ask")).toBeNull();
  });

  it("is null when there is no such Favourite", () => {
    expect(resolveLaunchFavourite(3, catalogs, ["opus", "sonnet"], ["claude"], "ask")).toBeNull();
  });
});
