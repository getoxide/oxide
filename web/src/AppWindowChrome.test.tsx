// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./shared/queryCache";
import stylesCss from "./styles/styles.css?raw";

const windowState = vi.hoisted(() => ({
  maximized: false,
  resizeListeners: [] as (() => void)[],
  close: [] as string[],
  resizeDrags: [] as string[],
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
    close: vi.fn(async () => { windowState.close.push("close"); }),
    startResizeDragging: vi.fn(async (direction: string) => { windowState.resizeDrags.push(direction); }),
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
let projects: { id: number; name: string; path: string; hidden: boolean; open: boolean; missing: boolean }[] = [];
let calls: { command: string; args: unknown }[] = [];
let updateState: unknown = null;

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
  windowState.close = [];
  windowState.resizeDrags = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  projects = [];
  calls = [];
  updateState = null;
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "list_projects":
      case "rescan_projects":
        return projects;
      case "last_selection":
        return projects[0]?.id ?? null;
      case "update_state":
        return updateState;
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

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MACOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
const alpha = { id: 1, name: "Project Alpha", path: "/alpha", hidden: false, open: true, missing: false };

describe("App window chrome", () => {
  it.each([["Windows", WINDOWS], ["macOS", MACOS], ["Linux", LINUX]])(
    "keeps the %s header free of the active Project name and Reveal button, with a drag region spacer",
    async (_name, userAgent) => {
      projects = [alpha];
      await renderAppWithUserAgent(userAgent);
      expect(host.querySelector(".project-name")?.textContent).toBe("Project Alpha");

      const header = host.querySelector("header.header")!;
      expect(header.textContent).not.toContain("Project Alpha");
      expect(header.querySelector('[aria-label^="Reveal in"]')).toBeNull();
      expect(header.querySelector('.grow[data-tauri-drag-region]')).not.toBeNull();
    },
  );

  it("puts the Update button immediately left of the Tools panel toggle, only while an update exists", async () => {
    await renderAppWithUserAgent(MACOS);
    expect(host.querySelector('button[aria-label="Update available"]')).toBeNull();

    updateState = {
      channel: "inApp", currentVersion: "0.1.0", lastCheckedAt: 1,
      available: { version: "0.2.0", releaseNotesUrl: "https://github.com/getoxide/oxide/releases/tag/v0.2.0" },
      operation: { kind: "idle" }, error: null,
    };
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderAppWithUserAgent(MACOS);
    const update = host.querySelector('header.header button[aria-label="Update available"]')!;
    expect(update).not.toBeNull();
    expect(update.nextElementSibling?.getAttribute("aria-label")).toBe("Toggle tools panel");
  });

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

  it("draws Windows caption glyphs as crisp 1px strokes on the pixel grid", async () => {
    await renderAppWithUserAgent(WINDOWS);
    const glyph = (name: string) => host.querySelector(`.window-controls button[aria-label="${name}"] svg`)!;

    for (const name of ["Minimize", "Maximize", "Close window"]) {
      expect(glyph(name).getAttribute("viewBox")).toBe("0 0 10 10");
      expect(glyph(name).getAttribute("stroke-width")).toBe("1");
    }
    // Horizontal and vertical strokes snap to whole device pixels; the Close cross stays anti-aliased.
    expect(glyph("Minimize").getAttribute("shape-rendering")).toBe("crispEdges");
    expect(glyph("Maximize").getAttribute("shape-rendering")).toBe("crispEdges");
    // A 1px stroke centred on y=5 straddles two pixel rows and blurs; native Minimize sits on one row.
    expect(glyph("Minimize").querySelector("path")?.getAttribute("d")).toBe("M0 5.5h10");
  });

  it("styles Windows caption buttons like native Windows 11 chrome, on Windows only", () => {
    // Every block written for exactly this selector, joined.
    const rule = (selector: string) => {
      const blocks = stylesCss.split(`${selector} {`).slice(1).map((rest) => rest.slice(0, rest.indexOf("}")));
      expect(blocks.length, selector).toBeGreaterThan(0);
      return blocks.join("\n");
    };
    // The titlebar and caption sizes, and the Close crimson, are named once and shared.
    for (const property of ["--titlebar-height", "--caption-button-width", "--caption-close", "--caption-close-fg"])
      expect(stylesCss, property).toMatch(new RegExp(`${property}:`));
    expect(rule(".header")).toMatch(/var\(--titlebar-height\)/);
    const button = rule(".window.windows .window-controls button");
    expect(button).toMatch(/var\(--caption-button-width\)/);
    expect(button).toMatch(/border-radius: 0/);
    expect(rule(".window.windows .window-controls .window-close:hover:not(:disabled)")).toMatch(/var\(--caption-close\)/);
    // The resize edges stop at the caption buttons, so they follow the same sizes.
    expect(rule(".window-resize-north")).toMatch(/var\(--caption-button-width\)/);
    expect(rule(".window-resize-east")).toMatch(/var\(--titlebar-height\)/);
    // macOS and Linux headers never pick up the caption styles: every caption selector is Windows-scoped.
    const captionSelectors = [...stylesCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
      .flatMap((match) => match[1].split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector.includes(".window-controls"));
    expect(captionSelectors.length).toBeGreaterThan(0);
    for (const selector of captionSelectors) expect(selector).toMatch(/^\.window\.windows /);
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

  it("leaves the top-right corner to the Close button while the other edges and corners still resize", async () => {
    await renderAppWithUserAgent(WINDOWS);

    const handles = Array.from(host.querySelectorAll<HTMLElement>(".window-resize-handles .window-resize"));
    const directions = handles.map((handle) => handle.dataset.direction);
    expect(directions).not.toContain("NorthEast");
    expect(directions.sort()).toEqual(["East", "North", "NorthWest", "South", "SouthEast", "SouthWest", "West"]);

    for (const handle of handles) {
      await act(async () => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
    }
    expect(windowState.resizeDrags.sort()).toEqual(["East", "North", "NorthWest", "South", "SouthEast", "SouthWest", "West"]);

    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Close window"]')!.click(); });
    expect(windowState.close).toEqual(["close"]);
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

  it("aligns macOS titlebar controls vertically with Liquid Glass capsule styling without affecting Windows or Linux", () => {
    const css = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.window\.macos\s*\{[^}]*--titlebar-height:\s*30px/);
    const macButtonMatch = css.match(/\.window\.macos \.header \.icon-btn,\s*\.window\.macos \.header \.update-btn\s*\{([^}]*)\}/);
    expect(macButtonMatch).not.toBeNull();
    expect(macButtonMatch![1]).toContain("border-radius: 999px");
    expect(macButtonMatch![1]).toContain("backdrop-filter:");
  });
});
