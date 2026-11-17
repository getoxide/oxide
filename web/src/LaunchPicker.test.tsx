// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { resetCatalogCache } from "./modelCatalogCache";
import type { LaunchChoice } from "./launchPicker";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
let root: Root;

const models = [
  { id: "opus", name: "Opus", supportedEfforts: ["low", "high"], defaultEffort: "high", isLegacy: false },
  { id: "sonnet", name: "Sonnet", supportedEfforts: ["low", "high"], defaultEffort: "high", isLegacy: false },
];

beforeEach(() => {
  resetCatalogCache();
  root = createRoot(container);
  // Everything is installed, so only the missing launch recipe can hide Antigravity.
  mockIPC((name) => {
    if (name === "detect_provider") return { installed: true };
    if (name === "get_model_catalog") return models;
    if (name === "get_favourite_models") return [];
    return null;
  });
});

afterEach(() => {
  act(() => root.unmount());
  clearMocks();
});

async function render(onLaunch: (choice: LaunchChoice) => void) {
  await act(async () => {
    root.render(
      <ModelEffortPicker
        open
        launch={{ defaultPermissionMode: "ask", onLaunch }}
        onClose={() => {}}
        currentProvider="claude"
        currentModel="sonnet"
        currentEffort="low"
        turnCount={0}
        midThreadModelSwitch
        onSelectModelAndEffort={() => {}}
      />,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const press = (key: string) =>
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

it("lists only the Providers that can launch, with the Settings defaults preselected", async () => {
  await render(() => {});
  const tabs = [...container.querySelectorAll(".provider-tab")].map((tab) => tab.textContent);
  expect(tabs).toEqual(["Favourites", "Claude", "Codex"]);
  expect(container.querySelector(".model-row.highlighted .model-name")?.textContent).toBe("Sonnet");
  expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Ask");
});

it("starts a Thread with the highlighted Model, its Effort and the Permission mode on Enter", async () => {
  const launched = vi.fn();
  await render(launched);
  await press("p");
  await press("Enter");
  expect(launched).toHaveBeenCalledWith({ provider: "claude", model: "sonnet", effort: "low", permissionMode: "auto-edit" });
});

it("starts with another Model after moving the highlight", async () => {
  const launched = vi.fn();
  await render(launched);
  await press("ArrowDown");
  await press("Enter");
  expect(launched.mock.calls[0]![0].model).toBe("opus");
  expect(launched.mock.calls[0]![0].permissionMode).toBe("ask");
});

it("offers Codex without Ask and says what its Auto-edit allows", async () => {
  const launched = vi.fn();
  await render(launched);
  await press("Tab");
  const modes = [...container.querySelectorAll(".permission-mode")].map((mode) => mode.textContent);
  expect(modes).toEqual(["Auto-edit", "Full access"]);
  expect(container.querySelector(".permission-note")?.textContent).toMatch(/without asking/);
  await press("Enter");
  expect(launched.mock.calls[0]![0].provider).toBe("codex");
  expect(launched.mock.calls[0]![0].permissionMode).toBe("auto-edit");
});
