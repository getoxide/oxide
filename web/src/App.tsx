import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type Ref } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeftIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
  FileDirectoryIcon,
  GearIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  PlusIcon,
  RepoIcon,
  SidebarExpandIcon,
  TerminalIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import { commands, type Project } from "./bindings";
import { Skeleton } from "./shared/Skeleton";
import { ContextMenu, showContextMenu } from "./shared/ContextMenu";
import { copyTextToClipboard, currentPlatform, revealInFileManagerLabel } from "./shared/platform";
import { Collapsible } from "./shared/Collapsible";
import { LinkConfirmDialog } from "./shared/LinkConfirmDialog";
import { QuitDialog } from "./shared/QuitDialog";
import { ProjectPalette } from "./projects/ProjectPalette";
import { SettingsView } from "./settings/SettingsView";
import { ResizeHandle } from "./shared/ResizeHandle";
import { readJson, storageKeys, writeJson } from "./shared/storage";
import { workspaceLayout } from "./shared/panelLayout";
import { preloadGithub } from "./shared/githubQueries";
import {
  NARROW_CENTRE, centreSplit, forgetLayout, layoutOf, maximizeHalf, parseLayouts, restoreSplit, setDivider, shownHalf, splitMode, visibleMode,
  type Half, type ProjectLayouts,
} from "./shared/splitLayout";
import { useElementSize, usePanelSize } from "./shared/usePanelSize";
import { readablePath } from "./terminal/headerLines";
import { sidebarProjects } from "./projects/projectList";
import { runEditCommand, type EditCommand } from "./terminal/editCommand";
import { TerminalWorkbench } from "./terminal/TerminalWorkbench";
import { TerminalRow } from "./terminal/TerminalRow";
import {
  closeProjectTerminals, closeTerminal, openTerminal, renameTerminal, selectTerminal, setRunning, terminalTitle,
  emptyTerminals, type TerminalsByProject,
} from "./terminal/terminalTabs";
import type { CodeOpenRequest } from "./editor/codeOpen";
import { forgetTerminalSession, readSession, writeSession } from "./shared/session";
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  isTerminalFocused,
  loadShortcutOverrides,
  matchesShortcut,
  shouldDispatchShortcut,
  titleWithShortcut,
  useShortcuts,
  type ResolvedShortcuts,
  type ShortcutActionId,
} from "./shared/shortcuts";

const platform = currentPlatform();
const isMac = platform === "macos";
const isWindows = platform === "windows";

const CodeWorkbench = lazy(() => import("./editor/CodeWorkbench").then((module) => ({ default: module.CodeWorkbench })));
const FilesPanel = lazy(() => import("./editor/FilesPanel").then((module) => ({ default: module.FilesPanel })));
const PullRequestPanel = lazy(() =>
  import("./pull-requests/PullRequestPanel").then((module) => ({ default: module.PullRequestPanel })),
);
const IssuesSurface = lazy(() =>
  import("./issues/IssuesSurface").then((module) => ({ default: module.IssuesSurface })),
);

const TOOL_TABS: { name: string; Icon: Icon }[] = [
  { name: "Issues", Icon: IssueOpenedIcon },
  { name: "Pull request", Icon: GitPullRequestIcon },
];

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function App() {
  const [showSidebar, setShowSidebar] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTool, setActiveTool] = useState("Issues");
  const [visitedTools, setVisitedTools] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // With session restore on, the Terminals, Code workspaces and halves of the last session.
  const [session] = useState(readSession);
  const [terminals, setTerminals] = useState<TerminalsByProject>(() => session?.terminals ?? {});
  const [openError, setOpenError] = useState<string | null>(null);
  const [codeRequest, setCodeRequest] = useState<(CodeOpenRequest & { projectId: number }) | null>(null);
  // A restored Code workspace reopens its own files and then reports them, which shows the Code half.
  const [codeProjects, setCodeProjects] = useState<number[]>(() => session?.code ?? []);
  // Projects whose Code half is open; a Project's Code workspace stays mounted either way.
  const [codeShown, setCodeShown] = useState<Record<number, boolean>>({});
  const filesSeen = useRef(new Set<number>());
  // The Project whose Files view the sidebar shows; `null` is the Terminals view. Not persisted.
  const [filesProjectId, setFilesProjectId] = useState<number | null>(null);
  const codeSequence = useRef(0);
  const overlays = useRef<WorkspaceOverlaysHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodySize = useElementSize(bodyRef, { width: window.innerWidth, height: window.innerHeight - 44 });
  const sidebarSize = usePanelSize("sidebar");
  const toolsSize = usePanelSize("tools");
  // Divider and maximized half per Project, kept in the webview like the other panel sizes.
  const [layouts, setLayouts] = useState<ProjectLayouts>(() => parseLayouts(readJson(storageKeys.splitLayouts)));
  const [dragDivider, setDragDivider] = useState<number | null>(null);
  useEffect(() => { writeJson(storageKeys.splitLayouts, layouts); }, [layouts]);
  // The half each Project chose last (Code after opening a file, Terminal after choosing a Terminal).
  const [lastHalf, setLastHalf] = useState<Record<number, Half>>(() => session?.lastHalf ?? {});
  const chooseHalf = useCallback((projectId: number, half: Half) => {
    setLastHalf((previous) => previous[projectId] === half ? previous : { ...previous, [projectId]: half });
  }, []);
  const centreRef = useRef<HTMLDivElement>(null);
  const codeHalfRef = useRef<HTMLDivElement>(null);
  // Opening a file moves focus into the Code half, after it has been shown.
  useEffect(() => { if (codeRequest) codeHalfRef.current?.focus(); }, [codeRequest]);
  const centreSize = useElementSize(centreRef, { width: window.innerWidth, height: window.innerHeight - 44 });
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

  // Warm the selected Project's GitHub Surfaces in the background, on launch and on every switch.
  // A missing folder has no repository to ask about.
  const preloadId = selected && !selected.missing ? selected.id : null;
  useEffect(() => {
    if (preloadId !== null) void preloadGithub(preloadId);
  }, [preloadId]);

  const layout = workspaceLayout(bodySize.width, {
    sidebar: sidebarSize.preferred, tools: toolsSize.preferred,
  }, showTools && !showSettings, { sidebarVisible: showSidebar, priority: "tools", maximized: false });
  const dockVisible = layout.toolsVisible;

  const selectProject = useCallback((project: Project) => {
    restore.current = null;
    setShowSettings(false);
    setFilesProjectId(null);
    setSelectedId(project.id);
    void commands.rememberSelection(project.id);
  }, []);

  const openFiles = useCallback((project: Project) => {
    restore.current = null;
    setShowSettings(false);
    setSelectedId(project.id);
    setFilesProjectId(project.id);
    void commands.rememberSelection(project.id);
  }, []);

  const openProject = useCallback((project: Project) => {
    setProjects((previous) => [{ ...project, open: true, hidden: false }, ...(previous?.filter((p) => p.id !== project.id) ?? [])]);
    selectProject(project);
  }, [selectProject]);

  const newTerminal = useCallback((project: Project) => {
    setLayouts((previous) => restoreSplit(previous, project.id));
    chooseHalf(project.id, "terminal");
    setShowSettings(false);
    setFilesProjectId(null);
    setSelectedId(project.id);
    setTerminals((previous) => openTerminal(previous, project.id));
  }, [chooseHalf]);

  const closeProject = useCallback(async (projectId: number): Promise<string | null> => {
    const closed = await commands.setProjectOpen(projectId, false);
    if (closed.status === "error") return closed.error.message;
    // Core ended the Project's terminals; dropping their state unmounts their views.
    for (const tab of terminals[projectId]?.tabs ?? []) forgetTerminalSession(`${projectId}:${tab.id}`);
    setTerminals((previous) => closeProjectTerminals(previous, projectId));
    setCodeProjects((previous) => previous.filter((id) => id !== projectId));
    setCodeShown((previous) => ({ ...previous, [projectId]: false }));
    filesSeen.current.delete(projectId);
    setFilesProjectId((previous) => previous === projectId ? null : previous);
    setLayouts((previous) => forgetLayout(previous, projectId));
    const listed = await commands.listProjects();
    const updated = listed.status === "ok"
      ? listed.data
      : (projects ?? []).map((project) => project.id === projectId ? { ...project, open: false } : project);
    setProjects(updated);
    if (selectedId === projectId) {
      restore.current = null;
      setSelectedId(sidebarProjects(updated).find((project) => project.id !== projectId)?.id ?? null);
    }
    return listed.status === "error" ? listed.error.message : null;
  }, [projects, selectedId, terminals]);

  // Saved on every change for the next launch; a Code workspace not yet reported counts as open.
  useEffect(() => {
    writeSession({ terminals, code: codeProjects.filter((id) => codeShown[id] !== false), lastHalf });
  }, [terminals, codeProjects, codeShown, lastHalf]);

  const openCodeFile = (path: string) => {
    if (!selected) return;
    setCodeRequest({ id: ++codeSequence.current, path, projectId: selected.id });
    setCodeProjects((previous) => previous.includes(selected.id) ? previous : [...previous, selected.id]);
    setCodeShown((previous) => ({ ...previous, [selected.id]: true }));
    setLayouts((previous) => restoreSplit(previous, selected.id));
    chooseHalf(selected.id, "code");
    setShowSettings(false);
  };

  // The Code workspace tells the centre whether it has files open. Its first report, before the
  // requested file has loaded, says "none": that must not close the half it was just asked to open.
  const reportOpenFiles = useCallback((projectId: number, open: boolean) => {
    if (open) filesSeen.current.add(projectId);
    else if (!filesSeen.current.delete(projectId)) return;
    setCodeShown((previous) => previous[projectId] === open ? previous : { ...previous, [projectId]: open });
  }, []);

  // A file that could not be opened must not leave an empty Code half, unless other files are open.
  const failOpenFile = useCallback((projectId: number) => {
    if (filesSeen.current.has(projectId)) return;
    setCodeShown((previous) => previous[projectId] === false ? previous : { ...previous, [projectId]: false });
  }, []);

  const selectTool = (name: string) => {
    setActiveTool(name);
    setVisitedTools((previous) => selected ? { ...previous, [`${selected.id}:${name}`]: true } : previous);
    setShowTools(true);
    setShowSettings(false);
  };
  if (dockVisible && selected && !visitedTools[`${selected.id}:${activeTool}`]) {
    setVisitedTools({ ...visitedTools, [`${selected.id}:${activeTool}`]: true });
  }

  const revealProject = async (projectId: number) => {
    const result = await commands.revealInFinder(projectId);
    setOpenError(result.status === "error" ? result.error.message : null);
  };

  const centreHidden = showSettings;
  const shortcuts = useShortcuts();
  const hasTerminals = projectTerminals.tabs.length > 0;
  const projectLayout = layoutOf(layouts, selected?.id ?? -1);
  const bothHalves = splitMode({ terminals: hasTerminals, code: selected !== null && codeShown[selected.id] === true });
  const narrow = centreSize.width < NARROW_CENTRE;
  const forced = shownHalf(centreSize.width, projectLayout.maximized, lastHalf[selected?.id ?? -1] ?? "terminal");
  const mode = visibleMode(bothHalves, forced);
  const split = centreSplit(centreSize.width, dragDivider ?? projectLayout.divider);
  const halfButton = (half: Half) => {
    if (!selected || bothHalves !== "split" || mode !== "split" && mode !== half) return null;
    if (narrow && projectLayout.maximized === null) return null;
    const maximized = projectLayout.maximized === half;
    const name = half === "terminal" ? "Terminal" : "Code";
    const text = maximized ? "Restore Terminal and Code" : `Maximize ${name}`;
    const projectId = selected.id;
    return (
      <button className="icon-btn sm half-toggle" aria-label={text} title={titleWithShortcut(text, shortcuts.toggleMaximizeHalf)}
        onClick={() => setLayouts((previous) => maximized ? restoreSplit(previous, projectId) : maximizeHalf(previous, projectId, half))}>
        {maximized ? <ScreenNormalIcon size={14} /> : <ScreenFullIcon size={14} />}
      </button>
    );
  };
  const projectsWithTerminals = Object.entries(terminals).filter(([, state]) => state.tabs.length > 0);

  const shortcutHandlers = useRef<() => Partial<Record<ShortcutActionId, () => void>>>(() => ({}));
  useLayoutEffect(() => {
    shortcutHandlers.current = () => ({
      openSettings: () => setShowSettings((previous) => !previous),
      openProjectPalette: () => overlays.current?.openPalette(),
      toggleSidebar: () => setShowSidebar((previous) => !previous),
      toggleTools: () => setShowTools((previous) => {
        const next = !previous;
        if (next) setShowSettings(false);
        return next;
      }),
      newTerminal: () => {
        if (selected && !selected.missing) newTerminal(selected);
      },
      closeTerminal: () => {
        if (!selected || projectTerminals.selectedId === null) return;
        const tabId = projectTerminals.selectedId;
        forgetTerminalSession(`${selected.id}:${tabId}`);
        setTerminals((previous) => closeTerminal(previous, selected.id, tabId));
      },
      previousTerminal: () => {
        if (!selected || projectTerminals.tabs.length < 2 || projectTerminals.selectedId === null) return;
        const index = projectTerminals.tabs.findIndex((tab) => tab.id === projectTerminals.selectedId);
        const nextIndex = (index - 1 + projectTerminals.tabs.length) % projectTerminals.tabs.length;
        const tab = projectTerminals.tabs[nextIndex];
        setShowSettings(false);
        setFilesProjectId(null);
        setLayouts((previous) => restoreSplit(previous, selected.id));
        chooseHalf(selected.id, "terminal");
        setTerminals((previous) => selectTerminal(previous, selected.id, tab.id));
      },
      nextTerminal: () => {
        if (!selected || projectTerminals.tabs.length < 2 || projectTerminals.selectedId === null) return;
        const index = projectTerminals.tabs.findIndex((tab) => tab.id === projectTerminals.selectedId);
        const nextIndex = (index + 1) % projectTerminals.tabs.length;
        const tab = projectTerminals.tabs[nextIndex];
        setShowSettings(false);
        setFilesProjectId(null);
        setLayouts((previous) => restoreSplit(previous, selected.id));
        chooseHalf(selected.id, "terminal");
        setTerminals((previous) => selectTerminal(previous, selected.id, tab.id));
      },
      openFiles: () => {
        if (!selected || selected.missing) return;
        setShowSidebar(true);
        openFiles(selected);
      },
      openIssues: () => selectTool("Issues"),
      openPullRequests: () => selectTool("Pull request"),
      toggleMaximizeHalf: () => {
        if (!selected || bothHalves !== "split") return;
        const activeHalf = lastHalf[selected.id] ?? "terminal";
        setLayouts((previous) =>
          projectLayout.maximized !== null ? restoreSplit(previous, selected.id) : maximizeHalf(previous, selected.id, activeHalf),
        );
      },
    });
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest('[data-shortcut-recording="true"]')) return;

      const overrides = loadShortcutOverrides();
      const isTerminal = isTerminalFocused(event.target);
      const handlers = shortcutHandlers.current();

      for (const actionId of Object.keys(handlers) as ShortcutActionId[]) {
        const binding = shortcuts[actionId];
        if (!binding || !matchesShortcut(event, binding)) continue;
        const isExplicitOverride =
          Object.prototype.hasOwnProperty.call(overrides, actionId) &&
          overrides[actionId] !== DEFAULT_SHORTCUTS[actionId];
        if (!shouldDispatchShortcut(event, { isTerminal, isExplicitOverride })) return;
        event.preventDefault();
        event.stopPropagation();
        handlers[actionId]?.();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcuts]);

  return (
    <div className={`window ${isMac ? "macos" : isWindows ? "windows" : "linux"}`}>
      {isWindows && <WindowResizeHandles />}
      <ContextMenu actions={{
        openProject: () => overlays.current?.openPalette(),
        newTerminal: selected && !selected.missing ? () => newTerminal(selected) : undefined,
        openSettings: () => setShowSettings(true),
      }} />
      <QuitDialog />
      <LinkConfirmDialog />
      <WorkspaceOverlays ref={overlays} projects={projects ?? []} onProjectsScanned={onProjectsScanned} onOpenProject={openProject} />
      <header className="header" data-tauri-drag-region>
        {isWindows && <AppMenu />}
        {!layout.sidebarVisible && (
          <button className="icon-btn" aria-label="Show sidebar" title={titleWithShortcut("Show sidebar", shortcuts.toggleSidebar)} onClick={() => setShowSidebar(true)}>
            <RepoIcon size={16} />
          </button>
        )}
        <span className="grow" data-tauri-drag-region />
        <div className="header-actions" data-tauri-drag-region>
          {openError && <span className="error header-error" role="alert">{openError}</span>}
          <button
            className="icon-btn"
            aria-pressed={dockVisible}
            title={titleWithShortcut("Issues and Pull request", shortcuts.toggleTools)}
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
            onRevealProject={(project) => void revealProject(project.id)}
            filesProject={filesProjectId !== null && filesProjectId === selected?.id ? selected : null}
            onOpenFiles={openFiles}
            onCloseFiles={() => setFilesProjectId(null)}
            onOpenFile={openCodeFile}
            onNewTerminal={newTerminal}
            onSelectTerminal={(project, tabId) => {
              setShowSettings(false);
              setFilesProjectId(null);
              setSelectedId(project.id);
              setLayouts((previous) => restoreSplit(previous, project.id));
              chooseHalf(project.id, "terminal");
              setTerminals((previous) => selectTerminal(previous, project.id, tabId));
            }}
            onRenameTerminal={(project, tabId, name) => setTerminals((previous) => renameTerminal(previous, project.id, tabId, name))}
            onCloseTerminal={(project, tabId) => {
              forgetTerminalSession(`${project.id}:${tabId}`);
              setTerminals((previous) => closeTerminal(previous, project.id, tabId));
            }}
            onOpenPalette={() => overlays.current?.openPalette()}
            onOpenSettings={() => setShowSettings(true)}
            shortcuts={shortcuts}
          />
          <ResizeHandle label="Resize sidebar" controls="workspace-sidebar" axis="x" edge="end"
            {...layout.sidebar} onResize={sidebarSize.resize} onCommit={sidebarSize.commit} onReset={sidebarSize.reset} onCancel={sidebarSize.cancel} />
        </div>
        <div className="centre-column">
          {showSettings && <SettingsView onClose={() => setShowSettings(false)} />}
          <div className="centre-workbench" hidden={centreHidden} ref={centreRef}
            style={{ "--terminal-half": `${split.value}px` } as CSSProperties}>
            <div className="centre-half centre-terminal-half" id="centre-terminal-half" hidden={mode === "code"}>
              {/* Every terminal stays mounted while hidden, so scrollback and running processes survive switching. */}
              {projectsWithTerminals.map(([id, state]) => state.tabs.map((tab) => {
                const projectId = Number(id);
                const project = projects?.find((candidate) => candidate.id === projectId);
                if (!project) return null;
                const visible = !centreHidden && mode !== "code" && projectId === selected?.id && tab.id === state.selectedId;
                return (
                  <main key={`${projectId}:${tab.id}`} className="centre terminal-tab-panel" aria-label={`Terminal ${terminalTitle(tab)}`} hidden={!visible}>
                    <TerminalWorkbench
                      projectId={projectId}
                      rootPath={project.path}
                      contextKey={`${projectId}:${tab.id}`}
                      visible={visible}
                      headerAction={visible ? halfButton("terminal") : null}
                      onNewTerminal={project.missing ? undefined : () => newTerminal(project)}
                      onRunningChange={(command) => setTerminals((previous) => setRunning(previous, projectId, tab.id, command))}
                    />
                  </main>
                );
              }))}
              {!selected && (
                <main className="centre centre-empty" aria-label="Terminal">
                  <div className="empty-state">
                    <RepoIcon size={24} />
                    <p>Open a Project to begin.</p>
                    <button className="btn primary" onClick={() => overlays.current?.openPalette()}>Open a Project</button>
                  </div>
                </main>
              )}
              {selected && !hasTerminals && mode === "terminal" && (
                <main className="centre centre-empty" aria-label="No terminal">
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
            <div className="centre-half centre-code-half" role="region" aria-label="Code" tabIndex={-1} ref={codeHalfRef} hidden={mode === "terminal"}>
              {mode === "split" && selected && (
                <ResizeHandle label="Resize Terminal and Code" controls="centre-terminal-half" axis="x" edge="start"
                  {...split} onResize={setDragDivider}
                  onCommit={(value) => { setDragDivider(null); setLayouts((previous) => setDivider(previous, selected.id, value)); }}
                  onReset={() => { setDragDivider(null); setLayouts((previous) => setDivider(previous, selected.id, null)); }}
                  onCancel={() => setDragDivider(null)} />
              )}
              {codeProjects.map((projectId) => {
                const project = projects?.find((candidate) => candidate.id === projectId);
                if (!project) return null;
                return (
                  <Suspense key={projectId} fallback={mode !== "terminal" && projectId === selected?.id ? <Skeleton kind="code" label="Loading Code…" /> : null}>
                    <ProjectCode
                      reportOpenFiles={reportOpenFiles}
                      failOpenFile={failOpenFile}
                      projectId={projectId}
                      rootPath={project.path}
                      contextKey={`${projectId}:main`}
                      visible={!centreHidden && mode !== "terminal" && projectId === selected?.id}
                      showExplorer={false}
                      onChanged={() => {}}
                      openRequest={codeRequest?.projectId === projectId ? codeRequest : null}
                      headerAction={projectId === selected?.id ? halfButton("code") : null}
                    />
                  </Suspense>
                );
              })}
            </div>
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
                <PullRequestPanel projectId={selected.id} refreshKey={0} active={dockVisible && activeTool === "Pull request"} onChanged={() => {}} />
              </Suspense>
            </div>
          )}
          {selected && visitedTools[`${selected.id}:Issues`] && (
            <div className="surface-content" hidden={activeTool !== "Issues"}>
              <Suspense fallback={<Skeleton kind="list" label="Loading issues…" />}>
                <IssuesSurface projectId={selected.id} active={dockVisible && activeTool === "Issues"} />
              </Suspense>
            </div>
          )}
          {!selected && (
            <section className="surface-empty">
              <RepoIcon size={32} />
              <p className="surface-empty-title">Open a Project to use its tools.</p>
              <p className="surface-empty-description">The right dock holds Issues and Pull request for the selected Project.</p>
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
  onRevealProject: (project: Project) => void;
  filesProject: Project | null;
  onOpenFiles: (project: Project) => void;
  onCloseFiles: () => void;
  onOpenFile: (path: string) => void;
  onNewTerminal: (project: Project) => void;
  onSelectTerminal: (project: Project, tabId: number) => void;
  onRenameTerminal: (project: Project, tabId: number, name: string) => void;
  onCloseTerminal: (project: Project, tabId: number) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  shortcuts: ResolvedShortcuts;
}

/** The open Projects and, under each, its terminals; or, in the Files view, the selected Project's files. */
function Sidebar({
  projects, selected, terminals, settingsOpen, filesProject, onOpenFiles, onCloseFiles, onOpenFile,
  onSelectProject, onCloseProject, onRevealProject, onNewTerminal,
  onSelectTerminal, onRenameTerminal, onCloseTerminal, onOpenPalette, onOpenSettings, shortcuts,
}: SidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const [closingProjectId, setClosingProjectId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const filesOpen = filesProject !== null;
  // Where focus goes once the view has switched: the back button, or the Files button that was pressed.
  const pendingFocus = useRef<"back" | number | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const filesButtons = useRef(new Map<number, HTMLButtonElement>());
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "back") backButton.current?.focus();
    else if (target !== null) filesButtons.current.get(target)?.focus();
  }, [filesProject]);
  const openFilesView = (project: Project) => { pendingFocus.current = "back"; onOpenFiles(project); };
  const backToTerminals = () => { pendingFocus.current = filesProject?.id ?? null; onCloseFiles(); };

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
    <div className="sidebar">
      {/* The two views of the sidebar: the open Projects with their Terminals, or one Project's files. */}
      {filesProject && (
        <nav className="sidebar-view sidebar-files" id="sidebar-files" aria-label="Files">
          <button ref={backButton} type="button" className="files-heading" aria-label={`Back to Terminals from ${filesProject.name}`}
            title={readablePath(filesProject.path)} onClick={backToTerminals}>
            <ArrowLeftIcon size={14} className="files-heading-back" />
            <span className="project-name">{filesProject.name}</span>
            <span className="files-heading-terminals" aria-hidden="true">· Terminals</span>
          </button>
          <div className="surface-content">
            <Suspense fallback={<Skeleton kind="tree" label="Loading files…" />}>
              <FilesPanel key={filesProject.id} projectId={filesProject.id} rootPath={filesProject.path} revision={0} onOpenFile={onOpenFile} />
            </Suspense>
          </div>
        </nav>
      )}
      <nav className="sidebar-view" id="sidebar-terminals" aria-label="Projects" hidden={filesOpen}>
        <div className="sidebar-actions">
          <button className="btn grow" onClick={onOpenPalette} aria-label="Open a Project" title={titleWithShortcut("Open a Project", shortcuts.openProjectPalette)}>
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
                  <div className="project-row" data-selected={isSelected || undefined} onContextMenu={(event) => showContextMenu(event, [
                    { label: "New terminal", hint: formatShortcut(shortcuts.newTerminal) || undefined, disabled: project.missing, run: () => { setCollapsed((previous) => previous.filter((id) => id !== project.id)); onNewTerminal(project); } },
                    { label: "Open Files", hint: formatShortcut(shortcuts.openFiles) || undefined, disabled: project.missing, run: () => onOpenFiles(project) },
                    { label: revealInFileManagerLabel(), disabled: project.missing, run: () => onRevealProject(project), separatorBefore: true },
                    { label: "Copy path", run: () => copyTextToClipboard(readablePath(project.path)) },
                    { label: "Close project", disabled: closingProjectId === project.id, run: () => void close(project), separatorBefore: true },
                  ])}>
                    {/* The name selects the Project and unfolds its Terminals; on the active Project it folds or unfolds them. */}
                    <button
                      className={`project${expanded ? " open" : ""}`}
                      aria-current={isSelected}
                      aria-expanded={expanded}
                      aria-controls={expanded ? `project-${project.id}-terminals` : undefined}
                      aria-busy={closingProjectId === project.id}
                      title={readablePath(project.path)}
                      onClick={() => {
                        const fold = isSelected && expanded;
                        setCollapsed((previous) => fold ? [...previous, project.id] : previous.filter((id) => id !== project.id));
                        onSelectProject(project);
                      }}
                    >
                      <RepoIcon size={13} className="project-icon" />
                      <span className="project-name">{project.name}</span>
                      {project.missing && <span className="badge">missing</span>}
                      {!expanded && state.tabs.length > 0 && <span className="project-count" aria-label={`${state.tabs.length} ${state.tabs.length === 1 ? "terminal" : "terminals"}`}>{state.tabs.length}</span>}
                    </button>
                    <div className="project-actions">
                      <button ref={(node) => { if (node) filesButtons.current.set(project.id, node); else filesButtons.current.delete(project.id); }}
                        className="row-action project-files" aria-label={`Files of ${project.name}`} title={titleWithShortcut("Open Files", shortcuts.openFiles)}
                        disabled={project.missing}
                        onClick={() => openFilesView(project)}>
                        <FileDirectoryIcon size={14} />
                      </button>
                      <button className="row-action project-add" aria-label={`New terminal in ${project.name}`} title={titleWithShortcut("New terminal", shortcuts.newTerminal)}
                        disabled={project.missing}
                        onClick={() => { setCollapsed((previous) => previous.filter((id) => id !== project.id)); onNewTerminal(project); }}>
                        <PlusIcon size={14} />
                      </button>
                    </div>
                  </div>
                  <Collapsible open={expanded}>
                    <ul className="terminal-list" id={`project-${project.id}-terminals`} aria-label={`Terminals of ${project.name}`}>
                      {state.tabs.map((tab) => (
                        <TerminalRow key={tab.id} name={terminalTitle(tab)} baseName={tab.name} running={tab.running}
                          current={!settingsOpen && isSelected && tab.id === state.selectedId}
                          onSelect={() => onSelectTerminal(project, tab.id)}
                          onRename={(name) => onRenameTerminal(project, tab.id, name)}
                          onNewTerminal={project.missing ? undefined : () => onNewTerminal(project)}
                          onClose={() => onCloseTerminal(project, tab.id)} />
                      ))}
                    </ul>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>
      <button className="sidebar-footer" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings} title={titleWithShortcut("Settings", shortcuts.openSettings)}>
        <GearIcon size={14} /> Settings
      </button>
    </div>
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

/** A 10x10 caption glyph drawn with a 1px stroke, like the Segoe Fluent Icons Windows uses. */
function CaptionGlyph({ d, crisp = true }: { d: string; crisp?: boolean }) {
  // Straight strokes sit on half-pixel coordinates and snap to the pixel grid; the Close cross stays anti-aliased.
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"
    shapeRendering={crisp ? "crispEdges" : "geometricPrecision"} aria-hidden="true">
    <path d={d} />
  </svg>;
}

/** Caption buttons drawn like Windows 11's own: 46px wide, the full titlebar high, flush with the top-right corner. */
function WindowControls() {
  const window = getCurrentWindow();
  const maximized = useWindowMaximized();
  return <div className="window-controls" role="group" aria-label="Window controls">
    <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void window.minimize()}>
      <CaptionGlyph d="M0 5.5h10" />
    </button>
    <button type="button" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onClick={() => void window.toggleMaximize()}>
      {/* Restore layers a front window over the top and right edges of the one behind it. */}
      <CaptionGlyph d={maximized ? "M0.5 2.5h7v7h-7zM2.5 2.5v-2h7v7h-2" : "M0.5 0.5h9v9h-9z"} />
    </button>
    <button type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => void window.close()}>
      <CaptionGlyph d="M0 0l10 10M10 0L0 10" crisp={false} />
    </button>
  </div>;
}

type ProjectCodeProps = Omit<ComponentProps<typeof CodeWorkbench>, "onOpenFilesChange"> & {
  reportOpenFiles: (projectId: number, open: boolean) => void;
  failOpenFile: (projectId: number) => void;
};

/** Gives one Project's Code workspace a stable report callback. */
function ProjectCode({ reportOpenFiles, failOpenFile, ...props }: ProjectCodeProps) {
  const { projectId } = props;
  const report = useCallback((open: boolean) => reportOpenFiles(projectId, open), [reportOpenFiles, projectId]);
  const failed = useCallback(() => failOpenFile(projectId), [failOpenFile, projectId]);
  return <CodeWorkbench {...props} onOpenFilesChange={report} onOpenFailed={failed} />;
}

function WindowResizeHandles() {
  const maximized = useWindowMaximized();
  // A maximized window cannot be resized.
  if (maximized) return null;
  // No North-East corner: like a native window, the top-right corner belongs to the Close button,
  // and the North and East edges stop short of the caption buttons (see styles.css).
  const directions = ["North", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"] as const;
  return <div className="window-resize-handles" aria-hidden="true">
    {directions.map((direction) => <div key={direction} data-direction={direction} className={`window-resize window-resize-${direction.toLowerCase()}`}
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
    else document.querySelector<HTMLElement>('#workspace-sidebar .terminal-item, #workspace-sidebar input')?.focus();
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
