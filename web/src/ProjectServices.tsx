import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { SquareFillIcon } from "@primer/octicons-react";
import { commands, type ProjectService } from "./bindings";

/** The global refetch signal the Core emits whenever a Project's services change. */
export const PROJECT_SERVICES_CHANGED = "project-services-changed";

interface ListProps {
  services: ProjectService[];
  onOpenService: (serviceId: number) => void;
  onStopService: (serviceId: number) => void;
  pendingStopIds?: number[];
  error?: string | null;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * The pinned sidebar list. Presentational only: it renders nothing while no service runs, so an
 * idle Project spends none of its sidebar on the widget.
 */
export function ProjectServicesList({ services, onOpenService, onStopService, pendingStopIds = [], error = null }: ListProps) {
  if (services.length === 0) return null;
  return (
    <section className="project-services" aria-label="Project Services">
      <header className="project-services-header">
        <span>Services</span>
        <span className="badge project-services-count" aria-label={`${services.length} running`}>{services.length}</span>
      </header>
      {error && <p className="project-services-error" role="alert">{error}</p>}
      <ul className="project-services-list">
        {services.map((service) => {
          const pending = pendingStopIds.includes(service.id);
          return (
            <li key={service.id} className="service-item" data-pending={pending || undefined}>
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
                className="icon-btn sm service-stop"
                disabled={pending}
                aria-busy={pending}
                aria-label={`Stop ${service.command}`}
                title={pending ? `Stopping ${service.command}…` : `Stop ${service.command}`}
                onClick={() => onStopService(service.id)}
              >
                <SquareFillIcon size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface Props {
  projectId: number;
  onOpenService: (serviceId: number) => void;
  /** Notified after a stop request, so the app can react; the component still owns the command. */
  onStopService?: (serviceId: number) => void;
}

/**
 * One Project's running services, kept live. The Core's `project-services-changed` event is a lossy
 * refetch signal: every delivery (and every Project selection) reloads the whole list.
 */
export function ProjectServices({ projectId, onOpenService, onStopService }: Props) {
  const [snapshot, setSnapshot] = useState<{ projectId: number; services: ProjectService[] }>({ projectId, services: [] });
  const [pendingStop, setPendingStop] = useState<{ projectId: number; ids: number[] }>({ projectId, ids: [] });
  const [failure, setFailure] = useState<{ projectId: number; message: string; source: "list" | "stop" } | null>(null);
  // Bumped by a stop or a Core change event to refetch; the effect below owns the request.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void commands.listProjectServices(projectId).then((result) => {
      if (!active) return;
      if (result.status === "ok") {
        setSnapshot({ projectId, services: result.data ?? [] });
        // A failed stop is the user's to read; only a failed list load clears itself.
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

  const stop = useCallback(async (serviceId: number) => {
    setPendingStop((previous) => previous.projectId === projectId && previous.ids.includes(serviceId)
      ? previous : { projectId, ids: [...(previous.projectId === projectId ? previous.ids : []), serviceId] });
    setFailure(null);
    try {
      const result = await commands.stopProjectService(serviceId);
      if (result.status === "error") setFailure({ projectId, message: result.error.message, source: "stop" });
    } catch (cause) {
      setFailure({ projectId, message: errorMessage(cause), source: "stop" });
    } finally {
      onStopService?.(serviceId);
      setReload((value) => value + 1);
      setPendingStop((previous) => ({ projectId, ids: previous.ids.filter((id) => id !== serviceId) }));
    }
  }, [onStopService, projectId]);

  // While a newly selected Project loads, never show the previous Project's rows.
  const services = snapshot.projectId === projectId ? snapshot.services : [];
  return (
    <ProjectServicesList
      services={services}
      onOpenService={onOpenService}
      onStopService={(id) => void stop(id)}
      pendingStopIds={pendingStop.projectId === projectId ? pendingStop.ids : []}
      error={failure?.projectId === projectId ? failure.message : null}
    />
  );
}
