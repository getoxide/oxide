// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface TerminalInstance {
  rows: number;
  cols: number;
  options: Record<string, unknown>;
  buffer: {
    active: { baseY: number; cursorY: number; length: number; getLine: () => undefined };
    onBufferChange: (cb: (buffer: { type: "normal" | "alternate" }) => void) => { dispose(): void };
  };
  parser: {
    registerCsiHandler: (
      id: { final: string },
      cb: (params: number[]) => boolean,
    ) => { dispose(): void };
  };
  loadAddon(): void;
  open(): void;
  write(): void;
  paste(): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  onData(): { dispose(): void };
  onWriteParsed(): { dispose(): void };
}

const instances: TerminalInstance[] = [];
const fitCalls: number[] = [];
const bufferListeners: Array<(buffer: { type: "normal" | "alternate" }) => void> = [];
let nextRows = 24;
let nextCols = 80;

vi.mock("@xterm/xterm", () => ({
  Terminal: class implements TerminalInstance {
    rows = 24;
    cols = 80;
    options: Record<string, unknown>;
    buffer = {
      active: { baseY: 0, cursorY: 0, length: 0, getLine: () => undefined },
      onBufferChange: (cb: (buffer: { type: "normal" | "alternate" }) => void) => {
        bufferListeners.push(cb);
        return { dispose() {} };
      },
    };
    parser = {
      registerCsiHandler: () => ({ dispose() {} }),
    };
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      instances.push(this);
    }
    loadAddon() {}
    open() {}
    write() {}
    paste() {}
    focus() {}
    blur() {}
    dispose() {}
    onData() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fitCalls.push(1);
      const current = instances.at(-1);
      if (current) {
        current.rows = nextRows;
        current.cols = nextCols;
      }
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));

const { formatDuration, TerminalCommandBlock } = await import("./TerminalCommandBlock");
const { getAppearance, saveAppearance, terminalAppearance } = await import("../shared/appearance");

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

const workspace = document.createElement("div");
workspace.className = "terminal-workbench";
const toolbar = document.createElement("header");
toolbar.className = "workbench-terminal-header";
const mount = document.createElement("div");
workspace.append(toolbar, mount);
document.body.append(workspace);

for (const size of ["clientWidth", "clientHeight"]) {
  Object.defineProperty(HTMLElement.prototype, size, {
    configurable: true,
    get: () => 600,
  });
}

const root = createRoot(mount);

beforeEach(() => {
  instances.length = 0;
  fitCalls.length = 0;
  bufferListeners.length = 0;
  nextRows = 24;
  nextCols = 80;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(async () => {
  await act(async () => root.render(null));
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const baseBlock = (overrides: Partial<Parameters<typeof TerminalCommandBlock>[0]["block"]> = {}) => ({
  token: "tok-1",
  command: "echo hi",
  output: "",
  outputOffset: 0,
  at: 1000,
  exitCode: null,
  started: true,
  ended: false,
  truncated: false,
  ...overrides,
});

it.each([
  [0, "0 ms"],
  [17, "17 ms"],
  [999, "999 ms"],
  [999.6, "1.00 s"],
  [1_000, "1.00 s"],
  [1_240, "1.24 s"],
  [59_990, "59.99 s"],
  [59_999, "1m 0.0s"],
  [60_000, "1m 0.0s"],
  [123_400, "2m 3.4s"],
  [119_960, "2m 0.0s"],
])("formats %d ms as %s", (milliseconds, text) => {
  expect(formatDuration(milliseconds)).toBe(text);
});

it("initializes xterm with opaque theme background (no allowTransparency) and 1.0 lineHeight", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock(),
        active: true,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: () => {},
      }),
    ),
  );
  const term = instances[0];
  const expected = terminalAppearance();
  const theme = term.options.theme as { background: string };
  expect(theme.background).toBe(expected.theme.background);
  expect(theme.background).not.toBe("#00000000");
  expect(term.options.allowTransparency).not.toBe(true);
  expect(term.options.lineHeight).toBe(1);
});

it("updates xterm theme background immediately when appearance changes", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock(),
        active: true,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: () => {},
      }),
    ),
  );
  const term = instances[0];
  const initialAppearance = getAppearance();
  const fitsBefore = fitCalls.length;
  await act(async () => {
    saveAppearance({
      ...initialAppearance,
      themeName: "Oxide Light",
    });
    await new Promise((r) => setTimeout(r, 20));
  });
  const updated = terminalAppearance();
  const theme = term.options.theme as { background: string };
  expect(theme.background).toBe(updated.theme.background);
  expect(theme.background).not.toBe("#00000000");
  expect(fitCalls.length).toBeGreaterThan(fitsBefore);
  saveAppearance(initialAppearance);
});

it("enters and exits fullscreen on alternate buffer changes and syncs fit/resize", async () => {
  const onReady = vi.fn();
  const onResize = vi.fn();
  const onScreen = vi.fn();
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock(),
        active: true,
        visible: true,
        onInput: () => {},
        onReady,
        onResize,
        onScreen,
      }),
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(onReady).toHaveBeenCalledWith(24, 80);

  const section = mount.querySelector("section.terminal-command-block")!;
  const clip = mount.querySelector<HTMLElement>(".terminal-output-clip")!;

  nextRows = 35;
  nextCols = 100;
  await act(async () => {
    for (const cb of bufferListeners) cb({ type: "alternate" });
    await new Promise((r) => setTimeout(r, 150));
  });
  expect(onScreen).toHaveBeenLastCalledWith(true);
  expect(section.classList.contains("fullscreen")).toBe(true);
  expect(clip.style.height).toBe("600px");
  expect(onResize).toHaveBeenLastCalledWith(35, 100);

  nextRows = 24;
  nextCols = 80;
  await act(async () => {
    for (const cb of bufferListeners) cb({ type: "normal" });
    await new Promise((r) => setTimeout(r, 150));
  });
  expect(onScreen).toHaveBeenLastCalledWith(false);
  expect(section.classList.contains("fullscreen")).toBe(false);
  expect(clip.style.height).toBe("16px");
  expect(onResize).toHaveBeenLastCalledWith(24, 80);
});

it("collapses output clip to 0px when a finished command produced no output", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ ended: true, exitCode: 0, output: "", outputOffset: 0 }),
        active: false,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: () => {},
      }),
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const clip = mount.querySelector<HTMLElement>(".terminal-output-clip")!;
  expect(clip.style.height).toBe("0px");
});
