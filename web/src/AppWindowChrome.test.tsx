// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./shared/queryCache";

const windowState = vi.hoisted(() => ({
  maximized: false,
  resizeListeners: [] as (() => void)[],
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn(async () => windowState.maximized),
    onResized: vi.fn(async (cb: () => void) => {
      windowState.resizeListeners.push(cb);
      return () => {
        windowState.resizeListeners = windowState.resizeListeners.filter((fn) => fn !== cb);
      };
    }),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    startResizeDragging: vi.fn(async () => {}),
  }),
}));

vi.mock("./shared/QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./terminal/TerminalWorkbench", () => ({ TerminalWorkbench: () => null }));
vi.mock("./pull-requests/PullRequestPanel", () => ({ PullRequestPanel: () => null }));
vi.mock("./issues/IssuesSurface", () => ({ IssuesSurface: () => null }));
vi.mock("./editor/FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./editor/CodeWorkbench", () => ({ CodeWorkbench: () => null }));

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

let host: HTMLDivElement;
let root: Root;

async function renderAppWithUserAgent(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent, platform: userAgent });
  const { App } = await import("./App");
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

beforeEach(() => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  clearQueryCache();
  localStorage.clear();
  windowState.maximized = false;
  windowState.resizeListeners = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command) => {
    switch (command) {
      case "list_projects":
      case "rescan_projects":
        return [];
      case "last_selection":
        return null;
      case "plugin:event|listen":
        return 1;
      default:
        return null;
    }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App window chrome", () => {
  it("renders visible SVG icons inside Windows caption buttons", async () => {
    await renderAppWithUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    const controls = host.querySelector(".window-controls");
    expect(controls).not.toBeNull();
    const min = controls!.querySelector('button[aria-label="Minimize"]');
    const max = controls!.querySelector('button[aria-label="Maximize"]');
    const close = controls!.querySelector('button[aria-label="Close window"]');

    expect(min?.querySelector("svg")).not.toBeNull();
    expect(max?.querySelector("svg")).not.toBeNull();
    expect(close?.querySelector("svg")).not.toBeNull();
  });

  it("removes resize handles and switches Maximize to Restore when maximized on resize or launch", async () => {
    await renderAppWithUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    expect(host.querySelector(".window-resize-handles")).not.toBeNull();
    expect(host.querySelector('button[aria-label="Maximize"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Restore"]')).toBeNull();

    windowState.maximized = true;
    await act(async () => {
      for (const listener of windowState.resizeListeners) listener();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(host.querySelector(".window-resize-handles")).toBeNull();
    expect(host.querySelector('button[aria-label="Restore"]')?.querySelector("svg")).not.toBeNull();
    expect(host.querySelector('button[aria-label="Maximize"]')).toBeNull();
  });

  it("starts without resize handles and with Restore when launched maximized", async () => {
    windowState.maximized = true;
    await renderAppWithUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    expect(host.querySelector(".window-resize-handles")).toBeNull();
    expect(host.querySelector('button[aria-label="Restore"]')).not.toBeNull();
  });

  it("uses linux window class on Linux without Windows-only header controls", async () => {
    await renderAppWithUserAgent("Mozilla/5.0 (X11; Linux x86_64)");

    const winEl = host.querySelector(".window");
    expect(winEl?.classList.contains("linux")).toBe(true);
    expect(winEl?.classList.contains("windows")).toBe(false);
    expect(winEl?.classList.contains("macos")).toBe(false);
    expect(host.querySelector(".window-controls")).toBeNull();
    expect(host.querySelector(".window-resize-handles")).toBeNull();
  });

  it("toggles aria-expanded on top-left application menu buttons", async () => {
    await renderAppWithUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    const editBtn = Array.from(host.querySelectorAll(".app-menu button")).find(
      (btn) => btn.textContent === "Edit",
    ) as HTMLButtonElement | undefined;
    expect(editBtn).toBeDefined();
    expect(editBtn!.getAttribute("aria-expanded")).toBe("false");

    await act(async () => { editBtn!.click(); });
    expect(editBtn!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('.app-menu-popup[role="menu"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(editBtn!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('.app-menu-popup[role="menu"]')).toBeNull();
  });
});
