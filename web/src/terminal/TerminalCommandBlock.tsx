import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalAppearance } from "../shared/appearance";
import { formatAccelerator, showContextMenu } from "../shared/ContextMenu";
import { copyTextToClipboard } from "../shared/platform";
import { attachGpuRenderer } from "./gpuRenderer";
import { useRunningIndicator } from "./runningIndicator";

export interface TerminalBlock {
  token: string;
  command: string;
  output: string;
  outputOffset: number;
  at: number;
  completedAt?: number;
  exitCode: number | null;
  started: boolean;
  ended: boolean;
  truncated: boolean;
  /** Brought back from the last session: its output is a record, its shell is gone. */
  restored?: boolean;
}
interface Props {
  onPasteReady?: (paste: ((text: string) => void) | null) => void;
  block: TerminalBlock;
  active: boolean;
  visible: boolean;
  onInput: (data: string) => void;
  onReady: (rows: number, cols: number) => void;
  onResize: (rows: number, cols: number) => void;
  onScreen: (fullscreen: boolean) => void;
  canPaste?: boolean;
  canClear?: boolean;
  onPaste?: () => void;
  onClear?: () => void;
  onNewTerminal?: () => void;
}

/** The PTY has a stable viewport. Output can change its clipping, never its live geometry. */
export function TerminalCommandBlock(props: Props) {
  const { block, active, visible, onScreen, onPasteReady, canPaste, canClear, onPaste, onClear, onNewTerminal } = props;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const callbacks = useRef(props);
  const written = useRef(0);
  const fitSurface = useRef<() => void>(() => {});
  const measure = useRef<() => void>(() => {});
  const [screen, setScreen] = useState(false);
  const [height, setHeight] = useState(0);
  // A running command shows as running once it runs past the running indicator delay; from then on
  // its block also keeps xterm's cursor row, where a program may be waiting for input on a blank line.
  const showRunning = useRunningIndicator(active);
  const keepCursorRow = useRef(false);
  useLayoutEffect(() => {
    callbacks.current = props;
  });
  useEffect(() => {
    const element = host.current!;
    const workspace = element.closest<HTMLElement>(".terminal-workbench")!;
    const toolbar = workspace.querySelector<HTMLElement>(
      ".workbench-terminal-header",
    )!;
    const initial = terminalAppearance({ failed: isFailed(callbacks.current) });
    const term = new Terminal({
      ...initial,
      cursorBlink: true,
      cursorInactiveStyle: "none",
      scrollback: 5000,
      convertEol: false,
      lineHeight: 1,
      rescaleOverlappingGlyphs: true,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    const releaseGpu = attachGpuRenderer(term);
    terminal.current = term;
    let initialized = false,
      frame = 0,
      viewport = 0,
      cell = 16,
      last = "",
      interactive = false,
      settle = 0;
    // `trim`: the height the reader sees. Only rows with text count, never a bare cursor row, so
    // a command's block grows with its output and never shrinks when it ends: blocks sit on the
    // command line, and a row that came and went would move every block above it. The one
    // exception is a command still running past the running indicator delay, which keeps its
    // cursor row for a program reading input there (a row with a prompt on it has text anyway).
    // The xterm itself keeps every row through the cursor's: fitted any shorter, xterm scrolls to
    // keep the cursor on screen and the text with it out of view (a one-line error would show as
    // an empty row and a scrollbar).
    const contentHeight = (trim = true) => {
      const { active: isActive, block: current } = callbacks.current;
      const cursorRow = isActive && keepCursorRow.current;
      if (!cursorRow && !current.output && current.outputOffset === 0) return 0;
      const buffer = term.buffer.active;
      let rows = buffer.baseY + buffer.cursorY + 1;
      // A program may draw below its cursor (a hint under a prompt, the rest of a list): every
      // row with text counts, wherever the cursor stands.
      let below = buffer.length;
      while (below > rows && !buffer.getLine(below - 1)?.translateToString(true).trim()) below--;
      if (below > rows) rows = below;
      if (!cursorRow && trim) {
        while (rows > 0 && !buffer.getLine(rows - 1)?.translateToString(true).trim()) rows--;
        if (!rows) return 0;
      }
      return Math.max(1, Math.min(200, rows)) * cell;
    };
    // The clip shows whole rows only. A running block shows at most the rows xterm has (its
    // screen, cell-aligned); an ended block is a record that grows inside the Terminal's own
    // scroll, up to the row cap, past which its xterm scrolls on its own.
    const clipHeight = () => {
      if (interactive && callbacks.current.active) return viewport;
      const content = contentHeight();
      if (!callbacks.current.active) return content;
      const screen = term.rows ? term.rows * cell : viewport || 800;
      return Math.min(screen, content);
    };
    const fit = () => {
      if (
        !workspace.clientWidth ||
        !workspace.clientHeight ||
        !element.clientWidth
      )
        return;
      viewport = Math.max(80, workspace.clientHeight - toolbar.offsetHeight);
      element.style.height = `${callbacks.current.active ? viewport : Math.max(cell, contentHeight(false))}px`;
      addon.fit();
      const screenElement = element.querySelector<HTMLElement>(".xterm-screen");
      if (screenElement && term.rows)
        cell = screenElement.offsetHeight / term.rows || 16;
      setHeight(clipHeight());
      const dimensions = `${term.rows}:${term.cols}`;
      if (callbacks.current.active && dimensions !== last) {
        last = dimensions;
        if (!initialized) {
          initialized = true;
          callbacks.current.onReady(term.rows, term.cols);
        } else {
          // xterm follows every frame of a drag; the program gets the size it settles on, not a
          // redraw per frame (a full-screen app repaints its whole screen on each SIGWINCH).
          clearTimeout(settle);
          const rows = term.rows, cols = term.cols;
          settle = window.setTimeout(() => callbacks.current.onResize(rows, cols), 120);
        }
      }
    };
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fitSurface.current = scheduleFit;
    const appearance = () => {
      const options = terminalAppearance({ failed: isFailed(callbacks.current) });
      term.options.fontFamily = options.fontFamily;
      term.options.fontSize = options.fontSize;
      term.options.fontWeight = options.fontWeight;
      term.options.theme = options.theme;
      scheduleFit();
    };
    window.addEventListener("oxide-appearance-changed", appearance);
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(workspace);
    observer.observe(element);
    const markScreen = () => {
      if (!interactive) {
        interactive = true;
        setScreen(true);
        scheduleFit();
      }
    };
    // Only the alternate screen is full screen. A prompt that redraws itself in the normal buffer
    // (cursor up, cursor position: readline, Ink, multiselect pickers) stays inline, at the
    // block's own width, so it never jumps to the edge or rewraps when it ends.
    const alternate = term.buffer.onBufferChange((buffer) => {
      if (buffer.type === "alternate") markScreen();
      else if (interactive) {
        interactive = false;
        setScreen(false);
        scheduleFit();
      }
    });
    // Until the shell marks the start, it is still reading the block's own command line: a key
    // (or a terminal reply) sent then would land in that line instead of reaching the program.
    const input = term.onData((data) => {
      const { active, block } = callbacks.current;
      if (active && block.started) callbacks.current.onInput(data);
    });
    measure.current = () => setHeight(clipHeight());
    const parsed = term.onWriteParsed(() => measure.current());
    scheduleFit();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      window.removeEventListener("oxide-appearance-changed", appearance);
      observer.disconnect();
      input.dispose();
      parsed.dispose();
      alternate.dispose();
      releaseGpu();
      term.dispose();
      terminal.current = null;
    };
  }, []);
  useEffect(() => {
    if (!active || !onPasteReady) return;
    const insert = (text: string) => { terminal.current?.paste(text); terminal.current?.focus(); };
    onPasteReady(insert);
    return () => onPasteReady(null);
  }, [active, onPasteReady]);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const start = Math.max(0, written.current - block.outputOffset);
    const delta = block.output.slice(start);
    if (delta) term.write(delta);
    written.current = block.outputOffset + block.output.length;
  }, [block.output, block.outputOffset]);
  // An ended block is a record: no cursor (DECTCEM hide, which every renderer honours, WebGL
  // included) and no input, while its output stays selectable, scrollable and copyable.
  useEffect(() => {
    const term = terminal.current;
    if (!term || active) return;
    term.options.disableStdin = true;
    term.write("\x1b[?25l");
  }, [active]);
  const failed = isFailed(props);
  useEffect(() => {
    keepCursorRow.current = showRunning;
    measure.current();
  }, [showRunning]);
  useEffect(() => {
    const term = terminal.current;
    if (term) term.options.theme = terminalAppearance({ failed }).theme;
  }, [failed]);
  useEffect(() => {
    onScreen(active && screen);
  }, [active, screen, onScreen]);
  useEffect(() => {
    if (!visible) return;
    fitSurface.current();
    if (active && block.started) terminal.current?.focus();
    else terminal.current?.blur();
  }, [visible, active, block.started]);
  return (
    <section
      className={`terminal-command-block${showRunning ? " running" : ""}${failed ? " failed" : ""}${active && screen ? " fullscreen" : ""}`}
      aria-label={`Command: ${block.command}`}
      onContextMenu={(event) => {
        const selectedText = (terminal.current?.hasSelection?.() ? terminal.current.getSelection() : "") || window.getSelection()?.toString() || "";
        showContextMenu(
          event,
          [
            ...(selectedText ? [{ label: "Copy", hint: formatAccelerator("Mod+C"), run: () => copyTextToClipboard(selectedText) }] : []),
            { label: "Paste", hint: formatAccelerator("Mod+V"), disabled: !canPaste, run: () => onPaste?.() },
            { label: "Copy command", run: () => copyTextToClipboard(block.command) },
            { label: "Clear terminal", disabled: !canClear, run: () => onClear?.(), separatorBefore: true },
            ...(onNewTerminal ? [{ label: "New terminal", run: onNewTerminal }] : []),
          ],
          { replaceEdit: true },
        );
      }}
    >
      <header>
        <span className="terminal-block-prompt" aria-hidden="true">
          $
        </span>
        <code>{block.command}</code>
        <span className="grow" />
        <BlockStatus block={block} running={active} showRunning={showRunning} />
      </header>
      {block.truncated && (
        <p className="terminal-truncated">
          Showing the last 256 KiB of output.
        </p>
      )}
      <div className={`terminal-output-clip${height ? "" : " empty"}`} style={{ height }}>
        <div className="terminal-block-output" ref={host} />
      </div>
    </section>
  );
}

/** Ended without a zero exit status: a non-zero exit, or the shell went away before it reported one. */
function isFailed({ active, block }: { active: boolean; block: TerminalBlock }): boolean {
  return !active && block.exitCode !== 0;
}

/**
 * One status at the right of the header: a spinner once the command has run past the running
 * indicator delay (nothing before that), then how long it took.
 */
function BlockStatus({ block, running, showRunning }: { block: TerminalBlock; running: boolean; showRunning: boolean }) {
  // One live region per block: the spinner is mounted with it, so only the outcome is announced.
  return (
    <span className={`terminal-block-status${!running && block.exitCode !== 0 ? " error" : ""}`} role="status">
      {running ? (
        showRunning && <span className="terminal-block-spinner" role="img" aria-label="Running" />
      ) : (
        <BlockOutcome block={block} />
      )}
    </span>
  );
}

function BlockOutcome({ block }: { block: TerminalBlock }) {
  const duration = formatDuration(Math.max(0, (block.completedAt ?? block.at) - block.at));
  let visibleText = duration;
  let spokenText = `Command duration: ${duration}`;
  if (block.exitCode === null) {
    visibleText = `shell exited · ${duration}`;
    spokenText = `Shell exited after ${duration}`;
  } else if (block.exitCode !== 0) {
    visibleText = `exit ${block.exitCode} · ${duration}`;
    spokenText = `Exit ${block.exitCode} after ${duration}`;
  }
  return (
    <>
      <span aria-hidden="true">{visibleText}</span>
      <span className="sr-only">{spokenText}</span>
    </>
  );
}

/** Rounds to the shown precision before picking the unit, so 59.999 s reads 1m 0.0s, not 60.00 s. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.round(milliseconds);
  if (ms < 1000) return `${ms} ms`;
  const hundredths = Math.round(milliseconds / 10);
  if (hundredths < 6000) return `${(hundredths / 100).toFixed(2)} s`;
  const tenths = Math.round(milliseconds / 100);
  return `${Math.floor(tenths / 600)}m ${((tenths % 600) / 10).toFixed(1)}s`;
}
