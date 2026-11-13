// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { catalogCache, resetCatalogCache, warmModelCatalogs } from "./modelCatalogCache";

afterEach(() => {
  clearMocks();
  resetCatalogCache();
});

it("warmModelCatalogs reads cached catalogs without forcing refresh probes", async () => {
  const catalogCalls: Array<{ provider: string; refresh: boolean }> = [];
  const model = {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash (High)",
    description: null,
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
    isLegacy: false,
  };

  mockIPC((command, args) => {
    if (command === "detect_provider") {
      return {
        installed: (args as { provider: string }).provider === "antigravity",
        available: true,
        authenticated: true,
        version: "1.4.5",
        warning: null,
      };
    }
    if (command === "get_model_catalog") {
      const typed = args as { provider: string; refresh: boolean };
      catalogCalls.push({ provider: typed.provider, refresh: typed.refresh });
      return typed.provider === "antigravity" ? [model] : [];
    }
    throw new Error(`Unexpected command ${command}`);
  });

  await warmModelCatalogs();

  expect(catalogCalls).toEqual([{ provider: "antigravity", refresh: false }]);
  expect(catalogCache.get("antigravity")).toEqual([model]);
});
