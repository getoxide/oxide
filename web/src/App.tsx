import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FileIcon,
  FileDirectoryIcon,
  GearIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  PlusIcon,
  RepoIcon,
  SidebarExpandIcon,
  TerminalIcon,
  XIcon,
  ChevronRightIcon,
  type Icon,
} from "@primer/octicons-react";
import { commands, type Project } from "./bindings";
import { Skeleton } from "./Skeleton";
import { ContextMenu } from "./ContextMenu";
import { Collapsible } from "./Collapsible";
import { LinkConfirmDialog } from "./LinkConfirmDialog";
import { QuitDialog } from "./QuitDialog";
import { ProjectPalette } from "./ProjectPalette";
import { SettingsView } from "./SettingsView";
import { ResizeHandle } from "./ResizeHandle";
import { workspaceLayout } from "./panelLayout";
import { useElementSize, usePanelSize } from "./usePanelSize";
import { readablePath } from "./headerLines";
import { sidebarProjects } from "./projectList";
import { runEditCommand, type EditCommand } from "./editCommand";
import { TerminalWorkbench } from "./TerminalWorkbench";
import {
  closeProjectTerminals, closeTerminal, openTerminal, renameTerminal, selectTerminal, setRunning,
  emptyTerminals, type TerminalsByProject,
} from "./terminalTabs";
import type { CodeOpenRequest } from "./codeOpen";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);
const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

const CodeWorkbench = lazy(() => import("./CodeWorkbench").then((module) => ({ default: module.CodeWorkbench })));
const FilesPanel = lazy(() => import("./FilesPanel").then((module) => ({ default: module.FilesPanel })));
const PullRequestPanel = lazy(() =>
  import("./PullRequestPanel").then((module) => ({ default: module.PullRequestPanel })),
);
const IssuesSurface = lazy(() =>
  import("./IssuesSurface").then((module) => ({ default: module.IssuesSurface })),
);

const TOOL_TABS: { name: string; Icon: Icon }[] = [
  { name: "Files", Icon: FileIcon },
  { name: "Issues", Icon: IssueOpenedIcon },
  { name: "Pull request", Icon: GitPullRequestIcon },
];

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function App() {
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTool, setActiveTool] = useState("Files");
  const [visitedTools, setVisitedTools] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [terminals, setTerminals] = useState<TerminalsByProject>({});
  const [openError, setOpenError] = useState<string | null>(null);
  const [codeRequest, setCodeRequest] = useState<(CodeOpenRequest & { projectId: number }) | null>(null);
  const [codeProjects, setCodeProjects] = useState<number[]>([]);
  const [showCode, setShowCode] = useState(false);
  const codeSequence = useRef(0);
  const overlays = useRef<WorkspaceOverlaysHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodySize = useElementSize(bodyRef, { width: window.innerWidth, height: window.innerHeight - 44 });
  const sidebarSize = usePanelSize("sidebar");
  const toolsSize = usePanelSize("tools");
  // The Project and terminal of the last session: `undefined` until read, `null` once applied.
  const restore = useRef<number | null | undefined>(undefined);

  const onProjectsScanned = useCallback((next: Project[]) => {
    setProjects((previous) => previous && previous.length === next.length && previous.every((project, index) => {
      const other = next[index];
      return project.id === other.id && project.name === other.name && project.path === other.path &&
        project.open === other.open && project.hidden === other.hidden && project.missing === other.missing;
    }) ? previous : next);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const known = await commands.listProjects();
        if (known.status === "ok") setProjects(known.data);
        else setOpenError(known.error.message);
        const scanned = await commands.rescanProjects();
        if (scanned.status === "ok") setProjects(scanned.data);
        else setOpenError(scanned.error.message);
      } catch (cause) {
        setOpenError(errorText(cause));
      }
    })();
    void commands.lastSelection().then((res) => {
      restore.current = res.status === "ok" ? res.data : null;
      const last = restore.current;
      if (last !== null && last !== undefined) setSelectedId((current) => current ?? last);
    }).catch((cause: unknown) => {
      restore.current = null;
      setOpenError(errorText(cause));
    });
  }, []);

  // Derived, so it always reflects the latest list and disappears when the Project is hidden.
  const selected = projects?.find((project) => project.id === selectedId && !project.hidden) ?? null;
  const projectTerminals = selected ? terminals[selected.id] ?? emptyTerminals : emptyTerminals;

  // Remember the Project the user is looking at, once the last session has been restored.
  useEffect(() => {
    if (!selected || restore.current === undefined) return;
    if (restore.current !== null && restore.current !== selected.id) return;
    restore.current = null;
    void commands.rememberSelection(selected.id);
  }, [selected]);

  const layout = workspaceLayout(bodySize.width, {
    sidebar: sidebarSize.preferred, tools: toolsSize.preferred,
  }, showTools && !showSettings, { sidebarVisible: showSidebar, priority: "tools", maximized: false });
  const dockVisible = layout.toolsVisible;

  const selectProject = useCallback((project: Project) => {
    restore.current = null;
    setShowSettings(false);
    setShowCode(false);
    setSelectedId(project.id);
    void commands.rememberSelection(project.id);
  }, []);

  const openProject = useCallback((project: Project) => {
    setProjects((previous) => [{ ...project, open: true, hidden: false }, ...(previous?.filter((p) => p.id !== project.id) ?? [])]);
    selectProject(project);
  }, [selectProject]);

  const newTerminal = useCallback((project: Project) => {
    setShowSettings(false);
    setShowCode(false);
    setSelectedId(project.id);
    setTerminals((previous) => openTerminal(previous, project.id));
  }, []);

  const closeProject = useCallback(async (projectId: number): Promise<string | null> => {
    const closed = await commands.setProjectOpen(projectId, false);
    if (closed.status === "error") return closed.error.message;
    // Core ended the Project's terminals; dropping their state unmounts their views.
    setTerminals((previous) => closeProjectTerminals(previous, projectId));
    setCodeProjects((previous) => previous.filter((id) => id !== projectId));
    const listed = await commands.listProjects();
    const updated = listed.status === "ok"
      ? listed.data
      : (projects ?? []).map((project) => project.id === projectId ? { ...project, open: false } : project);
    setProjects(updated);
    if (selectedId === projectId) {
      restore.current = null;
      setShowCode(false);
      setSelectedId(sidebarProjects(updated).find((project) => project.id !== projectId)?.id ?? null);
    }
    return listed.status === "error" ? listed.error.message : null;
  }, [projects, selectedId]);

  const openCodeFile = (path: string) => {
    if (!selected) return;
    setCodeRequest({ id: ++codeSequence.current, path, projectId: selected.id });
    setCodeProjects((previous) => previous.includes(selected.id) ? previous : [...previous, selected.id]);
    setShowCode(true);
    setShowSettings(false);
  };

  const selectTool = (name: string) => {
    setActiveTool(name);
    setVisitedTools((previous) => selected ? { ...previous, [`${selected.id}:${name}`]: true } : previous);
    setShowTools(true);
    setShowSettings(false);
  };
  if (dockVisible && selected && !visitedTools[`${selected.id}:${activeTool}`]) {
    setVisitedTools({ ...visitedTools, [`${selected.id}:${activeTool}`]: true });
  }

  const revealProject = async () => {
    if (!selected) return;
    const result = await commands.revealInFinder(selected.id);
    setOpenError(result.status === "error" ? result.error.message : null);
  };

  const centreHidden = showSettings;
  const projectsWithTerminals = Object.entries(terminals).filter(([, state]) => state.tabs.length > 0);

  return (
    <div className={`window ${isMac ? "macos" : "windows"}`}>
      {isWindows && <WindowResizeHandles />}
      <ContextMenu actions={{
        openProject: () => overlays.current?.openPalette(),
        openSettings: () => setShowSettings(true),
      }} />
      <QuitDialog />
      <LinkConfirmDialog />
      <WorkspaceOverlays ref={overlays} projects={projects ?? []} onProjectsScanned={onProjectsScanned} onOpenProject={openProject} />
      <header className="header" data-tauri-drag-region>
        {isWindows && <AppMenu />}
        {!layout.sidebarVisible && (
          <button className="icon-btn" aria-label="Show sidebar" title="Show sidebar" onClick={() => setShowSidebar(true)}>
            <RepoIcon size={16} />
          </button>
        )}
        <div className="header-project" data-tauri-drag-region>
          {selected ? (
            <span className="title project-label" data-tauri-drag-region title={`Project: ${readablePath(selected.path)}`}>
              <RepoIcon size={13} />
              <strong>{selected.name}</strong>
              {selected.missing && <span className="badge">missing</span>}
            </span>
          ) : !isWindows ? (
            <span className="title" data-tauri-drag-region><strong>Oxide</strong></span>
          ) : null}
        </div>
        {!isWindows && <span className="grow" data-tauri-drag-region />}
        <div className="header-actions" data-tauri-drag-region>
          {openError && <span className="error header-error" role="alert">{openError}</span>}
          {selected && !selected.missing && (
            <button className="icon-btn" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void revealProject()}>
              <FileDirectoryIcon size={16} />
            </button>
          )}
          <button
            className="icon-btn"
            aria-pressed={dockVisible}
            title="Files, Issues and Pull request"
            aria-label="Toggle tools panel"
            onClick={() => { setShowTools(!dockVisible); setShowSettings(false); }}
          >
            <SidebarExpandIcon size={16} />
          </button>
          {isWindows && <WindowControls />}
        </div>
      </header>
      <div className="body" ref={bodyRef} style={{
        "--sidebar-width": `${layout.sidebar.value}px`,
        "--tools-width": `${layout.tools.value}px`,
      } as CSSProperties}>
        <div className="sidebar-region" id="workspace-sidebar" hidden={!layout.sidebarVisible}>
          <Sidebar
            projects={projects}
            selected={selected}
            terminals={terminals}
            settingsOpen={showSettings}
            onSelectProject={selectProject}
            onCloseProject={closeProject}
            onNewTerminal={newTerminal}
            onSelectTerminal={(project, tabId) => {
              setShowSettings(false);
              setShowCode(false);
              setSelectedId(project.id);
              setTerminals((previous) => selectTerminal(previous, project.id, tabId));
            }}
            onRenameTerminal={(project, tabId, name) => setTerminals((previous) => renameTerminal(previous, project.id, tabId, name))}
            onCloseTerminal={(project, tabId) => setTerminals((previous) => closeTerminal(previous, project.id, tabId))}
            onOpenPalette={() => overlays.current?.openPalette()}
            onOpenSettings={() => setShowSettings(true)}
          />
          <ResizeHandle label="Resize sidebar" controls="workspace-sidebar" axis="x" edge="end"
            {...layout.sidebar} onResize={sidebarSize.resize} onCommit={sidebarSize.commit} onReset={sidebarSize.reset} onCancel={sidebarSize.cancel} />
        </div>
        <div className="centre-column">
          {showSettings && <SettingsView onClose={() => setShowSettings(false)} />}
          <div className="chat-workbench" hidden={centreHidden}>
            {selected && showCode && codeProjects.includes(selected.id) && (
              <button className="btn centre-back" onClick={() => setShowCode(false)}>
                <TerminalIcon size={14} /> Back to terminals
              </button>
            )}
            {/* Every terminal stays mounted while hidden, so scrollback and running processes survive switching. */}
            {projectsWithTerminals.map(([id, state]) => state.tabs.map((tab) => {
              const projectId = Number(id);
              const project = projects?.find((candidate) => candidate.id === projectId);
              if (!project) return null;
              const visible = !centreHidden && !showCode && projectId === selected?.id && tab.id === state.selectedId;
              return (
                <main key={`${projectId}:${tab.id}`} className="centre terminal-tab-panel" aria-label={`Terminal ${tab.name}`} hidden={!visible}>
                  <TerminalWorkbench
                    projectId={projectId}
                    rootPath={project.path}
                    contextKey={`${projectId}:${tab.id}`}
                    visible={visible}
                    onRunningChange={(command) => setTerminals((previous) => setRunning(previous, projectId, tab.id, command))}
                  />
                </main>
              );
            }))}
            {codeProjects.map((projectId) => {
              const project = projects?.find((candidate) => candidate.id === projectId);
              if (!project) return null;
              return (
                <Suspense key={projectId} fallback={showCode && projectId === selected?.id ? <Skeleton kind="code" label="Loading Code…" /> : null}>
                  <CodeWorkbench
                    projectId={projectId}
                    rootPath={project.path}
                    contextKey={`${projectId}:main`}
                    visible={!centreHidden && showCode && projectId === selected?.id}
                    showExplorer={false}
                    onChanged={() => {}}
                    openRequest={codeRequest?.projectId === projectId ? codeRequest : null}
                  />
                </Suspense>
              );
            })}
            {!selected && (
              <main className="centre empty-thread" aria-label="Terminal">
                <div className="empty-state">
                  <RepoIcon size={24} />
                  <p>Open a Project to begin.</p>
                  <button className="btn primary" onClick={() => overlays.current?.openPalette()}>Open a Project</button>
                </div>
              </main>
            )}
            {selected && projectTerminals.tabs.length === 0 && !showCode && (
              <main className="centre empty-thread" aria-label="No terminal">
                <div className="empty-state">
                  <TerminalIcon size={24} />
                  <p>No terminal open in {selected.name}.</p>
                  <button className="btn primary" disabled={selected.missing} onClick={() => newTerminal(selected)}>
                    <PlusIcon size={14} /> New terminal
                  </button>
                </div>
              </main>
            )}
          </div>
        </div>
        <aside className="tools" aria-label="Tools panel" id="workspace-tools" hidden={!dockVisible}>
          <ResizeHandle label="Resize Tools" controls="workspace-tools" axis="x" edge="start" direction={-1}
            {...layout.tools} onResize={toolsSize.resize} onCommit={toolsSize.commit} onReset={toolsSize.reset} onCancel={toolsSize.cancel} />
          <nav className="tabs tools-tabs" role="tablist" aria-label="Surfaces">
            <div className="tools-tab-strip" role="presentation">
              {TOOL_TABS.map(({ name, Icon }) => (
                <button key={name} role="tab" className="tab" aria-label={name} title={name}
                  aria-selected={activeTool === name} tabIndex={activeTool === name ? 0 : -1}
                  onClick={() => selectTool(name)}>
                  <Icon size={14} /> <span className="tool-tab-label">{name}</span>
                </button>
              ))}
            </div>
            <div className="tools-tab-actions">
              <button className="icon-btn sm" title="Close panel" aria-label="Close tools panel" onClick={() => setShowTools(false)}>
                <XIcon size={14} />
              </button>
            </div>
          </nav>
          {selected && visitedTools[`${selected.id}:Pull request`] && (
            <div className="surface-content" hidden={activeTool !== "Pull request"}>
              <Suspense fallback={<Skeleton kind="list" label="Loading pull requests…" />}>
                <PullRequestPanel projectId={selected.id} refreshKey={0} onChanged={() => {}} />
              </Suspense>
            </div>
          )}
          {selected && visitedTools[`${selected.id}:Files`] && (
            <div className="surface-content" hidden={activeTool !== "Files"}>
              <Suspense fallback={dockVisible && activeTool === "Files" ? <Skeleton kind="tree" label="Loading files…" /> : null}>
                <FilesPanel key={selected.id} projectId={selected.id} revision={0} onOpenFile={openCodeFile} />
              </Suspense>
            </div>
          )}
          {selected && visitedTools[`${selected.id}:Issues`] && (
            <div className="surface-content" hidden={activeTool !== "Issues"}>
              <Suspense fallback={<Skeleton kind="list" label="Loading issues…" />}>
                <IssuesSurface projectId={selected.id} />
              </Suspense>
            </div>
          )}
          {!selected && (
            <section className="surface-empty">
              <RepoIcon size={32} />
              <p className="surface-empty-title">Open a Project to use its tools.</p>
              <p className="surface-empty-description">The right dock holds Files, Issues and Pull request for the selected Project.</p>
              <button className="btn primary" onClick={() => overlays.current?.openPalette()}>Open a Project</button>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

interface SidebarProps {
  projects: Project[] | null;
  selected: Project | null;
  terminals: TerminalsByProject;
  settingsOpen: boolean;
  onSelectProject: (project: Project) => void;
  onCloseProject: (projectId: number) => Promise<string | null>;
  onNewTerminal: (project: Project) => void;
  onSelectTerminal: (project: Project, tabId: number) => void;
  onRenameTerminal: (project: Project, tabId: number, name: string) => void;
  onCloseTerminal: (project: Project, tabId: number) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}

/** The open Projects and, under each, its terminals. Nothing else lives here. */
function Sidebar({
  projects, selected, terminals, settingsOpen, onSelectProject, onCloseProject, onNewTerminal,
  onSelectTerminal, onRenameTerminal, onCloseTerminal, onOpenPalette, onOpenSettings,
}: SidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const [closingProjectId, setClosingProjectId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [editing, setEditing] = useState<{ projectId: number; tabId: number } | null>(null);
  const [renameText, setRenameText] = useState("");

  const close = async (project: Project) => {
    if (closingProjectId !== null) return;
    setClosingProjectId(project.id);
    try {
      setError(await onCloseProject(project.id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setClosingProjectId(null);
    }
  };

  // The selected Project always shows, even before the Core has marked it open.
  const listed = sidebarProjects(projects ?? []);
  const shown = selected && !listed.some((project) => project.id === selected.id) ? [selected, ...listed] : listed;

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-actions">
        <button className="btn grow" onClick={onOpenPalette} aria-label="Open a Project" title="Open a Project">
          <RepoIcon size={14} /> Open a Project
        </button>
      </div>
      {error && <p className="error sidebar-note">{error}</p>}
      <div className="sidebar-scroll">
        {projects && shown.length === 0 && (
          <div className="sidebar-empty">
            <RepoIcon className="sidebar-empty-icon" size={18} />
            <div className="sidebar-empty-copy">
              <p className="sidebar-empty-title">No open Projects</p>
              <p className="sidebar-empty-hint">Open a Project to see its terminals here.</p>
            </div>
          </div>
        )}
        <ul className="project-list">
          {shown.map((project) => {
            const state = terminals[project.id] ?? emptyTerminals;
            const isSelected = project.id === selected?.id;
            const expanded = !collapsed.includes(project.id);
            return (
              <li key={project.id} className={`project-node${project.missing ? " missing" : ""}`}>
                <div className="project-row">
                  <button
                    className="project"
                    aria-current={isSelected}
                    aria-expanded={expanded}
                    title={readablePath(project.path)}
                    onClick={(event) => {
                      const onChevron = Boolean((event.target as HTMLElement).closest(".disclosure-chev"));
                      if (expanded && (isSelected || onChevron)) {
                        setCollapsed((previous) => [...previous, project.id]);
                        return;
                      }
                      setCollapsed((previous) => previous.filter((id) => id !== project.id));
                      onSelectProject(project);
                    }}
                  >
                    <ChevronRightIcon size={12} className="disclosure-chev" />
                    <RepoIcon size={13} />
                    <span className="project-name">{project.name}</span>
                    {project.missing && <span className="badge">missing</span>}
                  </button>
                  <button className="row-action" disabled={project.missing} aria-label={`New terminal in ${project.name}`}
                    title="New terminal" onClick={() => { setCollapsed((previous) => previous.filter((id) => id !== project.id)); onNewTerminal(project); }}>
                    <PlusIcon size={13} />
                  </button>
                  <button className="row-action" onClick={() => void close(project)} disabled={closingProjectId === project.id}
                    aria-busy={closingProjectId === project.id} aria-label={`Close ${project.name}`}
                    title={closingProjectId === project.id ? "Closing Project…" : "Close Project and its terminals"}>
                    <XIcon size={13} />
                  </button>
                </div>
                <Collapsible open={expanded}>
                  <ul className="thread-list" aria-label={`Terminals of ${project.name}`}>
                    {state.tabs.length === 0 && <li className="sidebar-note">No terminals</li>}
                    {state.tabs.map((tab) => (
                      <li key={tab.id} className="thread-row">
                        {editing?.projectId === project.id && editing.tabId === tab.id ? (
                          <input
                            className="thread-rename-input"
                            value={renameText}
                            autoFocus
                            aria-label={`Rename ${tab.name}`}
                            onChange={(event) => setRenameText(event.target.value)}
                            onBlur={() => { setEditing(null); onRenameTerminal(project, tab.id, renameText); }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") { setEditing(null); onRenameTerminal(project, tab.id, renameText); }
                              if (event.key === "Escape") setEditing(null);
                            }}
                          />
                        ) : (
                          <button
                            className="thread-item"
                            aria-current={!settingsOpen && isSelected && tab.id === state.selectedId}
                            title={`${tab.name}${tab.running ? ` — running ${tab.running}` : ""}. Double-click to rename.`}
                            onClick={() => onSelectTerminal(project, tab.id)}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              setEditing({ projectId: project.id, tabId: tab.id });
                              setRenameText(tab.name);
                            }}
                          >
                            <TerminalIcon size={12} />
                            <span className="thread-item-title">{tab.name}</span>
                            {tab.running && <span className="terminal-tab-running" aria-label="Command running" />}
                          </button>
                        )}
                        <button className="row-action" onClick={() => onCloseTerminal(project, tab.id)}
                          aria-label={`Close ${tab.name}`} title="Close terminal">
                          <XIcon size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      </div>
      <button className="sidebar-footer" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings} title="Settings">
        <GearIcon size={14} /> Settings
      </button>
    </nav>
  );
}

function AppMenu() {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open]);
  const win = getCurrentWindow();
  const menus: Record<string, { label: string; action: () => void }[]> = {
    Oxide: [{ label: "Quit Oxide", action: () => { void win.close(); } }],
    Edit: ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"].map((label) => ({ label, action: () => {
      const command = (label === "Select All" ? "selectAll" : label.toLowerCase()) as EditCommand;
      runEditCommand(command);
    } })),
    Window: [{ label: "Minimize", action: () => { void win.minimize(); } }, { label: "Maximize / Restore", action: () => { void win.toggleMaximize(); } }],
  };
  return <nav ref={root} className="app-menu" aria-label="Application menu">
    {Object.entries(menus).map(([name, items]) => <div className="app-menu-item" key={name}>
      <button type="button" aria-haspopup="menu" aria-expanded={open === name} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => { if (open) setOpen(name); }} onClick={() => setOpen(open === name ? null : name)}>{name}</button>
      {open === name && <div className="app-menu-popup" role="menu">
        {items.map(({ label, action }) => <button key={label} role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { action(); setOpen(null); }}>{label}</button>)}
      </div>}
    </div>)}
  </nav>;
}

/** Whether the window fills the screen; tracked so edge handles can stand aside and the glyph can match. */
function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const sync = () => { void win.isMaximized().then((value) => { if (active) setMaximized(value); }).catch(() => {}); };
    sync();
    void win.onResized(sync).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    return () => { active = false; unlisten?.(); };
  }, []);
  return maximized;
}

/** Caption buttons drawn like Windows' own: Segoe glyphs, 46px wide, flush with the window's top-right corner. */
function WindowControls() {
  const window = getCurrentWindow();
  const maximized = useWindowMaximized();
  return <div className="window-controls" role="group" aria-label="Window controls">
    <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void window.minimize()}>{""}</button>
    <button type="button" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onClick={() => void window.toggleMaximize()}>{maximized ? "" : ""}</button>
    <button type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => void window.close()}>{""}</button>
  </div>;
}

function WindowResizeHandles() {
  const maximized = useWindowMaximized();
  // A maximized window cannot be resized, and the handles would cover the Close button's corner.
  if (maximized) return null;
  const directions = ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"] as const;
  return <div className="window-resize-handles" aria-hidden="true">
    {directions.map((direction) => <div key={direction} className={`window-resize window-resize-${direction.toLowerCase()}`}
      onMouseDown={(event) => { if (event.button === 0) void getCurrentWindow().startResizeDragging(direction); }} />)}
  </div>;
}

type WorkspaceOverlaysHandle = {
  openPalette: () => void;
};

function WorkspaceOverlays({ ref, projects, onProjectsScanned, onOpenProject }: {
  ref: Ref<WorkspaceOverlaysHandle>;
  projects: Project[];
  onProjectsScanned: (projects: Project[]) => void;
  onOpenProject: (project: Project) => void;
}) {
  const [showPalette, setShowPalette] = useState(false);
  const invoker = useRef<HTMLElement | null>(null);

  const restoreFocus = () => {
    if (invoker.current && invoker.current.isConnected) invoker.current.focus();
    else document.querySelector<HTMLElement>('#workspace-sidebar .thread-item, #workspace-sidebar input')?.focus();
  };

  useImperativeHandle(ref, () => ({
    openPalette: () => {
      invoker.current = document.activeElement as HTMLElement | null;
      setShowPalette(true);
    },
  }), []);

  useEffect(() => {
    if (!showPalette) return;
    let active = true;
    void commands.rescanProjects().then((result) => {
      if (active && result.status === "ok") onProjectsScanned(result.data);
    });
    return () => { active = false; };
  }, [showPalette, onProjectsScanned]);

  return <>
    {showPalette && <ProjectPalette projects={projects} defaultParent="~/Developer"
      onClose={() => { setShowPalette(false); restoreFocus(); }}
      onPickProject={onOpenProject} onOpenProject={onOpenProject} />}
  </>;
}
