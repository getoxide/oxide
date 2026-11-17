import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SquareFillIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type Thread } from "./bindings";
import { terminalAppearance } from "./appearance";
import { readableModel } from "./headerLines";
import { takeFrameBatch } from "./terminalOutput";
import { threadTitle } from "./threadList";
import { ThreadHeader } from "./ThreadHeader";
import { useTerminalTransfer } from "./useTerminalTransfer";
import "@xterm/xterm/css/xterm.css";

interface Props {
  thread: Thread;
  /** Whether the Thread is showing; a hidden terminal keeps its place and its process. */
  visible: boolean;
  gitControls?: ReactNode;
  onThreadUpdated: (thread: Thread) => void;
  onThreadTitleChange?: (threadId: number, title: string) => void;
}

/** What the header says about an Agent terminal; the sidebar shows the same status. */
export function agentStatusLabel(status: Thread["status"]): string {
  switch (status) {
    case "running": return "Running";
    case "working": return "Working";
    case "needs-input": return "Needs input";
    case "completed": return "Completed";
    case "stopped": return "Stopped";
    case "error": return "Exited with an error";
    default: return status;
  }
}

const MODE_LABEL = { ask: "Ask", "auto-edit": "Auto-edit", "full-access": "Full access" } as const;

/**
 * A terminal Thread's centre: the Provider's own CLI in a terminal that Core owns. The view only
 * shows it; closing the view (switching Thread, Surface or Code) never ends the agent, and
 * showing it again replays the screen.
 */
export function AgentTerminalView({ thread, visible, gitControls, onThreadUpdated, onThreadTitleChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped by Restart: the new process has its own screen to attach to.
  const [run, setRun] = useState(0);
  // Resuming failed because the Provider session no longer exists: a fresh one is offered.
  const [sessionGone, setSessionGone] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const threadId = thread.id;
  // The agent reports working, needs input and completed while it lives; `error` and `stopped`
  // are how it ended (an agent that reported an error and is still alive is not told apart).
  const running = thread.status !== "stopped" && thread.status !== "error";

  const write = (data: string) =>
    void commands.writeAgentTerminal(threadId, [...new TextEncoder().encode(data)]).then((result) => {
      if (result.status === "error") setError(result.error.message);
    });
  const onUpdated = useRef(onThreadUpdated);
  const latestWrite = useRef(write);
  useLayoutEffect(() => {
    latestWrite.current = write;
    onUpdated.current = onThreadUpdated;
  });

  const transfer = useTerminalTransfer(frame, visible && running, (text) => {
    terminal.current?.paste(text);
    terminal.current?.focus();
  });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      ...terminalAppearance(),
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    let active = true;
    let animation = 0;
    let lastSize = "";
    const pending: Uint8Array[] = [];
    const flush = () => {
      animation = 0;
      if (!active || pending.length === 0) return;
      term.write(takeFrameBatch(pending));
      if (pending.length > 0) animation = requestAnimationFrame(flush);
    };
    const channel = new Channel<number[]>();
    channel.onmessage = (chunk) => {
      pending.push(Uint8Array.from(chunk));
      if (!animation) animation = requestAnimationFrame(flush);
    };
    // Opening the Thread resumes an agent that is stopped because Oxide was relaunched.
    void commands.openAgent(threadId).then((opened) => {
      if (!active) return;
      if (opened.status === "ok" && opened.data) onUpdated.current(opened.data);
      return commands.attachAgentTerminal(threadId, channel).then((result) => {
        if (active && result.status === "error") setError(result.error.message);
      });
    });
    const resize = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      fit.fit();
      const size = `${term.rows}:${term.cols}`;
      if (size === lastSize || term.rows < 2 || term.cols < 2) return;
      lastSize = size;
      void commands.resizeAgentTerminal(threadId, term.rows, term.cols);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const appearance = () => {
      const options = terminalAppearance();
      term.options.fontFamily = options.fontFamily;
      term.options.fontSize = options.fontSize;
      term.options.fontWeight = options.fontWeight;
      term.options.theme = options.theme;
      resize();
    };
    window.addEventListener("oxide-appearance-changed", appearance);
    const input = term.onData((data) => latestWrite.current(data));
    return () => {
      active = false;
      cancelAnimationFrame(animation);
      window.removeEventListener("oxide-appearance-changed", appearance);
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [threadId, run]);

  useEffect(() => {
    if (running) return;
    let active = true;
    void commands.agentSessionGone(threadId).then((result) => {
      if (active) setSessionGone(result.status === "ok" && result.data === true);
    });
    return () => { active = false; };
  }, [threadId, running, run]);

  useEffect(() => {
    if (visible) terminal.current?.focus();
  }, [visible, threadId, run]);

  const stop = async () => {
    setBusy(true);
    setError(null);
    const result = await commands.stopAgent(threadId);
    if (result.status === "error") setError(result.error.message);
    setBusy(false);
  };
  const restart = async () => {
    setBusy(true);
    setError(null);
    const result = await commands.restartAgent(threadId);
    if (result.status === "error") setError(result.error.message);
    else {
      onThreadUpdated(result.data);
      setRun((n) => n + 1);
    }
    setBusy(false);
  };
  const freshSession = async () => {
    setBusy(true);
    setError(null);
    const result = await commands.startFreshAgentSession(threadId);
    if (result.status === "error") setError(result.error.message);
    else {
      onThreadUpdated(result.data);
      setSessionGone(false);
      setRun((n) => n + 1);
    }
    setBusy(false);
  };
  const saveRename = async () => {
    setEditing(false);
    const title = editTitle.trim();
    if (!title) return;
    const result = await commands.renameThread(threadId, title);
    if (result.status === "ok") onThreadTitleChange?.(threadId, title);
    else setError("Could not rename the Thread.");
  };

  const detail = [
    thread.model ? readableModel(thread.model, null) : null,
    MODE_LABEL[thread.permissionMode],
  ].filter(Boolean).join(" · ");
  const failedSetup = thread.status === "error" && thread.setupOutput != null && !running;

  return (
    <div className="thread-container agent-terminal-view">
      <ThreadHeader
        threadId={threadId}
        thread={thread}
        title={threadTitle(thread)}
        provider={thread.provider}
        model={thread.model}
        gitControls={gitControls}
        reportsUsage
        editing={editing}
        editTitle={editTitle}
        onEditTitleChange={setEditTitle}
        onStartRename={() => { setEditTitle(threadTitle(thread)); setEditing(true); }}
        onSaveRename={() => void saveRename()}
        onCancelRename={() => setEditing(false)}
      />
      <div className="agent-terminal-bar">
        <span className="agent-terminal-status" role="status">{agentStatusLabel(thread.status)}</span>
        {detail && <span className="mono agent-terminal-detail" title="The Model and Permission mode the agent was launched with">{detail}</span>}
        {running ? (
          <button type="button" className="btn sm" disabled={busy} onClick={() => void stop()}>
            <SquareFillIcon size={12} /> Stop
          </button>
        ) : (
          <button type="button" className="btn sm" disabled={busy} onClick={() => void restart()}>
            <SyncIcon size={12} /> Restart
          </button>
        )}
      </div>
      {thread.setupOutput != null && (
        <details className="setup-output" open={failedSetup}>
          <summary>Setup command{failedSetup ? " failed" : ""}</summary>
          <pre>{thread.setupOutput || "(no output)"}</pre>
        </details>
      )}
      {sessionGone && !running && (
        <div className="editor-error" role="alert">
          The Provider session no longer exists, so this Thread cannot resume it. Its worktree and branch are unchanged.
          {" "}
          <button type="button" className="btn sm" disabled={busy} onClick={() => void freshSession()}>
            Start a fresh session
          </button>
        </div>
      )}
      {error && <div className="editor-error" role="alert">{error}</div>}
      {transfer.error && <div className="editor-error" role="alert">{transfer.error}</div>}
      <main
        className="agent-terminal"
        aria-label="Agent terminal"
        ref={frame}
        data-dragging={transfer.dragging || undefined}
        aria-busy={transfer.busy || undefined}
      >
        <div className="agent-terminal-host" ref={host} />
        {transfer.dragging && <div className="terminal-drop-hint">Drop files to insert their paths</div>}
      </main>
    </div>
  );
}
