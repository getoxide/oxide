// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  host: HTMLElement | null;
  loadAddon(): void;
  open(element: HTMLElement): void;
  write(data: string): void;
  written: string[];
  shownLines(): string[];
  paste(): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onWriteParsed(cb: () => void): { dispose(): void };
}

const instances: TerminalInstance[] = [];
const fitCalls: number[] = [];
const bufferListeners: Array<(buffer: { type: "normal" | "alternate" }) => void> = [];
const dataListeners: Array<(data: string) => void> = [];
const focused: number[] = [];
let nextRows = 24;
let nextCols = 80;
// When set, fit() sizes the terminal to its host element as the real FitAddon does (16px rows).
let fitToHost = false;

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
    host: HTMLElement | null = null;
    loadAddon() {}
    open(element: HTMLElement) {
      this.host = element;
    }
    /** The rows xterm draws: like xterm, it scrolls so the cursor row stays on screen. */
    shownLines() {
      const top = Math.max(0, this.buffer.active.cursorY - this.rows + 1);
      return this.lines.slice(top, top + this.rows);
    }
    write(data: string) {
      this.written.push(data);
      // A line-oriented model of the buffer: enough to know which rows hold text and where the cursor is.
      for (const [index, part] of data.replace(new RegExp(`${String.fromCharCode(27)}\\[[?\\d;]*[A-Za-z]`, "g"), "").split(/\r?\n/).entries()) {
        if (index > 0) this.lines.push("");
        this.lines[this.lines.length - 1] += part.replace(/\r/g, "");
      }
      this.buffer.active.cursorY = this.lines.length - 1;
      this.buffer.active.length = this.lines.length;
      for (const parsed of this.parsedListeners) parsed();
    }
    parsedListeners: Array<() => void> = [];
    paste() {}
    focus() { focused.push(1); }
    blur() {}
    dispose() {}
    onData(cb: (data: string) => void) {
      dataListeners.push(cb);
      return { dispose() {} };
    }
    onWriteParsed(cb: () => void) {
      this.parsedListeners.push(cb);
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fitCalls.push(1);
      const current = instances.at(-1);
      if (current && fitToHost && current.host) {
        current.rows = Math.max(1, Math.floor(parseFloat(current.host.style.height) / 16));
        current.cols = nextCols;
      } else if (current) {
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
const { RUNNING_INDICATOR_DELAY_MS } = await import("./runningIndicator");
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
  fitToHost = false;
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
  expect(clip.classList.contains("empty")).toBe(true);
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

it("keeps xterm opaque on the Terminal background in a running block", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output: "boom\r\n", outputOffset: 0 }),
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
  expect((term.options.theme as { background: string }).background).toBe(terminalAppearance().theme.background);
  expect(term.options.allowTransparency).not.toBe(true);
});

it.each([
  // 10% of the error red over the Terminal background, as one solid colour.
  ["Oxide Dark", "#312526"],
  ["Oxide Light", "#F6E6E4"],
])("tints a failed block on %s with one opaque colour shared by the block and its xterm canvas", async (themeName, tint) => {
  const initial = getAppearance();
  saveAppearance({ ...initial, themeName });
  try {
    const render = (ended: boolean) =>
      act(async () =>
        root.render(
          createElement(TerminalCommandBlock, {
            block: baseBlock({ output: "boom\r\n", ended, exitCode: ended ? 2 : null }),
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
    await render(true);
    const section = mount.querySelector("section.terminal-command-block")!;
    expect(section.classList.contains("failed")).toBe(true);
    const status = section.querySelector(".terminal-block-status")!;
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent).toContain("exit 2");
    expect((term.options.theme as { background: string }).background.toUpperCase()).toBe(tint);
    expect(terminalAppearance({ failed: true }).theme.background.toUpperCase()).toBe(tint);
    // The block paints var(--terminal-failed-background): the same colour, so no box shows around the canvas.
    expect(document.documentElement.style.getPropertyValue("--terminal-failed-background").toUpperCase()).toBe(tint);
    expect(term.options.allowTransparency).not.toBe(true);
  } finally {
    saveAppearance(initial);
  }
});

it("keeps a failed block tinted when the appearance changes", async () => {
  const initial = getAppearance();
  saveAppearance({ ...initial, themeName: "Oxide Dark" });
  try {
    await act(async () =>
      root.render(
        createElement(TerminalCommandBlock, {
          block: baseBlock({ output: "boom\r\n", ended: true, exitCode: 1 }),
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
      saveAppearance({ ...initial, themeName: "Oxide Light" });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((instances[0].options.theme as { background: string }).background.toUpperCase()).toBe("#F6E6E4");
  } finally {
    saveAppearance(initial);
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

function mixHex(base: string, other: string, share: number) {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) => Math.round(channel(base, i) * (1 - share) + channel(other, i) * share).toString(16).padStart(2, "0"))
    .join("")}`;
}

it.each([
  ["Oxide Dark", "#FFFFFF"],
  ["Oxide Light", "#1C1C1E"],
])("keeps failed-block text at WCAG AA contrast on its red tint on %s", (themeName, brightText) => {
  const initial = getAppearance();
  saveAppearance({ ...initial, themeName });
  try {
    const { theme } = terminalAppearance({ failed: true }) as { theme: Record<string, string> };
    // A theme without an error colour falls back to the --red of styles.css.
    const errorRed =
      document.documentElement.style.getPropertyValue("--red") || /--red:\s*(#[\da-f]{6})/i.exec(stylesCss)![1];
    for (const color of [theme.foreground, theme.red, theme.brightRed]) {
      expect(color, themeName).toMatch(/^#[\da-f]{6}$/i);
      expect(contrast(color, theme.background), `${color} on ${theme.background}`).toBeGreaterThanOrEqual(4.5);
    }
    // The exit badge and $ of a failed block (red 85% toward the bright text) right on its tint:
    // see the failed-block rules in workbench.css.
    const badge = mixHex(errorRed, brightText, 0.15);
    expect(contrast(badge, theme.background), `${badge} on ${theme.background}`).toBeGreaterThanOrEqual(4.5);
  } finally {
    saveAppearance(initial);
  }
});

// Plain output sits a step under the command (the bright text, semibold) and selection stays a
// soft tint, with every pairing at WCAG AA on the plain and the failed backgrounds.
// Expected values are worked by hand from the Titanium palette: output is the Terminal foreground
// 18% of the way to the background; selection is the selection colour at 60% (inactive 35%).
it.each([
  ["Oxide Dark", { output: "#C3C2BE", bright: "#FFFFFF", selection: "#2A4A7899", inactive: "#2A4A7859" }],
  ["Oxide Light", { output: "#515153", bright: "#1C1C1E", selection: "#BCD6F599", inactive: "#BCD6F559" }],
])("draws plain output softer than the command and selects it with a soft tint on %s", (themeName, expected) => {
  const initial = getAppearance();
  saveAppearance({ ...initial, themeName });
  try {
    for (const failed of [false, true]) {
      const { theme } = terminalAppearance({ failed }) as { theme: Record<string, string> };
      expect(theme.foreground.toUpperCase()).toBe(expected.output);
      expect(theme.selectionBackground.toUpperCase()).toBe(expected.selection);
      expect(theme.selectionInactiveBackground.toUpperCase()).toBe(expected.inactive);
      // Programs' own colours are left alone, so no selection foreground overrides them.
      expect(theme.selectionForeground).toBeUndefined();
      const background = theme.background;
      // xterm's WebGL renderer paints selection as the selection colour blended over the theme background.
      const alpha = (hex: string) => parseInt(hex.slice(7, 9), 16) / 255;
      const selected = mixHex(background, theme.selectionBackground.slice(0, 7), alpha(theme.selectionBackground));
      const inactive = mixHex(background, theme.selectionInactiveBackground.slice(0, 7), alpha(theme.selectionInactiveBackground));
      for (const surface of [background, selected, inactive]) {
        expect(contrast(theme.foreground, surface), `output ${theme.foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(expected.bright, surface), `command ${expected.bright} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      // The hierarchy: the command reads brighter than its output.
      expect(contrast(expected.bright, background)).toBeGreaterThan(contrast(theme.foreground, background) * 1.2);
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
  const written = term.written.join("");
  expect(written.indexOf("\x1b[?25l")).toBeGreaterThan(written.indexOf("old\r\n"));
  expect(written.indexOf("old\r\n")).toBeGreaterThanOrEqual(0);
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

it("keeps the cursor row of a block running past the running indicator delay, where the program may read input", async () => {
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
    await new Promise((r) => setTimeout(r, RUNNING_INDICATOR_DELAY_MS + 50));
  });
  expect(mount.querySelector<HTMLElement>(".terminal-output-clip")!.style.height).toBe("32px");
});

it.each([
  ["a failed cd", "cd: no such file or directory: tests/\r\n", 1],
  ["a command not found", "zsh: command not found: prova\r\n", 127],
  ["two lines", "first\r\nsecond\r\n", 0],
])("shows the output of an ended block in the rows it keeps: %s", async (_, output, exitCode) => {
  fitToHost = true;
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output, ended: true, exitCode }),
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
  // What the reader sees: the rows xterm draws, cut to the clip.
  const seen = instances[0].shownLines().slice(0, parseFloat(clip.style.height) / 16);
  const expected = output.split("\r\n").filter(Boolean);
  expect(seen).toEqual(expected);
});

it.each([
  ["taller than the Terminal (seq 120)", 120, "1920px"],
  ["past the row cap (seq 300)", 300, "3200px"],
])("keeps every row of an ended block %s, never cut to the Terminal's height", async (_, lines, height) => {
  fitToHost = true;
  const output = Array.from({ length: lines }, (_, i) => `${i + 1}\r\n`).join("");
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
  const clip = mount.querySelector<HTMLElement>(".terminal-output-clip")!;
  const host = mount.querySelector<HTMLElement>(".terminal-block-output")!;
  expect(clip.style.height).toBe(height);
  // Past the cap, xterm scrolls inside a host exactly as tall as the clip: no row hides below it.
  if (lines > 200) expect(host.style.height).toBe(height);
});

it("stays inline when a prompt redraws itself in the normal buffer", async () => {
  const screens: boolean[] = [];
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output: "? Pick skills\r\n" }),
        active: true,
        visible: true,
        onInput: () => {},
        onReady: () => {},
        onResize: () => {},
        onScreen: (screen: boolean) => screens.push(screen),
      }),
    ),
  );
  await act(async () => {
    instances[0].write("\x1b[2A\x1b[5;1H [x] one\r\n");
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(screens).not.toContain(true);
  expect(mount.querySelector("section")!.classList.contains("fullscreen")).toBe(false);
});

it("keeps rows a program draws below its cursor inside the block", async () => {
  await act(async () =>
    root.render(
      createElement(TerminalCommandBlock, {
        block: baseBlock({ output: "> prompt\r\n\r\n? for shortcuts" }),
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
    const term = instances[0] as TerminalInstance & { parsedListeners: Array<() => void> };
    term.buffer.active.cursorY = 0; // the cursor went back up to the prompt
    for (const parsed of term.parsedListeners) parsed();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(mount.querySelector<HTMLElement>(".terminal-output-clip")!.style.height).toBe("48px");
});

describe("running indicator", () => {
  // The running treatment (status rail, accent $, spinner) is time based: a command that ends
  // before RUNNING_INDICATOR_DELAY_MS never shows it, so a fast `cd` does not flash blue.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const render = (ended: boolean) =>
    act(async () =>
      root.render(
        createElement(TerminalCommandBlock, {
          block: baseBlock({ command: "cd ..", ended, exitCode: ended ? 0 : null }),
          active: !ended,
          visible: true,
          onInput: () => {},
          onReady: () => {},
          onResize: () => {},
          onScreen: () => {},
        }),
      ),
    );
  const section = () => mount.querySelector("section.terminal-command-block")!;
  const spinner = () => section().querySelector('[role="img"][aria-label="Running"]');
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  it("never shows a command that ends within 100 ms as running", async () => {
    const seen: boolean[] = [];
    await render(false);
    seen.push(section().classList.contains("running"), spinner() !== null);
    await advance(100);
    seen.push(section().classList.contains("running"), spinner() !== null);
    await render(true);
    await advance(1_000);
    seen.push(section().classList.contains("running"), spinner() !== null);
    expect(seen).toEqual([false, false, false, false, false, false]);
  });

  it("shows a command still running at 400 ms as running without a header spinner", async () => {
    await render(false);
    await advance(400);
    expect(section().classList.contains("running")).toBe(true);
    expect(spinner()).toBeNull();
    await advance(60_000);
    expect(section().classList.contains("running")).toBe(true);
    expect(spinner()).toBeNull();
    await render(true);
    expect(section().classList.contains("running")).toBe(false);
    expect(spinner()).toBeNull();
  });
});

it("subtracts the block header and clip margins from the normal-buffer viewport inside .terminal-block-scroll", async () => {
  fitToHost = true;
  const scroller = document.createElement("div");
  scroller.className = "terminal-block-scroll";
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 520 });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 600 });
  const innerMount = document.createElement("div");
  scroller.append(innerMount);
  workspace.append(scroller);
  const innerRoot = createRoot(innerMount);
  const onReady = vi.fn();
  const onResize = vi.fn();

  try {
    await act(async () =>
      innerRoot.render(
        createElement(TerminalCommandBlock, {
          block: baseBlock({ command: "top" }),
          active: true,
          visible: true,
          onInput: () => {},
          onReady,
          onResize,
          onScreen: () => {},
        }),
      ),
    );
    const blockHeader = innerMount.querySelector<HTMLElement>("section.terminal-command-block > header")!;
    const clip = innerMount.querySelector<HTMLElement>(".terminal-output-clip")!;
    Object.defineProperty(blockHeader, "offsetHeight", { configurable: true, get: () => 36 });
    clip.style.marginBottom = "8px";

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // (520 - 36 - 8) = 476px -> floor(476 / 16) = 29 rows
    expect(onReady).toHaveBeenLastCalledWith(29, 80);

    // Alternate screen fullscreen still uses the full workspace viewport (600px).
    await act(async () => {
      for (const cb of bufferListeners) cb({ type: "alternate" });
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(clip.style.height).toBe("600px");
  } finally {
    await act(async () => innerRoot.render(null));
    scroller.remove();
  }
});


describe("height of a block while its command runs", () => {
  // Blocks are bottom-anchored above the command line: a row that comes and goes in the newest
  // block moves every block above it. Only rows with text count while a command runs.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const clipHeight = () => mount.querySelector<HTMLElement>(".terminal-output-clip")!.style.height;
  const render = (block: Partial<Parameters<typeof TerminalCommandBlock>[0]["block"]>, active: boolean) =>
    act(async () =>
      root.render(
        createElement(TerminalCommandBlock, {
          block: baseBlock({ command: "cd ..", ...block }),
          active,
          visible: true,
          onInput: () => {},
          onReady: () => {},
          onResize: () => {},
          onScreen: () => {},
        }),
      ),
    );
  const frame = () => act(async () => { vi.advanceTimersByTime(16); });

  it("never gives a fast command without output an output area", async () => {
    const seen: string[] = [];
    await render({ started: false }, true);
    seen.push(clipHeight());
    await frame();
    seen.push(clipHeight());
    await render({ started: true }, true);
    seen.push(clipHeight());
    await frame();
    seen.push(clipHeight());
    await render({ started: true, ended: true, exitCode: 0, completedAt: 1012 }, false);
    seen.push(clipHeight());
    await frame();
    seen.push(clipHeight());
    expect(seen).toEqual(["0px", "0px", "0px", "0px", "0px", "0px"]);
  });

  it("grows the output area of a command printing one line exactly once", async () => {
    const seen: string[] = [];
    await render({ command: "echo hi" }, true);
    await frame();
    seen.push(clipHeight());
    await render({ command: "echo hi", output: "hi\r\n" }, true);
    seen.push(clipHeight());
    await frame();
    seen.push(clipHeight());
    await render({ command: "echo hi", output: "hi\r\n", ended: true, exitCode: 0 }, false);
    seen.push(clipHeight());
    await frame();
    seen.push(clipHeight());
    expect(seen).toEqual(["0px", "16px", "16px", "16px", "16px"]);
  });
});
