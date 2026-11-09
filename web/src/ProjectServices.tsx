import { useCallback, useEffect, useId, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDownIcon, ChevronRightIcon, SquareFillIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type ProjectService, type ProjectServiceConflict } from "./bindings";
import { errorMessage } from "./errors";

/** The global refetch signal the Core emits whenever a Project's services change. */
export const PROJECT_SERVICES_CHANGED = "project-services-changed";

interface ListProps {
  services: ProjectService[];
  onOpenService: (serviceId: number) => void;
  onStopService: (serviceId: number) => void;
  onRestartService: (serviceId: number) => void;
  pendingStopIds?: number[];
  pendingRestartIds?: number[];
  error?: string | null;
}

/**
 * The pinned sidebar list. Presentational only: it renders nothing while no service runs, so an
 * idle Project spends none of its sidebar on the widget. The section is collapsible, and the
 * collapsed choice survives while the widget stays mounted.
 */
export function ProjectServicesList({
  services,
  onOpenService,
  onStopService,
  onRestartService,
  pendingStopIds = [],
  pendingRestartIds = [],
  error = null,
}: ListProps) {
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  if (services.length === 0) return null;
  return (
    <section className="project-services" aria-label="Project Services">
      <button
        type="button"
        className="project-services-header"
        aria-expanded={!collapsed}
        aria-controls={listId}
        title={collapsed ? "Expand Project Services" : "Collapse Project Services"}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
        <span>Services</span>
        <span className="badge project-services-count" aria-label={`${services.length} running`}>{services.length}</span>
      </button>
      {error && <p className="project-services-error" role="alert">{error}</p>}
      {!collapsed && (
        <ul id={listId} className="project-services-list">
          {services.map((service) => {
            const stopping = pendingStopIds.includes(service.id);
            const restarting = pendingRestartIds.includes(service.id);
            return (
              <li key={service.id} className="service-item" data-pending={stopping || restarting || undefined}>
                <button
                  className="service-open"
                  onClick={() => onOpenService(service.id)}
                  title={`Open logs for ${service.command}`}
                >
                  <span className={`service-dot ${service.status}`} aria-label={`Status: ${service.status}`} />
                  <span className="service-command">{service.command}</span>
                  {service.port !== null && service.port !== undefined && <span className="service-port">:{service.port}</span>}
                </button>
                <button
                  className="icon-btn sm service-restart"
                  disabled={stopping || restarting}
                  aria-busy={restarting}
                  aria-label={`Restart ${service.command}`}
                  title={restarting ? `Restarting ${service.command}…` : `Restart ${service.command}`}
                  onClick={() => onRestartService(service.id)}
                >
                  <SyncIcon size={12} />
                </button>
                <button
                  className="icon-btn sm service-stop"
                  disabled={stopping || restarting}
                  aria-busy={stopping}
                  aria-label={`Stop ${service.command}`}
                  title={stopping ? `Stopping ${service.command}…` : `Stop ${service.command}`}
                  onClick={() => onStopService(service.id)}
                >
                  <SquareFillIcon size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface Props {
  projectId: number;
  onOpenService: (serviceId: number) => void;
  /** Notified after a stop request, so the app can react; the component still owns the command. */
  onStopService?: (serviceId: number) => void;
  /** A restart hit a port conflict; App owns the switch/restart dialog. */
  onServiceConflict?: (conflict: ProjectServiceConflict) => void;
}

type PendingKind = "stop" | "restart";

/**
 * One Project's running services, kept live. The Core's `project-services-changed` event is a lossy
 * refetch signal: every delivery (and every Project selection) reloads the whole list.
 */
export function ProjectServices({ projectId, onOpenService, onStopService, onServiceConflict }: Props) {
  const [snapshot, setSnapshot] = useState<{ projectId: number; services: ProjectService[] }>({ projectId, services: [] });
  const [pending, setPending] = useState<{ projectId: number; kind: PendingKind; ids: number[] }>({ projectId, kind: "stop", ids: [] });
  const [failure, setFailure] = useState<{ projectId: number; message: string; source: "list" | "stop" | "restart" } | null>(null);
  // Bumped by a stop, a restart or a Core change event to refetch; the effect below owns the request.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void commands.listProjectServices(projectId).then((result) => {
      if (!active) return;
      if (result.status === "ok") {
        setSnapshot({ projectId, services: result.data ?? [] });
        // A failed stop or restart is the user's to read; only a failed list load clears itself.
        setFailure((previous) => previous?.projectId === projectId && previous.source === "list" ? null : previous);
      } else {
        setFailure({ projectId, message: result.error.message, source: "list" });
      }
    }).catch((cause: unknown) => {
      if (active) setFailure({ projectId, message: errorMessage(cause), source: "list" });
    });
    return () => { active = false; };
  }, [projectId, reload]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<number>(PROJECT_SERVICES_CHANGED, (event) => {
      if (event.payload === projectId) setReload((value) => value + 1);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => { /* The fetch effect already reports a failure to reach the Core. */ });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [projectId]);

  const begin = useCallback((kind: PendingKind, serviceId: number) => {
    setPending((previous) => previous.projectId === projectId && previous.kind === kind && previous.ids.includes(serviceId)
      ? previous
      : {
          projectId,
          kind,
          ids: [...(previous.projectId === projectId && previous.kind === kind ? previous.ids : []), serviceId],
        });
    setFailure(null);
  }, [projectId]);

  const finish = useCallback((kind: PendingKind, serviceId: number) => {
    setReload((value) => value + 1);
    setPending((previous) => previous.projectId === projectId && previous.kind === kind
      ? { projectId, kind, ids: previous.ids.filter((id) => id !== serviceId) }
      : previous);
  }, [projectId]);

  const stop = useCallback(async (serviceId: number) => {
    begin("stop", serviceId);
    try {
      const result = await commands.stopProjectService(serviceId);
      if (result.status === "error") setFailure({ projectId, message: result.error.message, source: "stop" });
    } catch (cause) {
      setFailure({ projectId, message: errorMessage(cause), source: "stop" });
    } finally {
      onStopService?.(serviceId);
      finish("stop", serviceId);
    }
  }, [begin, finish, onStopService, projectId]);

  const restart = useCallback(async (serviceId: number) => {
    begin("restart", serviceId);
    try {
      const result = await commands.restartProjectService(serviceId);
      if (result.status === "error") {
        setFailure({ projectId, message: result.error.message, source: "restart" });
      } else if (result.data.outcome === "conflict") {
        // The service is stopped now; App offers to switch to the incumbent or try again.
        onServiceConflict?.(result.data.payload);
      }
    } catch (cause) {
      setFailure({ projectId, message: errorMessage(cause), source: "restart" });
    } finally {
      finish("restart", serviceId);
    }
  }, [begin, finish, onServiceConflict, projectId]);

  // While a newly selected Project loads, never show the previous Project's rows.
  const services = snapshot.projectId === projectId ? snapshot.services : [];
  const pendingHere = pending.projectId === projectId ? pending : { kind: "stop" as const, ids: [] };
  return (
    <ProjectServicesList
      services={services}
      onOpenService={onOpenService}
      onStopService={(id) => void stop(id)}
      onRestartService={(id) => void restart(id)}
      pendingStopIds={pendingHere.kind === "stop" ? pendingHere.ids : []}
      pendingRestartIds={pendingHere.kind === "restart" ? pendingHere.ids : []}
      error={failure?.projectId === projectId ? failure.message : null}
    />
  );
}
