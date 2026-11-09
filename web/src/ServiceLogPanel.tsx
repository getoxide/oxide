import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LinkExternalIcon, SquareFillIcon, SyncIcon, TrashIcon } from "@primer/octicons-react";
import { commands, type ProjectService, type ProjectServiceConflict, type ProjectServiceLogLine } from "./bindings";
import { PROJECT_SERVICES_CHANGED } from "./ProjectServices";
import type { TerminalCheckout } from "./terminalTabs";
import { terminalPath } from "./terminalPaths";

/** How many lines the view keeps; the Core owns the authoritative 10,000-line buffer. */
export const MAX_SERVICE_LOG_LINES = 5_000;

/** Removes terminal escape sequences without a control-character regex. */
export function stripAnsi(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 27) {
      result += text[index];
      continue;
    }
    const kind = text[index + 1];
    if (kind === "[") {
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
    } else if (kind === "]") {
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code === 7) break;
        if (code === 27 && text[index + 1] === "\\") { index += 1; break; }
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  return result;
}

/** Removes terminal escape sequences and honours carriage-return progress overwrites. */
export function cleanServiceLogLine(text: string): string {
  const stripped = stripAnsi(text);
  return stripped.includes("\r") ? (stripped.split("\r").pop() ?? stripped) : stripped;
}

/**
 * Merges a stream of lines by `seq`, so a late backlog can fill earlier lines without ever
 * duplicating one the live channel already delivered. Newest lines win.
 */
export function mergeLogLines(previous: ProjectServiceLogLine[], incoming: ProjectServiceLogLine[]): ProjectServiceLogLine[] {
  if (incoming.length === 0) return previous;
  const last = previous[previous.length - 1]?.seq;
  if (last === undefined || incoming[0].seq > last) {
    if (incoming.every((line, index) => index === 0 || line.seq > incoming[index - 1].seq)) {
      return [...previous, ...incoming].slice(-MAX_SERVICE_LOG_LINES);
    }
  }
  const bySequence = new Map(previous.map((line) => [line.seq, line]));
  for (const line of incoming) bySequence.set(line.seq, line);
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_SERVICE_LOG_LINES);
}

export interface DetectedServiceUrl {
  port: number;
  url: string;
}

/** A loopback URL or port in one log line, normalised to `http://localhost:<port>`. */
export function detectServiceUrl(text: string): DetectedServiceUrl | null {
  const match = text.match(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})\b/i);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? { port, url: `http://localhost:${port}` } : null;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export interface ServiceLogPanelProps {
  projectId: number;
  serviceId: number;
  checkout: TerminalCheckout;
  /** Whether the Terminal Surface is showing; hidden panels keep streaming. */
  visible: boolean;
  /** Reports the freshest service metadata so the tab strip can badge its live port. */
  onServiceChange?: (service: ProjectService) => void;
  /** A Restart hit a port conflict; App owns the switch/restart dialog. */
  onServiceConflict?: (conflict: ProjectServiceConflict) => void;
}

/**
 * One Project Service's read-only log. There is deliberately no stdin: services are daemons, and
 * their only controls are Restart, Stop and Clear.
 */
export function ServiceLogPanel(props: ServiceLogPanelProps) {
  // A different service is a different log; remount so no line from the old one survives.
  return <ServiceLogView key={`${props.projectId}:${props.serviceId}`} {...props} />;
}

function ServiceLogView({ projectId, serviceId, checkout, visible, onServiceChange, onServiceConflict }: ServiceLogPanelProps) {
  const [service, setService] = useState<ProjectService | null>(null);
  const [lines, setLines] = useState<ProjectServiceLogLine[]>([]);
  const [detected, setDetected] = useState<DetectedServiceUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"restart" | "stop" | "clear" | null>(null);
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // Lines at or below `floor` were cleared; a late in-flight line must not reappear.
  const floor = useRef(-1);
  const lastSeq = useRef(-1);

  const append = useCallback((incoming: ProjectServiceLogLine[]) => {
    const fresh = incoming.filter((line) => line.seq > floor.current);
    if (fresh.length === 0) return;
    for (const line of fresh) {
      if (line.seq > lastSeq.current) lastSeq.current = line.seq;
      const found = detectServiceUrl(line.text);
      if (found) setDetected(found);
    }
    setLines((previous) => mergeLogLines(previous, fresh));
  }, []);

  useEffect(() => {
    let active = true;
    void commands.projectService(serviceId).then((result) => {
      if (!active) return;
      if (result.status === "ok") setService(result.data ?? null);
      else setError(result.error.message);
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [serviceId]);

  useEffect(() => {
    let active = true;
    const channel = new Channel<ProjectServiceLogLine>();
    channel.onmessage = (line) => { if (active) append([line]); };
    void commands.subscribeProjectServiceLogs(serviceId, channel).then((result) => {
      if (!active) return;
      if (result.status === "ok") append(result.data ?? []);
      else setError(result.error.message);
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    });
    return () => {
      active = false;
      channel.onmessage = () => {};
    };
  }, [serviceId, append]);

  // Port and lifecycle changes the Core discovers (a bound port, a crash) arrive as a refetch
  // signal; the panel stays readable after the service stops.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<number>(PROJECT_SERVICES_CHANGED, (event) => {
      if (event.payload !== projectId) return;
      void commands.projectService(serviceId).then((result) => {
        if (active && result.status === "ok" && result.data) setService(result.data);
      }).catch(() => {});
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop?.();
    }).catch(() => { /* The log stream already reports an unreachable Core. */ });
    return () => { active = false; unlisten?.(); };
  }, [projectId, serviceId]);

  useEffect(() => {
    if (service) onServiceChange?.(service);
  }, [service, onServiceChange]);

  useEffect(() => {
    if (visible && following) bottom.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [lines, visible, following]);

  const port = service?.port ?? detected?.port ?? null;
  const serviceUrl = service?.url ? detectServiceUrl(service.url) : null;
  const url = detected?.url ?? serviceUrl?.url ?? (port !== null ? `http://localhost:${port}` : null);
  const status = service?.status ?? null;
  const command = service?.command ?? `Service ${serviceId}`;
  const busy = pending !== null;

  /** Empties the view but remembers the last seq so a late line from before the clear stays gone. */
  const clearVisibleLogs = () => {
    floor.current = lastSeq.current;
    setLines([]);
  };

  async function act(kind: "restart" | "stop" | "clear") {
    if (busy) return;
    setPending(kind);
    setError(null);
    try {
      if (kind === "restart") {
        const result = await commands.restartProjectService(serviceId);
        if (result.status === "error") setError(result.error.message);
        else if (result.data.outcome === "conflict") {
          // Restart stops the service before it checks the port, so it is stopped now. Refresh
          // the header, then hand the structured conflict to App for the switch/restart dialog.
          const refreshed = await commands.projectService(serviceId);
          if (refreshed.status === "ok" && refreshed.data) setService(refreshed.data);
          onServiceConflict?.(result.data.payload);
        } else {
          setService(result.data.payload);
          clearVisibleLogs();
        }
      } else if (kind === "stop") {
        const result = await commands.stopProjectService(serviceId);
        if (result.status === "error") setError(result.error.message);
        else {
          const refreshed = await commands.projectService(serviceId);
          if (refreshed.status === "ok" && refreshed.data) setService(refreshed.data);
        }
      } else {
        const result = await commands.clearProjectServiceLogs(serviceId);
        if (result.status === "error") setError(result.error.message);
        else clearVisibleLogs();
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  const openUrl = async () => {
    if (!url) return;
    setError(null);
    try {
      const result = await commands.openLocalUrl(url);
      if (result.status === "error") setError(result.error.message);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section className="service-log-panel" aria-label={`Logs for ${command}`} hidden={!visible}>
      <header className="service-log-header">
        <strong className="service-log-title">{command}</strong>
        {status && <span className={`service-status ${status}`} role="status">{status === "running" ? "Running" : status === "failed" ? "Failed" : "Stopped"}</span>}
        {port !== null && <span className="service-port">:{port}</span>}
        <span className="service-log-cwd mono" title={checkout.rootPath}>{terminalPath(checkout.rootPath)}</span>
      </header>
      <div className="service-log-actions">
        {url && (
          <button className="btn sm service-open-url" onClick={() => void openUrl()} disabled={busy} title={url}>
            <LinkExternalIcon size={12} />
            <span>Open {url}</span>
          </button>
        )}
        <button className="btn sm" onClick={() => void act("restart")} disabled={busy} aria-busy={pending === "restart"}>
          <SyncIcon size={12} /> Restart
        </button>
        <button className="btn sm" onClick={() => void act("stop")} disabled={busy || status !== "running"} aria-busy={pending === "stop"} aria-label="Stop service">
          <SquareFillIcon size={12} /> Stop
        </button>
        <button className="btn sm" onClick={() => void act("clear")} disabled={busy} aria-busy={pending === "clear"}>
          <TrashIcon size={12} /> Clear logs
        </button>
      </div>
      {error && <p className="service-log-error" role="alert">{error}</p>}
      <div className="service-log-scroll" ref={scroll} role="log" aria-label="Service output" onScroll={() => {
        const element = scroll.current;
        setFollowing(!!element && element.scrollHeight - element.scrollTop - element.clientHeight < 80);
      }}>
        {lines.length === 0 ? (
          <p className="service-log-empty">No output yet.</p>
        ) : (
          <pre className="service-log-output">
            {lines.map((line) => (
              <span key={line.seq} className={`service-log-line ${line.stream}`}>{cleanServiceLogLine(line.text)}{"\n"}</span>
            ))}
          </pre>
        )}
        <div ref={bottom} />
      </div>
      {!following && (
        <button className="btn sm service-log-jump" onClick={() => {
          setFollowing(true);
          bottom.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
        }}>
          Jump to latest
        </button>
      )}
    </section>
  );
}
