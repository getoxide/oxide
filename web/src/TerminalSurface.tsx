import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PlusIcon, ServerIcon, TerminalIcon, XIcon } from "@primer/octicons-react";
import { TerminalWorkbench } from "./TerminalWorkbench";
import { ServiceLogPanel } from "./ServiceLogPanel";
import { isMismatched, type ProjectTerminals, type ServiceTab, type TerminalCheckout, type TerminalTab } from "./terminalTabs";
import { readablePath } from "./headerLines";
import type { ProjectService, ProjectServiceConflict } from "./bindings";

interface Props {
  projectId: number;
  terminals: ProjectTerminals;
  /** The selected Thread's checkout, or `null` when none is selected. */
  checkout: TerminalCheckout | null;
  /** Whether the Terminal Surface is showing; hidden tabs keep running. */
  visible: boolean;
  queuedCommand: { id: number; command: string } | null;
  onCommandConsumed: () => void;
  onOpenTab: () => void;
  onSelectTab: (tabId: number) => void;
  onCloseTab: (tabId: number) => void;
  onRunningChange: (tabId: number, command: string | null) => void;
  /** A terminal command or a service Restart hit a port conflict; App owns the dialog. */
  onServiceConflict: (conflict: ProjectServiceConflict) => void;
}

const folderName = (path: string) => {
  const clean = readablePath(path).replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
};

const NO_CHECKOUT = "Select a Thread to open a terminal in its checkout.";

/** One Project's shells and Project Service log views. Tabs outlive Thread selection. */
export function TerminalSurface({
  projectId, terminals, checkout, visible, queuedCommand, onCommandConsumed, onOpenTab, onSelectTab, onCloseTab, onRunningChange, onServiceConflict,
}: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const [serviceInfo, setServiceInfo] = useState<Record<number, ProjectService>>({});
  const { tabs, selectedId } = terminals;

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedId, tabs.length]);

  // The mounted service panels report their freshest command, port and status, so the strip's
  // badge stays live without a second subscription per tab.
  const rememberService = useCallback((service: ProjectService) => {
    setServiceInfo((previous) => {
      const current = previous[service.id];
      if (current && current.command === service.command && current.port === service.port
        && current.url === service.url && current.status === service.status) return previous;
      return { ...previous, [service.id]: service };
    });
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === selectedId);
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -index : event.key === "End" ? tabs.length - 1 - index : null;
    if (move === null || tabs.length === 0) return;
    event.preventDefault();
    const next = tabs[(index + move + tabs.length) % tabs.length];
    onSelectTab(next.id);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus());
  }

  const selectedTab = tabs.find((tab) => tab.id === selectedId);
  return (
    <div className="terminal-surface" hidden={!visible} aria-label="Terminal tabs">
      <div className="terminal-tabbar surface-toolbar">
        <div className="terminal-tab-strip" role="tablist" aria-label="Project terminals" ref={strip} onKeyDown={onKeyDown}>
          {tabs.map((tab) => <TabButton key={tab.id} tab={tab} selected={tab.id === selectedId}
            service={tab.kind === "service" ? serviceInfo[tab.serviceId] : undefined}
            mismatched={isMismatched(tab, checkout)} onSelect={onSelectTab} onClose={onCloseTab} />)}
        </div>
        <button className="icon-btn sm" aria-label="New terminal tab" disabled={!checkout}
          title={checkout ? "New terminal in the selected Thread’s checkout" : NO_CHECKOUT} onClick={onOpenTab}>
          <PlusIcon size={14} />
        </button>
      </div>
      {!checkout && tabs.length > 0 && selectedTab?.kind !== "service" && <p className="surface-note" role="status">{NO_CHECKOUT}</p>}
      {tabs.length === 0 && (
        <section className="surface-empty">
          <TerminalIcon size={32} />
          <p className="surface-empty-title">No terminal open.</p>
          <p className="surface-empty-description">
            {checkout ? "Open a terminal in the selected Thread’s checkout." : NO_CHECKOUT}
          </p>
          <button className="btn primary" disabled={!checkout} onClick={onOpenTab}>Open terminal</button>
        </section>
      )}
      {tabs.map((tab) => (
        <div key={tab.id} className="terminal-tab-panel" role="tabpanel" aria-label={tab.kind === "service" ? `Service logs ${serviceInfo[tab.serviceId]?.command ?? tab.serviceId}` : `Terminal ${folderName(tab.rootPath)}`} hidden={tab.id !== selectedId || !visible}>
          {tab.kind === "service" ? (
            <ServiceLogPanel
              key={tab.serviceId}
              projectId={projectId}
              serviceId={tab.serviceId}
              checkout={tab}
              visible={visible && tab.id === selectedId}
              onServiceChange={rememberService}
              onServiceConflict={onServiceConflict}
            />
          ) : (
            <TerminalWorkbench
              projectId={projectId}
              threadId={tab.threadId}
              rootPath={tab.rootPath}
              contextKey={tab.key}
              visible={visible && tab.id === selectedId}
              queuedCommand={tab.id === selectedId ? queuedCommand : null}
              onCommandConsumed={onCommandConsumed}
              onRunningChange={(command) => onRunningChange(tab.id, command)}
              onServiceConflict={onServiceConflict}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function TabButton({ tab, selected, service, mismatched, onSelect, onClose }: {
  tab: TerminalTab; selected: boolean; service?: ProjectService; mismatched: boolean;
  onSelect: (id: number) => void; onClose: (id: number) => void;
}) {
  const isService = tab.kind === "service";
  const name = isService ? (service?.command ?? `Service ${(tab as ServiceTab).serviceId}`) : folderName(tab.rootPath);
  const port = isService ? service?.port ?? null : null;
  const title = isService
    ? `Service logs: ${name}${port !== null ? ` — http://localhost:${port}` : ""}${mismatched ? " — not the selected Thread’s checkout" : ""}`
    : `${tab.rootPath}${tab.running ? ` — running ${tab.running}` : ""}${mismatched ? " — not the selected Thread’s checkout" : ""}`;
  return (
    <div className={`terminal-tab${selected ? " active" : ""}${isService ? " service-tab" : ""}`} data-mismatch={mismatched || undefined}>
      <button role="tab" data-tab-id={tab.id} aria-selected={selected} tabIndex={selected ? 0 : -1} title={title} onClick={() => onSelect(tab.id)}>
        {isService && <ServerIcon size={12} className="terminal-tab-service-icon" />}
        <span className="terminal-tab-name">{name}</span>
        {port !== null && <span className="terminal-tab-port">:{port}</span>}
        {!isService && tab.running && <span className="terminal-tab-running" aria-label="Command running" />}
        {mismatched && <span className="terminal-tab-mismatch">other checkout</span>}
      </button>
      <button className="icon-btn sm" aria-label={isService ? `Close service ${name}` : `Close terminal ${name}`} title={isService ? `Close ${name} logs` : `Close terminal ${name}`} onClick={() => onClose(tab.id)}>
        <XIcon size={12} />
      </button>
    </div>
  );
}
