// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface TerminalInstance {
  rows: number;
  cols: number;
  options: Record<string, unknown>;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine: (y: number) => { translateToString: (trimRight?: boolean) => string } | undefined;
    };
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
  write(data: string): void;
  written: string[];
  paste(): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onWriteParsed(): { dispose(): void };
}

const instances: TerminalInstance[] = [];
const fitCalls: number[] = [];
const bufferListeners: Array<(buffer: { type: "normal" | "alternate" }) => void> = [];
const dataListeners: Array<(data: string) => void> = [];
const focused: number[] = [];
let nextRows = 24;
let nextCols = 80;

vi.mock("@xterm/xterm", () => ({
  Terminal: class implements TerminalInstance {
    rows = 24;
    cols = 80;
    options: Record<string, unknown>;
    lines = [""];
    buffer = {
      active: {
        baseY: 0,
        cursorY: 0,
        length: 1,
        getLine: (y: number) =>
          y < this.lines.length ? { translateToString: () => this.lines[y] } : undefined,
      },
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
    written: string[] = [];
    loadAddon() {}
    open() {}
    write(data: string) {
      this.written.push(data);
      // A line-oriented model of the buffer: enough to know which rows hold text and where the cursor is.
      for (const [index, part] of data.replace(/\x1b\[[?\d;]*[A-Za-z]/g, "").split(/\r?\n/).entries()) {
        if (index > 0) this.lines.push("");
        this.lines[this.lines.length - 1] += part.replace(/\r/g, "");
      }
      this.buffer.active.cursorY = this.lines.length - 1;
      this.buffer.active.length = this.lines.length;
    }
    paste() {}
    focus() { focused.push(1); }
    blur() {}
    dispose() {}
    onData(cb: (data: string) => void) {
      dataListeners.push(cb);
      return { dispose() {} };
    }
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

import stylesCss from "../styles/styles.css?raw";
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
  dataListeners.length = 0;
  focused.length = 0;
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

it("neither takes focus nor sends keys to the shell until the block has started", async () => {
  const onInput = vi.fn();
  const render = (started: boolean) =>
    act(async () =>
      root.render(
        createElement(TerminalCommandBlock, {
          block: baseBlock({ started }),
          active: true,
          visible: true,
          onInput,
          onReady: () => {},
          onResize: () => {},
          onScreen: () => {},
        }),
      ),
    );
  await render(false);
  await act(async () => {
    for (const listener of dataListeners) listener("typed ahead");
  });
  expect(onInput).not.toHaveBeenCalled();
  expect(focused).toHaveLength(0);

  await render(true);
  await act(async () => {
    for (const listener of dataListeners) listener("y");
  });
  expect(onInput).toHaveBeenCalledExactlyOnceWith("y");
  expect(focused.length).toBeGreaterThan(0);
});

it("prefixes the Command block header with a $ prompt cue, keeping the command text itself clean", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ command: "cd ..", ended: true, exitCode: 0 }),
        active: false,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: () => {},
      }),
    ),
  );
  const header = mount.querySelector("section.terminal-command-block > header")!;
  const prompt = header.querySelector(".terminal-block-prompt")!;
  expect(prompt.textContent).toBe("$");
  expect(prompt.getAttribute("aria-hidden")).toBe("true");
  expect(header.textContent).toMatch(/^\$\s*cd \.\./);
  expect(header.querySelector("code")?.textContent).toBe("cd ..");
});

it.each([
  ["failed", { ended: true, exitCode: 2 }, false],
  ["running", { ended: false, exitCode: null }, true],
] as const)("keeps xterm opaque on the Terminal background in a %s block", async (state, overrides, active) => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output: "boom\r\n", outputOffset: 0, ...overrides }),
        active,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: () => {},
      }),
    ),
  );
  const section = mount.querySelector("section.terminal-command-block")!;
  expect(section.classList.contains(state)).toBe(true);
  const term = instances[0];
  expect((term.options.theme as { background: string }).background).toBe(terminalAppearance().theme.background);
  expect(term.options.allowTransparency).not.toBe(true);
  if (state === "failed") {
    const status = section.querySelector(".terminal-block-status")!;
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent).toContain("exit 2");
  }
});

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

it.each(["Oxide Dark", "Oxide Light"])("keeps failed-block red text at WCAG AA contrast on %s", (themeName) => {
  const initial = getAppearance();
  saveAppearance({ ...initial, themeName });
  try {
    const { theme } = terminalAppearance() as { theme: Record<string, string> };
    // A theme without an error colour falls back to the --red of styles.css.
    const errorRed =
      document.documentElement.style.getPropertyValue("--red") || /--red:\s*(#[\da-f]{6})/i.exec(stylesCss)![1];
    for (const red of [errorRed, theme.red, theme.brightRed]) {
      expect(red, themeName).toMatch(/^#[\da-f]{6}$/i);
      expect(contrast(red, theme.background), `${red} on ${theme.background}`).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    saveAppearance(initial);
  }
});

it("never shows a cursor in a block that has ended, so clicking its output leaves no cursor behind", async () => {
  const render = (ended: boolean) =>
    act(async () =>
      root.render(
        createElement(TerminalCommandBlock, {
          block: baseBlock({ output: "lorenzo\r\n", ended, exitCode: ended ? 0 : null }),
          active: !ended,
          visible: true,
          onInput: () => {},
          onReady: () => {},
          onResize: () => {},
          onScreen: () => {},
        }),
      ),
    );
  await render(false);
  const term = instances[0];
  expect(term.written.join("")).not.toContain("\x1b[?25l");
  expect(term.options.disableStdin).not.toBe(true);

  await render(true);
  // DECTCEM hides the cursor in every renderer, WebGL included; stdin off keeps a click from typing.
  expect(term.written.join("")).toContain("\x1b[?25l");
  expect(term.options.disableStdin).toBe(true);
});

it("never shows a cursor in a block restored from the last session", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output: "old\r\n", ended: true, exitCode: 0, restored: true }),
        active: false,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: () => {},
      }),
    ),
  );
  const term = instances[0];
  expect(term.written.join("")).toMatch(/old\r\n.*\x1b\[\?25l/s);
  expect(term.options.disableStdin).toBe(true);
});

it.each([
  ["one line of output and the row its cursor moved to", "lorenzo\r\n", "16px"],
  ["two lines of output", "a\r\nb\r\n", "32px"],
  ["output made only of line breaks", "\r\n\r\n", "0px"],
])("sizes an ended block to its text, without the trailing cursor row: %s", async (_, output, height) => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output, ended: true, exitCode: 0 }),
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
  expect(mount.querySelector<HTMLElement>(".terminal-output-clip")!.style.height).toBe(height);
});

it("keeps the cursor row of a running block, where the program is still typing", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output: "Password:\r\n" }),
        active: true,
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
  expect(mount.querySelector<HTMLElement>(".terminal-output-clip")!.style.height).toBe("32px");
});
