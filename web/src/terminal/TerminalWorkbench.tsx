import { readJson, storageKeys, writeJson } from "../shared/storage";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Channel } from "../shared/ipc";
import { TerminalIcon, XIcon, SquareFillIcon } from "@primer/octicons-react";
import {
  TerminalCommandBlock,
  type TerminalBlock as Block,
} from "./TerminalCommandBlock";
import { TerminalInput, type TerminalInputHandle } from "./TerminalInput";
import { readablePath } from "./headerLines";
import { commands } from "../bindings";
import { BlockParser, type CommandHistory } from "./terminalBlocks";
import { takeFrameBatch } from "./terminalOutput";
import { useTerminalTransfer } from "./useTerminalTransfer";
import { changeDirectoryLine, readTerminalSession, writeTerminalSession } from "../shared/session";
import { formatAccelerator, showContextMenu } from "../shared/ContextMenu";
import { copyTextToClipboard } from "../shared/platform";
import "@xterm/xterm/css/xterm.css";

interface Props {
  projectId: number;
  rootPath: string;
  contextKey: string;
  visible: boolean;
  /** The command a Command block is running, or `null` when the shell is idle. */
  onRunningChange?: (command: string | null) => void;
  /** Opens another Terminal tab in the same Project. */
  onNewTerminal?: () => void;
  /** Shown at the right end of the header, where the host puts its Maximize/Restore control. */
  headerAction?: ReactNode;
}
const isWindows = () => /Windows/i.test(navigator.userAgent);
const OUTPUT_LIMIT = 256 * 1024;
const now = () => Date.now();

function loadHistory(key: string): CommandHistory[] {
  const value = readJson(storageKeys.terminalHistory(key));
  return Array.isArray(value)
    ? value
        .filter(
          (v): v is CommandHistory =>
            typeof v?.command === "string" && typeof v?.at === "number",
        )
        .slice(-300)
    : [];
}

export function TerminalWorkbench({
  projectId,
  rootPath,
  contextKey,
  visible,
  onRunningChange,
  onNewTerminal,
  headerAction,
}: Props) {
  // The last session's blocks and folder, when session restore is on (read once per Terminal).
  const [restored] = useState(() => readTerminalSession(contextKey));
  const [blocks, setBlocks] = useState<Block[]>(() =>
    (restored?.blocks ?? []).map((block) => ({
      ...block,
      token: crypto.randomUUID(),
      outputOffset: 0,
      started: true,
      ended: true,
      truncated: false,
      restored: true,
    })),
  );
  // The shell's folder as an absolute path, for the next session; the header shows `cwd`.
  const shellCwd = useRef<string | null>(restored?.cwd ?? null);
  const restoreCwd = useRef<string | null>(restored?.cwd ?? null);
  const [history, setHistory] = useState<CommandHistory[]>(() =>
    loadHistory(contextKey),
  );
  const [sessionId, setSessionId] = useState<number | null>(null);
  // The shell Core started (zsh, bash or PowerShell); a generic name until it answers.
  const [shellName, setShellName] = useState(isWindows() ? "PowerShell" : "Shell");
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [cwd, setCwd] = useState(readablePath(restored?.cwd ?? rootPath));
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const launched = useRef(new Set<string>());
  const [running, setRunning] = useState(false);
  const activeBlock = useRef<string | null>(null);
  const runningCommand = useRef("");
  const reportRunning = useRef(onRunningChange);
  useEffect(() => { reportRunning.current = onRunningChange; });
  useEffect(() => { reportRunning.current?.(running ? runningCommand.current : null); }, [running]);
  const composer = useRef<TerminalInputHandle>(null);
  // Read by the output listener, which lives as long as the shell and would otherwise keep the
  // visibility the Terminal had when the shell started.
  const visibleRef = useRef(visible);
  useLayoutEffect(() => { visibleRef.current = visible; });
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const runRef = useRef<(command: string) => void>(() => {});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const host = useRef<HTMLElement>(null);
  const pasteActive = useRef<((text: string) => void) | null>(null);
  const onPasteReady = useCallback((paste: ((text: string) => void) | null) => { pasteActive.current = paste; }, []);
  const transfer = useTerminalTransfer(host, visible && !closed && sessionId !== null, (text) => {
    if (running) pasteActive.current?.(text);
    else composer.current?.insert(text);
  });

  useEffect(() => {
    let active = true;
    let id: number | null = null;
    let frame: number | null = null;
    const pending: Uint8Array[] = [];
    const decoder = new TextDecoder();
    const parser = new BlockParser();
    let inCommand = false;
    let probeBuffer = "";
    const windows = isWindows();
    const pendingReplies: string[] = [];
    const reply = (text: string) => {
      if (id === null) pendingReplies.push(text);
      else void commands.writeTerminal(id, [...new TextEncoder().encode(text)]);
    };
    const channel = new Channel<number[]>();
    const flush = () => {
      frame = null;
      const events = parser.push(
        decoder.decode(takeFrameBatch(pending), { stream: true }),
      );
      if (active) {
        for (const event of events) {
          // ConPTY asks for the cursor position at startup and waits for the answer. A POSIX shell
          // never needs one, and an answer would land in its line editor as typed text.
          if (event.type === "output" && !inCommand && windows) {
            probeBuffer += event.text;
            while (probeBuffer.includes("\x1b[6n")) {
              reply("\x1b[1;1R");
              probeBuffer = probeBuffer.slice(
                probeBuffer.indexOf("\x1b[6n") + 4,
              );
            }
            probeBuffer = probeBuffer.slice(-16);
          }
          if (event.type === "closed") {
            setClosed(true);
            setRunning(false);
            activeBlock.current = null;
            setBlocks((old) =>
              old.map((b) => (b.ended ? b : { ...b, ended: true, completedAt: Date.now() })),
            );
          }
          if (event.type === "start" && activeBlock.current === event.token) {
            inCommand = true;
            setBlocks((old) =>
              old.map((b) =>
                b.token === event.token ? { ...b, started: true, at: Date.now() } : b,
              ),
            );
          }
          if (event.type === "output" && activeBlock.current) {
            const token = activeBlock.current;
            setBlocks((old) =>
              old.map((b) => {
                if (b.token !== token || !b.started || b.ended) return b;
                const output = b.output + event.text;
                return {
                  ...b,
                  output: output.slice(-OUTPUT_LIMIT),
                  outputOffset:
                    b.outputOffset + Math.max(0, output.length - OUTPUT_LIMIT),
                  truncated: b.truncated || output.length > OUTPUT_LIMIT,
                };
              }),
            );
          }
          if (event.type === "end" && activeBlock.current === event.token) {
            setBlocks((old) =>
              old.map((b) =>
                b.token === event.token
                  ? { ...b, ended: true, exitCode: event.exitCode, completedAt: Date.now() }
                  : b,
              ),
            );
            if (event.cwd) {
              shellCwd.current = event.cwd;
              setCwd(readablePath(event.cwd));
            }
            setHistory((old) =>
              old.map((h, index) =>
                index === old.length - 1
                  ? { ...h, exitCode: event.exitCode }
                  : h,
              ),
            );
            activeBlock.current = null;
            setRunning(false);
            inCommand = false;
            if (visibleRef.current) requestAnimationFrame(() => composer.current?.focus());
          }
        }
      }
      if (pending.length) frame = requestAnimationFrame(flush);
    };
    channel.onmessage = (bytes) => {
      pending.push(new Uint8Array(bytes));
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    void commands
      .startBlockTerminal(projectId, channel)
      .then(async (result) => {
        if (result.status === "error") throw new Error(result.error.message);
        id = result.data.id;
        if (!active) {
          await commands.closeTerminal(id);
          return;
        }
        setSessionId(id);
        if (result.data.shell) setShellName(result.data.shell);
        // A restored Terminal's new shell moves to the folder the old one was in, before any block.
        if (restoreCwd.current) {
          const line = changeDirectoryLine(restoreCwd.current, isWindows());
          restoreCwd.current = null;
          void commands.writeTerminal(id, [...new TextEncoder().encode(line)]);
        }
        setClosed(false);
        setError(null);
        for (const text of pendingReplies) reply(text);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      if (id !== null) void commands.closeTerminal(id);
    };
    // A mode switch must never start a new shell.
  }, [projectId, generation]);

  useEffect(() => {
    writeJson(storageKeys.terminalHistory(contextKey), history);
  }, [history, contextKey]);
  // Saved for session restore a moment after output settles, and when the window goes away.
  useEffect(() => {
    const save = () => writeTerminalSession(contextKey, {
      cwd: shellCwd.current,
      blocks: blocks.filter((block) => block.started).map((block) => ({
        command: block.command,
        output: block.output,
        exitCode: block.ended ? block.exitCode : null,
        at: block.at,
        completedAt: block.completedAt ?? Date.now(),
      })),
    });
    const timer = window.setTimeout(save, 500);
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", save);
    };
  }, [blocks, cwd, contextKey]);
  useEffect(() => {
    if (visible && following.current)
      bottom.current?.scrollIntoView({ block: "nearest" });
  }, [blocks, visible]);

  const write = useCallback(
    async (text: string) => {
      if (sessionId === null) return;
      try {
        const result = await commands.writeTerminal(sessionId, [
          ...new TextEncoder().encode(text),
        ]);
        if (result.status === "error") setError(result.error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );
  const clearTerminal = useCallback(() => {
    if (running) return;
    setBlocks([]);
    launched.current.clear();
    setFullscreen(null);
    composer.current?.clear();
    setError(null);
  }, [running]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text) return;
      if (running) pasteActive.current?.(text);
      else composer.current?.insert(text);
    } catch {
      // Clipboard read may be denied by the environment.
    }
  }, [running]);

  function run(command: string) {
    if (
      !command.trim() ||
      running ||
      closed ||
      sessionId === null ||
      activeBlock.current
    )
      return;
    if (/^(clear|cls|clear-host)\s*$/i.test(command.trim())) {
      clearTerminal();
      return;
    }
    const token = crypto.randomUUID();
    setFullscreen(null);
    const block: Block = {
      token,
      command,
      output: "",
      outputOffset: 0,
      at: now(),
      exitCode: null,
      started: false,
      ended: false,
      truncated: false,
    };
    activeBlock.current = token;
    runningCommand.current = command;
    setRunning(true);
    composer.current?.clear();
    setError(null);
    following.current = true;
    setBlocks((old) => [...old.slice(-23), block]);
    setHistory((old) =>
      [...old, { command, at: block.at, exitCode: null }].slice(-300),
    );
  }

  function launch(block: Block, rows: number, cols: number) {
    if (sessionId === null || launched.current.has(block.token)) return;
    launched.current.add(block.token);
    void (async () => {
      const resized = await commands.resizeTerminal(sessionId, rows, cols);
      if (resized.status === "error") throw new Error(resized.error.message);
      const result = await commands.runTerminalBlock(
        sessionId,
        block.command,
        block.token,
      );
      if (result.status === "error") throw new Error(result.error.message);
    })().catch((error: Error) => {
      setError(error.message);
      setRunning(false);
      activeBlock.current = null;
      setBlocks((old) =>
        old.map((b) => (b.token === block.token ? { ...b, ended: true, completedAt: Date.now() } : b)),
      );
    });
  }

  useLayoutEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!visible) return;
    if (!running) composer.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target)) return;
      if (!running && event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        runRef.current("clear");
      }
      if (
        !running &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        composer.current?.history();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [visible, running]);
  return (
    <main
      className="terminal-workbench"
      ref={host}
      data-dragging={transfer.dragging || undefined}
      aria-label="Terminal workbench"
      hidden={!visible}
      data-fullscreen={running && fullscreen !== null ? "true" : undefined}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement | null)?.closest?.(".terminal-command-block")) return;
        const selectedText = window.getSelection()?.toString() ?? "";
        showContextMenu(
          event,
          [
            ...(selectedText ? [{ label: "Copy", hint: formatAccelerator("Mod+C"), run: () => copyTextToClipboard(selectedText) }] : []),
            { label: "Paste", hint: formatAccelerator("Mod+V"), disabled: closed || sessionId === null, run: () => void pasteFromClipboard() },
            { label: "Clear terminal", disabled: running || blocks.length === 0, run: clearTerminal, separatorBefore: true },
            ...(onNewTerminal ? [{ label: "New terminal", run: onNewTerminal }] : []),
          ],
          { replaceEdit: true },
        );
      }}
    >
      <header className="workbench-terminal-header">
        <TerminalIcon size={16} />
        <strong>{shellName}</strong>
        <span className="mono" title={cwd}>
          {cwd}
        </span>
        {headerAction && <span className="workbench-terminal-actions">{headerAction}</span>}
      </header>
      <div
        className="terminal-block-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          following.current =
            !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {blocks.map((block, index) => (
          <Fragment key={block.token}>
          <TerminalCommandBlock
            onPasteReady={onPasteReady}
            block={block}
            active={!block.ended}
            visible={visible}
            onInput={(data) => void write(data)}
            onReady={(rows, cols) => launch(block, rows, cols)}
            onScreen={(screen) =>
              setFullscreen((old) =>
                screen ? block.token : old === block.token ? null : old,
              )
            }
            onResize={(rows, cols) => {
              if (sessionId !== null && !block.ended)
                void commands.resizeTerminal(sessionId, rows, cols);
            }}
            canPaste={!closed && sessionId !== null}
            canClear={!running}
            onPaste={() => void pasteFromClipboard()}
            onClear={clearTerminal}
            onNewTerminal={onNewTerminal}
          />
          {block.restored && !blocks[index + 1]?.restored && (
            <div className="terminal-session-divider" role="separator" aria-label="Restored from the last session">
              <span>Restored session</span>
            </div>
          )}
          </Fragment>
        ))}
        <div ref={bottom} />
      </div>
      {transfer.dragging && <div className="terminal-drop-hint">Drop files to insert their paths</div>}
      {error && (
        <div className="editor-error" role="alert">
          {error}
          <button
            className="icon-btn sm"
            aria-label="Dismiss terminal error"
            onClick={() => setError(null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
      {closed && (
        <div className="terminal-shell-closed" role="status">
          Shell exited.{" "}
          <button
            className="btn sm"
            onClick={() => {
              setSessionId(null);
              shellCwd.current = null;
              setCwd(readablePath(rootPath));
              setGeneration((n) => n + 1);
            }}
          >
            Start a new shell
          </button>
        </div>
      )}
      {running ? (
        !fullscreen && (
          <button
            className="terminal-interrupt"
            onClick={() => void write("\x03")}
            aria-label="Interrupt command"
          >
            <SquareFillIcon size={12} /> Interrupt <kbd>Ctrl+C</kbd>
          </button>
        )
      ) : (
        <TerminalInput
          ref={composer}
          history={history}
          sessionId={sessionId}
          cwd={cwd}
          disabled={closed || sessionId === null}
          visible={visible}
          fresh={blocks.length === 0}
          onRun={run}
        />
      )}
    </main>
  );
}
