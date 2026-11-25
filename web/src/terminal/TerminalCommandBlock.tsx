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
  const [screen, setScreen] = useState(false);
  const [height, setHeight] = useState(16);
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
    // `trim`: the height the reader sees. Once the block has ended its cursor row is not content,
    // so the clip stops at the last row with text. The xterm itself keeps every row through the
    // cursor's: fitted any shorter, xterm scrolls to keep the cursor on screen and the text with
    // it out of view (a one-line error would show as an empty row and a scrollbar).
    const contentHeight = (trim = true) => {
      const { active: isActive, block: current } = callbacks.current;
      if (!isActive && !current.output && current.outputOffset === 0) return 0;
      const buffer = term.buffer.active;
      let rows = buffer.baseY + buffer.cursorY + 1;
      if (!isActive && trim) {
        while (rows > 0 && !buffer.getLine(rows - 1)?.translateToString(true).trim()) rows--;
        if (!rows) return 0;
      }
      return Math.max(1, Math.min(200, rows)) * cell;
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
      setHeight(
        interactive && callbacks.current.active
          ? viewport
          : Math.min(viewport, contentHeight()),
      );
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
      return false;
    };
    const alternate = term.buffer.onBufferChange((buffer) => {
      if (buffer.type === "alternate") markScreen();
      else if (interactive) {
        interactive = false;
        setScreen(false);
        scheduleFit();
      }
    });
    // Cursor-addressed applications also use the normal buffer (readline, Ink, curses variants).
    const cursor = term.parser.registerCsiHandler({ final: "H" }, (params) => {
      if (Number(params[0] ?? 1) > 1) markScreen();
      return false;
    });
    const cursorUp = term.parser.registerCsiHandler({ final: "A" }, markScreen);
    // Until the shell marks the start, it is still reading the block's own command line: a key
    // (or a terminal reply) sent then would land in that line instead of reaching the program.
    const input = term.onData((data) => {
      const { active, block } = callbacks.current;
      if (active && block.started) callbacks.current.onInput(data);
    });
    const parsed = term.onWriteParsed(() => {
      setHeight(
        interactive && callbacks.current.active
          ? viewport
          : Math.min(viewport || 800, contentHeight()),
      );
    });
    scheduleFit();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      window.removeEventListener("oxide-appearance-changed", appearance);
      observer.disconnect();
      input.dispose();
      parsed.dispose();
      alternate.dispose();
      cursor.dispose();
      cursorUp.dispose();
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
  const showRunning = useRunningIndicator(active);
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
