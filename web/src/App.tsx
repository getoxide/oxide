import { Skeleton } from "./Skeleton";
import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { invalidateQueries } from "./queryCache";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { commands, type Project, type Thread, type ThreadStatus, type ProjectServiceConflict } from "./bindings";
import type { CodeOpenRequest } from "./codeOpen";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDirectoryIcon,
  FileIcon,
  EyeIcon,
  GearIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  PlusIcon,
  RepoIcon,
  SearchIcon,
  TerminalIcon,
  SidebarExpandIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
  XIcon,
  type Icon,
  TrashIcon,
} from "@primer/octicons-react";
import { attentionTarget, type AttentionTarget } from "./attention";
import { useAttention } from "./useAttention";
import { useAttentionFocus } from "./useAttentionFocus";
import { isBoardThread } from "./dispatch";
import {
  allTabsOfThread, closeTab, describeAffectedTabs, emptyTerminals, focusCheckoutTab, openServiceTab, openTab, removeThreadTabsEverywhere, selectTab, setRunning,
  type TerminalCheckout, type TerminalsByProject,
} from "./terminalTabs";
import { performThreadDelete, selectionAfterDelete, threadsAfterDelete } from "./deleteThread";
import { GitHeader } from "./GitHeader";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectPalette } from "./ProjectPalette";
import { ProjectServices } from "./ProjectServices";
import { ServiceConflictDialog } from "./ServiceConflictDialog";
import { QuitDialog } from "./QuitDialog";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { ResizeHandle } from "./ResizeHandle";
import { workspaceLayout } from "./panelLayout";
import { useElementSize, usePanelSize } from "./usePanelSize";
import { displayPath, middleEllipsis, readablePath } from "./headerLines";
import { hasOpenDialog } from "./keyboardScope";
import { actionForKey, adjacentThreadId, ATTENTION_SHORTCUT, formatAccelerator, matchesAccelerator, modelDigitShortcut, type ShortcutAction } from "./shortcuts";
import { useShortcuts } from "./useShortcuts";
import { useModifierHeld } from "./useModifierHeld";
import { getDraft, isUnusedThread, setDraft } from "./threadDrafts";
import { createDefaultThread } from "./createDefaultThread";
import { filterThreads, relativeAge, sidebarProjects, threadTitle } from "./threadList";
import { rovingTab } from "./editorTabs";


const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

const TerminalSurface = lazy(() => import("./TerminalSurface").then((module) => ({ default: module.TerminalSurface })));
const CodeWorkbench = lazy(() => import("./CodeWorkbench").then((module) => ({ default: module.CodeWorkbench })));
const FilesPanel = lazy(() => import("./FilesPanel").then((module) => ({ default: module.FilesPanel })));
type WorkbenchContext = { key: string; projectId: number; threadId: number | null; rootPath: string };

const PullRequestPanel = lazy(() =>
  import("./PullRequestPanel").then((module) => ({ default: module.PullRequestPanel })),
);
const IssuesSurface = lazy(() =>
  import("./IssuesSurface").then((module) => ({ default: module.IssuesSurface })),
);
const TOOL_TABS: { name: string; Icon: Icon }[] = [
  { name: "Files", Icon: FileIcon },
  { name: "Terminal", Icon: TerminalIcon },
  { name: "Pull request", Icon: GitPullRequestIcon },
  { name: "Issues", Icon: IssueOpenedIcon },
];

const TOOL_TAB_ACTION: Record<string, ShortcutAction> = {
  Files: "files", Terminal: "terminal", "Pull request": "pullRequests", Issues: "issues",
};

export function App() {
  const legacySurface = useRef<string | null>((() => {
    try { const mode = localStorage.getItem("oxide:work-mode"); return mode === "code" ? "Files" : mode === "terminal" ? "Terminal" : null; }
    catch { return null; }
  })());
  const [showSidebar, setShowSidebar] = useState(true);
  const [regionPriority, setRegionPriority] = useState<"sidebar" | "tools">("tools");
  const [wantsMaximized, setMaximized] = useState(false);
  const [workbenches, setWorkbenches] = useState<WorkbenchContext[]>([]);
  /** Per Project, whether the centre shows the Code workspace or the selected Thread. */
  const [centreViews, setCentreViews] = useState<Record<number, "thread" | "code">>({});
  const [installCommand, setInstallCommand] = useState<{ id: number; command: string } | null>(null);
  const installSequence = useRef(0);
  const shortcuts = useShortcuts();
  const keys = (action: ShortcutAction) => formatAccelerator(shortcuts[action]);
  const modifierHeld = useModifierHeld();
  const [showTools, setShowTools] = useState(false);
  const [fallbackTool, setFallbackTool] = useState<string>("Files");
  const [activeToolsByProject, setActiveToolsByProject] = useState<Record<number, string>>({});
  const selectedThreadsByProject = useRef<Record<number, number | null>>({});
  const [showSettings, setShowSettings] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodySize = useElementSize(bodyRef, { width: window.innerWidth, height: window.innerHeight - 44 });
  const sidebarSize = usePanelSize("sidebar");
  const toolsSize = usePanelSize("tools");
  const [openError, setOpenError] = useState<string | null>(null);
  const [serviceConflict, setServiceConflict] = useState<ProjectServiceConflict | null>(null);
  const overlays = useRef<WorkspaceOverlaysHandle>(null);
  // A Project picked in the palette that should get a new Thread once its Threads have loaded.
  const pendingNewThread = useRef<number | null>(null);
  const [createPrRequest, setCreatePrRequest] = useState(0);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const onProjectsScanned = useCallback((next: Project[]) => {
    setProjects((previous) => previous && previous.length === next.length && previous.every((project, index) => {
      const other = next[index];
      return project.id === other.id && project.name === other.name && project.path === other.path &&
        project.open === other.open && project.hidden === other.hidden && project.missing === other.missing;
    }) ? previous : next);
  }, []);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [lastSelectionLoaded, setLastSelectionLoaded] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<{ projectId: number; message: string } | null>(null);
  const [threadReload, setThreadReload] = useState(0);
  const [codeRequest, setCodeRequest] = useState<(CodeOpenRequest & { contextKey: string }) | null>(null);
  const codeSequence = useRef(0);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [threadQuery, setThreadQuery] = useState("");
  // A New Thread request that reopened an empty Thread: the selection may not change, so
  // ThreadView gets a one-shot request to focus the composer and show a cue.
  const [newThreadFocus, setNewThreadFocus] = useState<{ threadId: number; id: number } | null>(null);
  const newThreadFocusSequence = useRef(0);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [prefill, setPrefill] = useState<{ threadId: number; text: string } | null>(null);
  // The Project and Thread of the last session: `undefined` until read, `null` once applied.
  const restore = useRef<{ projectId: number; threadId: number | null } | null | undefined>(undefined);
  // Derived, so it always reflects the latest list (missing badge) and
  // disappears when the Project is hidden.
  const selected = projects?.find((p) => p.id === selectedId && !p.hidden) ?? null;
  const activeTool = (selected ? activeToolsByProject[selected.id] : null) ?? fallbackTool;
  const setActiveTool = useCallback((name: string) => {
    setFallbackTool(name);
    if (selectedId !== null) {
      setActiveToolsByProject((prev) => (prev[selectedId] === name ? prev : { ...prev, [selectedId]: name }));
    }
  }, [selectedId]);
  const selectThread = useCallback((threadId: number | null) => {
    setSelectedThreadId(threadId);
    if (selectedId !== null) {
      selectedThreadsByProject.current[selectedId] = threadId;
      // Picking a Thread shows its conversation; Code stays one click away.
      setCentreViews((previous) => previous[selectedId] === "thread" || previous[selectedId] === undefined
        ? previous
        : { ...previous, [selectedId]: "thread" });
    }
  }, [selectedId]);
  const openProjectIds = useMemo(() => sidebarProjects(projects ?? []).map((project) => project.id), [projects]);
  const attentionCards = useAttention(openProjectIds);
  // A requested jump: kept until its Thread is shown and the response focused, so loading or failure never drops it.
  const [attentionJump, setAttentionJump] = useState<{ target: AttentionTarget; failed: boolean } | null>(null);
  const pendingThread = useRef<number | null>(null);
  const currentThreadId = threads?.some((thread) => thread.id === selectedThreadId)
    ? selectedThreadId
    : null;
  const sidebarThreads = useMemo(() => filterThreads(threads ?? [], threadQuery), [threads, threadQuery]);
  const selectedThread = threads?.find((thread) => thread.id === currentThreadId);
  const workbenchContext = useMemo<WorkbenchContext | null>(() => selected && currentThreadId !== null ? {
    key: `${selected.id}:${selectedThread?.worktreePath ? currentThreadId : "main"}`,
    projectId: selected.id, threadId: selectedThread?.worktreePath ? currentThreadId : null,
    rootPath: selectedThread?.worktreePath ?? selected.path,
  } : null, [selected, currentThreadId, selectedThread?.worktreePath]);
  /** The Files navigator rewards a wide layout; the editor itself now lives in the centre. */
  const canMaximize = activeTool === "Files" && workbenchContext !== null;
  const centreView = selected ? centreViews[selected.id] ?? "thread" : "thread";
  const maximized = wantsMaximized && canMaximize;
  const dockRequested = showTools && !showSettings;
  const layout = workspaceLayout(bodySize.width, bodySize.height, {
    sidebar: sidebarSize.preferred, tools: toolsSize.preferred, terminal: null,
  }, dockRequested, { sidebarVisible: showSidebar, priority: regionPriority, maximized });
  const dockVisible = layout.toolsVisible;
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [openedSurfaces, setOpenedSurfaces] = useState<Record<string, { files?: boolean; code?: boolean }>>({});
  const [terminals, setTerminals] = useState<TerminalsByProject>({});
  const [visitedTools, setVisitedTools] = useState<Record<string, boolean>>({});
  if (dockRequested && activeTool && selected && !visitedTools[`${selected.id}:${activeTool}`]) {
    setVisitedTools({ ...visitedTools, [`${selected.id}:${activeTool}`]: true });
  }
  if (dockRequested && activeTool === "Files" && workbenchContext && !openedSurfaces[workbenchContext.key]?.files) {
    setOpenedSurfaces({ ...openedSurfaces, [workbenchContext.key]: { ...openedSurfaces[workbenchContext.key], files: true } });
  }
  if (workbenchContext && openedSurfaces[workbenchContext.key] && !workbenches.some((context) => context.key === workbenchContext.key)) {
    setWorkbenches([...workbenches, workbenchContext]);
  }
  const selectSurface = useCallback((name: string, explicit = true) => {
    setActiveTool(name);
    setShowTools(true); setShowSettings(false); setRegionPriority("tools");
    // The first explicit visit opens the Project's first shell; later visits and Thread changes never spawn one.
    if (name === "Terminal" && explicit && workbenchContext) {
      setTerminals((previous) => (previous[workbenchContext.projectId]?.tabs.length ?? 0) > 0 ? previous : openTab(previous, workbenchContext.projectId, workbenchContext));
    }
  }, [setActiveTool, workbenchContext]);
  /** A sidebar service row reveals the Terminal Surface and opens or focuses that service's log tab. */
  const openService = useCallback(async (serviceId: number) => {
    setActiveTool("Terminal");
    setShowTools(true); setShowSettings(false); setRegionPriority("tools");
    try {
      const result = await commands.projectService(serviceId);
      if (result.status === "error") { setOpenError(result.error.message); return; }
      if (!result.data) { setOpenError("That Project Service no longer exists."); return; }
      const service = result.data;
      const threadId = service.threadId ?? null;
      // A worktree service keeps its Thread's checkout key; the main checkout shares "main".
      const worktree = threadId !== null && (service.projectId !== selected?.id || service.checkout !== selected.path);
      const checkout: TerminalCheckout = {
        key: `${service.projectId}:${worktree ? threadId : "main"}`,
        threadId,
        rootPath: service.checkout,
      };
      setOpenError(null);
      setTerminals((previous) => openServiceTab(previous, service.projectId, checkout, serviceId));
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selected, setActiveTool]);
  /** Shows the switch/restart dialog for a port conflict from a terminal or a log tab. */
  const showServiceConflict = useCallback((conflict: ProjectServiceConflict) => {
    setServiceConflict(conflict);
  }, []);
  const dismissServiceConflict = useCallback(() => setServiceConflict(null), []);
  const switchToConflictService = useCallback((serviceId: number) => {
    setServiceConflict(null);
    void openService(serviceId);
  }, [openService]);
  const restartConflictService = useCallback(async (serviceId: number) => {
    try {
      const result = await commands.restartProjectService(serviceId);
      if (result.status === "error") {
        setOpenError(result.error.message);
        setServiceConflict(null);
        return;
      }
      if (result.data.outcome === "conflict") {
        // It lost the port again: keep the dialog up with the fresher incumbent.
        setServiceConflict(result.data.payload);
        return;
      }
      setServiceConflict(null);
      await openService(result.data.payload.id);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
      setServiceConflict(null);
    }
  }, [openService]);
  // A Project's shells stay mounted while hidden; the selected Project shows the empty state once visited.
  const terminalSurfaces: TerminalsByProject = Object.fromEntries(
    Object.entries(terminals).filter(([, state]) => state.tabs.length > 0)
      .concat(selected && activeTool === "Terminal" ? [[String(selected.id), terminals[selected.id] ?? emptyTerminals]] : []),
  );
  const openTerminalTab = useCallback(() => {
    if (workbenchContext) setTerminals((previous) => openTab(previous, workbenchContext.projectId, workbenchContext));
  }, [workbenchContext]);
  const runInstallCommand = (command: string) => {
    setInstallCommand({ id: ++installSequence.current, command }); selectSurface("Terminal");
    // The command belongs in the selected Thread's checkout, never in a tab opened elsewhere.
    if (workbenchContext) setTerminals((previous) => focusCheckoutTab(previous, workbenchContext.projectId, workbenchContext));
  };
  /** A checkout's Code workspace mounts on first use and then keeps its buffers. */
  const ensureCodeWorkspace = useCallback((context: WorkbenchContext) => {
    setOpenedSurfaces((previous) => previous[context.key]?.code ? previous : {
      ...previous, [context.key]: { ...previous[context.key], code: true },
    });
    setWorkbenches((previous) => previous.some((candidate) => candidate.key === context.key)
      ? previous : [...previous, context]);
    setCentreViews((previous) => previous[context.projectId] === "code"
      ? previous : { ...previous, [context.projectId]: "code" });
  }, []);
  const showCodeWorkspace = useCallback(() => {
    if (!workbenchContext) return;
    ensureCodeWorkspace(workbenchContext);
    setMaximized(false);
    setShowSettings(false);
  }, [workbenchContext, ensureCodeWorkspace]);
  const openCodeFile = (path: string) => {
    if (!workbenchContext) return;
    setCodeRequest({ id: ++codeSequence.current, path, contextKey: workbenchContext.key });
    ensureCodeWorkspace(workbenchContext);
    setMaximized(false);
    setShowSettings(false);
    selectSurface("Files");
  };
  useEffect(() => {
    if (!selected || threads === null) return;
    if (legacySurface.current) { setActiveTool(legacySurface.current); setShowTools(true); legacySurface.current = null; }
    try { localStorage.removeItem("oxide:work-mode"); } catch { /* Presentation still migrates without storage. */ }
  }, [selected, threads, setActiveTool]);
  const currentThreadRef = useRef(currentThreadId);
  const currentProjectRef = useRef(selectedId);
  useEffect(() => {
    currentThreadRef.current = currentThreadId;
    currentProjectRef.current = selectedId;
  });
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
        setOpenError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setProjectsLoaded(true);
      }
    })();
  }, []);

  // Changes whenever a Thread's status does, so Git views refresh after a Turn.
  // A commit or push bumps it too, so the header reloads.
  const [gitRevision, setGitRevision] = useState(0);
  const onGitChanged = useCallback(() => {
    setGitRevision((n) => n + 1);
    // The user's own commit, push, pull or checkout: what Git views remember is now wrong.
    if (selectedId !== null) {
      invalidateQueries(`p${selectedId}:diff:`, { drop: true });
      invalidateQueries(`p${selectedId}:branches`);
      invalidateQueries(`p${selectedId}:prs:`);
    }
  }, [selectedId]);
  const threadStatuses = threads?.map((t) => `${t.id}:${t.status}`).join(",") ?? "";
  const threadsKey = `${threadStatuses}#${gitRevision}`;
  // A restore records a mark in the Transcript, so the Thread is read again.
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const onRestored = useCallback(() => setTranscriptRevision((n) => n + 1), []);
  // An agent can open a pull request during a Turn, which no change the user makes reports,
  // so the Pull request tab reloads whenever a Thread changes status.
  const [turnRevision, setTurnRevision] = useState({ statuses: threadStatuses, count: 0 });
  if (turnRevision.statuses !== threadStatuses) {
    setTurnRevision({ statuses: threadStatuses, count: turnRevision.count + 1 });
  }

  const openPullRequest = useCallback(() => {
    setShowSettings(false);
    setShowTools(true);
    setRegionPriority("tools");
    setActiveTool("Pull request");
    setCreatePrRequest((n) => n + 1);
  }, [setActiveTool]);

  useEffect(() => {
    void commands.lastSelection().then((res) => {
      const last = res.status === "ok" ? res.data : null;
      restore.current = last && { projectId: last.projectId, threadId: last.threadId };
      // Projects may have loaded first.
      if (last) setSelectedId((current) => current ?? last.projectId);
      setLastSelectionLoaded(true);
    }).catch((cause: unknown) => {
      restore.current = null;
      setOpenError(cause instanceof Error ? cause.message : String(cause));
      setLastSelectionLoaded(true);
    });
  }, []);

  useEffect(() => {
    const target = restore.current;
    if (target && selectedId === null && projects?.some((p) => p.id === target.projectId && !p.hidden)) {
      setSelectedId(target.projectId);
    }
  }, [projects, selectedId]);

  // Remember what is open, once the last session has been restored.
  useEffect(() => {
    const pending = restore.current;
    if (pending === undefined || !selected || threads === null) return;
    if (pending !== null) {
      if (pending.projectId !== selected.id) return;
      restore.current = null;
    }
    void commands.rememberSelection(selected.id, currentThreadId);
  }, [selected, threads, currentThreadId]);

  // Stable, since ThreadView resubscribes whenever it changes.
  const onThreadStatusChange = useCallback((threadId: number, status: ThreadStatus) => {
    setThreads(
      (prev) =>
        prev?.map((t) => (t.id === threadId && t.status !== status ? { ...t, status } : t)) ?? null
    );
  }, []);

  const onThreadTitleChange = useCallback((threadId: number, title: string) => {
    setThreads(
      (prev) => prev?.map((t) => (t.id === threadId ? { ...t, title } : t)) ?? null
    );
  }, []);

  const onThreadUpdated = useCallback((updated: Thread) => {
    setThreads(
      (prev) => prev?.map((t) => (t.id === updated.id ? updated : t)) ?? null
    );
  }, []);

  /** A new Thread in the Project with Settings defaults; `null` if it could not be created. */
  const createThreadIn = useCallback(async (projectId: number): Promise<Thread | null> => {
    const created = await createDefaultThread(projectId);
    return created.status === "ok" ? created.data : null;
  }, []);

  const fixPullRequest = async (projectId: number, prompt: string, ownerThreadId: number | null = null, reviewRound = false) => {
    const send = (threadId: number) =>
      reviewRound
        ? commands.sendReviewerComments(threadId, prompt)
        : commands.sendPrompt(threadId, [{ kind: "text", text: prompt }]);
    // The branch's Thread takes the request unless it is busy; otherwise a new Thread does.
    const owner = ownerThreadId === null
      ? null
      : (threads ?? []).find((thread) => thread.id === ownerThreadId && thread.status !== "working") ?? null;
    if (owner) {
      // Keep the request recoverable in the composer if the Thread has no draft of its own.
      const hadDraft = Boolean(drafts[owner.id]);
      if (!hadDraft) setDrafts((prev) => setDraft(prev, owner.id, prompt));
      try {
        const sent = await send(owner.id);
        if (sent.status === "error") throw new Error(sent.error.message);
        if (!hadDraft) setDrafts((prev) => setDraft(prev, owner.id, ""));
      } finally {
        if (currentProjectRef.current === projectId) {
          setSelectedThreadId(owner.id);
          setMaximized(false);
        }
      }
      return;
    }
    const created = await createDefaultThread(projectId);
    if (created.status === "error") throw new Error(created.error.message);
    const thread = created.data;
    // Keep the request recoverable if sending fails, and open after sending so the
    // Transcript's initial snapshot includes the Turn even if its events arrived early.
    setDrafts((prev) => setDraft(prev, thread.id, prompt));
    try {
      const sent = await send(thread.id);
      if (sent.status === "error") throw new Error(sent.error.message);
      setDrafts((prev) => setDraft(prev, thread.id, ""));
    } finally {
      if (currentProjectRef.current === projectId) {
        setThreads((prev) => [thread, ...(prev ?? [])]);
        setSelectedThreadId(thread.id);

        setMaximized(false);
      }
    }
  };

  // Only one unused Thread (no Turn, no draft, not working) at a time: asking for another reopens it.
  const startingThread = useRef(false);
  const startNewThread = useCallback(async () => {
    if (!selected || startingThread.current) return;
    startingThread.current = true;
    try {
      setMaximized(false);
      const askForComposerFocus = (threadId: number) =>
        setNewThreadFocus({ threadId, id: ++newThreadFocusSequence.current });
      // Only Threads that could be unused need a Turn count; a failed lookup just rules one out.
      const candidates = (threads ?? []).filter((t) => t.status !== "working" && getDraft(drafts, t.id).trim() === "");
      const counts = await Promise.all(
        candidates.map((t) => commands.listTurns(t.id, 0, 1).catch(() => null)),
      );
      const empty = candidates.find((t, i) => {
        const r = counts[i];
        return r?.status === "ok" && isUnusedThread(t, r.data.turnCount, drafts);
      });
      if (empty) {
        setSelectedThreadId(empty.id);
        // Reopening the Thread that is already open is visually a no-op: the request makes it felt.
        askForComposerFocus(empty.id);
        return;
      }
      const created = await createThreadIn(selected.id).catch(() => null);
      if (created) {
        setMaximized(false);
        setThreads((prev) => [created, ...(prev || [])]);
        setSelectedThreadId(created.id);
        askForComposerFocus(created.id);
      }
    } finally {
      startingThread.current = false;
    }
  }, [selected, threads, drafts, createThreadIn]);

  /** Jumps to a Thread waiting on the user, by default the most urgent. Never answers or clears it. */
  const jumpToAttention = useCallback((target: AttentionTarget | null = attentionTarget(attentionCards, openProjectIds)) => {
    if (!target) return;
    setShowSettings(false);
    setMaximized(false);
    if (target.projectId === selectedId) setSelectedThreadId(target.threadId);
    else {
      restore.current = null;
      pendingThread.current = target.threadId;
      setSelectedId(target.projectId);
      setThreads(null);
      setSelectedThreadId(null);
    }
    setAttentionJump({ target, failed: false });
  }, [attentionCards, openProjectIds, selectedId]);

  // Focus the response once its Thread is on screen; background updates never reach this.
  const jumpTarget = attentionJump && !attentionJump.failed ? attentionJump.target : null;
  const onJumpFocused = useCallback(() => setAttentionJump(null), []);
  const onJumpFailed = useCallback(() => setAttentionJump((current) => current && { ...current, failed: true }), []);
  useAttentionFocus(
    jumpTarget,
    jumpTarget !== null && selectedId === jumpTarget.projectId && currentThreadId === jumpTarget.threadId && !showSettings,
    onJumpFocused, onJumpFailed,
  );

  // The native menu follows the same creation path as the sidebar and shortcut.
  useEffect(() => {
    const unlisten = listen("new-thread", () => {
      setShowSettings(false);
      void startNewThread();
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [startNewThread]);

  const openProject = useCallback((project: Project) => {
    restore.current = null;
    setShowSettings(false);
    const opened = { ...project, open: true, hidden: false };
    setProjects((prev) => [opened, ...(prev?.filter((p) => p.id !== project.id) ?? [])]);
    if (project.id !== selectedId) {
      setSelectedId(project.id);
      setThreads(null);
      setSelectedThreadId(null);
    }
  }, [selectedId]);

  // The palette's search pick: âŒ˜â‡§N plus Enter is a new Thread in that Project.
  const startThreadIn = useCallback((project: Project) => {
    setShowSettings(false);
    if (project.id === selectedId) {
      void startNewThread();
      return;
    }
    pendingNewThread.current = project.id;
    openProject(project);
  }, [selectedId, startNewThread, openProject]);

  const revealCheckout = useCallback(async () => {
    if (!selected) return;
    const res = await commands.revealInFinder(selected.id, currentThreadId);
    setOpenError(res.status === "error" ? res.error.message : null);
  }, [selected, currentThreadId]);

  const deleteThread = useCallback((threadId: number) => {
    const title = threadTitle(threads?.find((t) => t.id === threadId) ?? { id: threadId, title: null });
    const affected = describeAffectedTabs(allTabsOfThread(terminals, threadId));
    overlays.current?.openDelete(threadId, title, affected);
  }, [threads, terminals]);

  const onThreadDeleted = useCallback((deletedId: number) => {
    setWorkbenches((contexts) => contexts.filter((context) => context.threadId !== deletedId));
    setTerminals((previous) => removeThreadTabsEverywhere(previous, deletedId));
    setThreads((prev) => threadsAfterDelete(prev, deletedId));
    setSelectedThreadId((current) => selectionAfterDelete(current, deletedId));
  }, []);

  // An empty Thread (no Turn yet) closes at once; any other one asks first.
  const closeThread = useCallback(async (threadId: number) => {
    const turns = await commands.listTurns(threadId, 0, 1);
    const ownsShells = allTabsOfThread(terminals, threadId).length > 0;
    if (turns.status === "ok" && turns.data.turnCount === 0 && !ownsShells) {
      const result = await performThreadDelete(threadId, false, commands.deleteThread);
      if (result.status === "deleted") {
        onThreadDeleted(threadId);
        return;
      }
    }
    deleteThread(threadId);
  }, [deleteThread, onThreadDeleted, terminals]);

  const surfaceTabsRef = useRef<HTMLElement>(null);
  const focusRegion = useCallback((region: "sidebar" | "centre" | "dock") => {
    if (region === "sidebar") {
      const sidebar = document.querySelector<HTMLElement>('#workspace-sidebar');
      if (sidebar && !sidebar.hidden) {
        const target = sidebar.querySelector<HTMLElement>(
          'input[type="search"], .thread-item[aria-current="true"], .sidebar-actions button, button'
        );
        target?.focus();
      } else {
        const handle = document.querySelector<HTMLElement>('button[aria-label="Toggle sidebar"]');
        handle?.focus();
      }
    } else if (region === "centre") {
      const centre = document.querySelector<HTMLElement>('.centre-column');
      if (centre && !centre.hidden) {
        const settings = centre.querySelector<HTMLElement>('.settings-view button, .settings-view input');
        const thread = centre.querySelector<HTMLElement>('.centre [role="textbox"], .centre textarea, .centre .empty-state button, .centre button');
        (settings ?? thread)?.focus();
      } else {
        const handle = document.querySelector<HTMLElement>('.thread-restore-handle, button[aria-label="Restore Thread"]');
        handle?.focus();
      }
    } else if (region === "dock") {
      const dock = document.querySelector<HTMLElement>('#workspace-tools');
      if (dock && !dock.hidden) {
        const activeTab = dock.querySelector<HTMLElement>(
          '[role="tablist"][aria-label="Surfaces"] [role="tab"][aria-selected="true"]'
        );
        const firstTab = dock.querySelector<HTMLElement>('[role="tablist"][aria-label="Surfaces"] [role="tab"]');
        const target = activeTab ?? firstTab;
        target?.focus();
        // Shortcuts can select a tab outside the visible strip; reveal it without moving the page.
        target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      } else {
        const handle = document.querySelector<HTMLElement>('button[aria-label="Toggle tools panel"]');
        handle?.focus();
      }
    }
  }, []);

  const onSurfaceTabsKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const names = TOOL_TABS.map((t) => t.name);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      const next = rovingTab(names, activeTool, e.key);
      if (next && next !== activeTool) {
        e.preventDefault();
        selectSurface(next);
        requestAnimationFrame(() => {
          const tab = surfaceTabsRef.current?.querySelector<HTMLElement>(`[role="tab"][aria-label="${next}"]`);
          tab?.focus();
          tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        });
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (e.key === "F6") {
        e.preventDefault();
        const active = document.activeElement;
        let current: "sidebar" | "centre" | "dock" = "centre";
        if (active?.closest('#workspace-sidebar') || active?.matches?.('button[aria-label="Toggle sidebar"]')) {
          current = "sidebar";
        } else if (active?.closest('.tools') || active?.matches?.('button[aria-label="Toggle tools panel"]')) {
          current = "dock";
        } else if (active?.closest('.centre-column') || active?.matches?.('.thread-restore-handle, button[aria-label="Restore Thread"]')) {
          current = "centre";
        }
        const order: ("sidebar" | "centre" | "dock")[] = ["sidebar", "centre", "dock"];
        const idx = order.indexOf(current);
        const next = e.shiftKey ? order[(idx - 1 + order.length) % order.length] : order[(idx + 1) % order.length];
        focusRegion(next);
        return;
      }

      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const active = document.activeElement;
        if (active?.closest?.(".monaco-editor, .xterm, .terminal")) {
          return;
        }
        if (serviceConflict) {
          e.preventDefault();
          setServiceConflict(null);
          return;
        }
        if (overlays.current?.hasOverlay()) {
          e.preventDefault();
          overlays.current.dismissTopmost();
          return;
        }
        if (showSettings) {
          e.preventDefault();
          setShowSettings(false);
          requestAnimationFrame(() => focusRegion("centre"));
          return;
        }
        if (maximized && dockVisible) {
          e.preventDefault();
          setMaximized(false);
          requestAnimationFrame(() => focusRegion("centre"));
          return;
        }
      }

      const action = actionForKey(e, shortcuts);
      // The built-in attention shortcut goes straight to the most urgent request, without the tray.
      // A user's own binding on the same keys wins.
      if (!action && matchesAccelerator(e, ATTENTION_SHORTCUT)) {
        e.preventDefault();
        jumpToAttention();
        return;
      }
      // The Model picker belongs to the open Thread, which handles it.
      if (!action || action === "modelPicker") return;
      if (action === "newThread") {
        if (selected) {
          e.preventDefault();
          void startNewThread();
        }
        return;
      }
      e.preventDefault();
      if (action === "closeThread") {
        if (currentThreadId !== null && !showSettings) void closeThread(currentThreadId);
      } else if (action === "openProject") {
        overlays.current?.openPalette();
      } else if (action === "previousThread" || action === "nextThread") {
        const next = adjacentThreadId(threads?.map((thread) => thread.id) ?? [], currentThreadId, action === "nextThread" ? 1 : -1);
        if (next === null || next === currentThreadId) return;
        setShowSettings(false);
        setMaximized(false);
        selectThread(next);
      } else if (action === "files" || action === "pullRequests" || action === "issues" || action === "terminal") {
        const tool = { files: "Files", pullRequests: "Pull request", issues: "Issues", terminal: "Terminal" }[action];
        selectSurface(tool);
        requestAnimationFrame(() => focusRegion("dock"));
      } else if (action === "toggleTools") {
        const willShow = !dockVisible;
        setShowTools(willShow);
        setRegionPriority("tools");
        setShowSettings(false);
        if (willShow) {
          requestAnimationFrame(() => focusRegion("dock"));
        } else {
          const active = document.activeElement;
          if (active?.closest('.tools')) {
            requestAnimationFrame(() => {
              document.querySelector<HTMLElement>('button[aria-label="Toggle tools panel"]')?.focus();
            });
          }
        }
      } else if (action === "toggleSidebar") {
        const willShow = !layout.sidebarVisible;
        setShowSidebar(willShow);
        setRegionPriority("sidebar");
        setMaximized(false);
        if (willShow) {
          requestAnimationFrame(() => focusRegion("sidebar"));
        } else {
          const active = document.activeElement;
          if (active?.closest('#workspace-sidebar')) {
            requestAnimationFrame(() => {
              document.querySelector<HTMLElement>('button[aria-label="Toggle sidebar"]')?.focus();
            });
          }
        }
      } else if (action === "maximizeSurface") {
        if (dockVisible && canMaximize) {
          const next = !maximized;
          setMaximized(next);
          if (!next) {
            requestAnimationFrame(() => focusRegion("centre"));
          } else {
            requestAnimationFrame(() => focusRegion("dock"));
          }
        }
      } else {
        setSettingsSection(null);
        setShowSettings(true);
        requestAnimationFrame(() => focusRegion("centre"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, selected, startNewThread, closeThread, showSettings, showTools, activeTool, currentThreadId, threads, selectSurface, layout.sidebarVisible, dockVisible, canMaximize, maximized, focusRegion, selectThread, jumpToAttention, serviceConflict]);

  // ⌘1..9 (Ctrl+1..9 elsewhere) picks the nth visible sidebar Thread. Capture runs before the
  // Thread's own digit shortcuts, but an open picker or dialog keeps those digits for itself.
  useEffect(() => {
    const onDigit = (event: KeyboardEvent) => {
      const index = modelDigitShortcut(event);
      if (index === null || selected === null || hasOpenDialog()) return;
      const target = sidebarThreads[index - 1];
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setShowSettings(false);
      setMaximized(false);
      selectThread(target.id);
    };
    window.addEventListener("keydown", onDigit, true);
    return () => window.removeEventListener("keydown", onDigit, true);
  }, [selected, sidebarThreads, selectThread]);

  // Listen for low-rate thread status changes from backend
  useEffect(() => {
    const unlisten = listen<{ threadId: number; status: ThreadStatus }>(
      "thread-status-changed",
      (event) => {
        setThreads((prev) =>
          prev?.map((t) =>
            t.id === event.payload.threadId ? { ...t, status: event.payload.status } : t
          ) ?? null
        );
      }
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // When selected project changes, fetch its threads
  useEffect(() => {
    let active = true;

    void (async () => {
      if (!selected) {
        if (active) {
          setThreads(null);
          setSelectedThreadId(null);
        }
        return;
      }

      const res = await commands.listThreads(selected.id).catch((cause: unknown) => ({ status: "error" as const, error: { message: cause instanceof Error ? cause.message : String(cause) } }));
      if (active) setThreadLoadError(res.status === "error" ? { projectId: selected.id, message: res.error.message } : null);
      if (active && res.status === "ok" && pendingNewThread.current === selected.id) {
        const created = await createThreadIn(selected.id);
        // Cleared only once applied: a re-run mid-await must still start the Thread.
        if (!active) return;
        pendingNewThread.current = null;
        setThreads(created ? [created, ...res.data] : res.data);
        const initialThreadId = created?.id ?? res.data[0]?.id ?? null;
        setSelectedThreadId(initialThreadId);

      } else if (active && res.status === "ok") {
        setThreads(res.data);
        const wanted = restore.current;
        const jump = pendingThread.current;
        pendingThread.current = null;
        const remembered = selectedThreadsByProject.current[selected.id];
        const initialThreadId = jump !== null && res.data.some((thread) => thread.id === jump) ? jump
          : wanted?.projectId === selected.id && res.data.some((thread) => thread.id === wanted.threadId)
          ? wanted.threadId
          : remembered !== undefined && (remembered === null || res.data.some((thread) => thread.id === remembered))
          ? remembered
          : res.data[0]?.id ?? null;
        selectThread(initialThreadId);
      }
    })();

    return () => {
      active = false;
    };
  }, [selected, createThreadIn, threadReload, selectThread]);

  const starting = !projectsLoaded || !lastSelectionLoaded || (selected !== null && threads === null);

  useEffect(() => {
    document.documentElement.dataset.appReady = "true";
  }, []);

  return (
    <div className={`window ${isMac ? "macos" : "windows"}`}>
      {isWindows && <WindowResizeHandles />}
      <QuitDialog />
      <WorkspaceOverlays ref={overlays} projects={projects ?? []} onProjectsScanned={onProjectsScanned}
        onStartThread={startThreadIn} onOpenProject={openProject} onThreadDeleted={onThreadDeleted} />
      {serviceConflict && (
        <ServiceConflictDialog
          conflict={serviceConflict}
          onSwitch={switchToConflictService}
          onRestart={restartConflictService}
          onDismiss={dismissServiceConflict}
        />
      )}
      <header className="header" data-tauri-drag-region>
        {isWindows && <AppMenu onNewThread={() => { setShowSettings(false); void startNewThread(); }} />}
        {/* The sidebar already holds New Thread and Open a Project; the header only offers the way back when it is hidden. */}
        {!layout.sidebarVisible && (
          <button className="icon-btn" aria-label="Toggle sidebar" title={`Show sidebar (${keys("toggleSidebar")})`} aria-pressed={false}
            onClick={() => {
              setShowSidebar(true);
              setRegionPriority("sidebar");
              setMaximized(false);
              requestAnimationFrame(() => focusRegion("sidebar"));
            }}><RepoIcon size={16} /></button>
        )}
        <div className="header-project" data-tauri-drag-region>
        {selected ? (<>
          <span className="title project-label" data-tauri-drag-region title={`Project: ${readablePath(selected.path)}`}>
            <RepoIcon size={13} />
            <strong>{selected.name}</strong>
            {selected.missing && <span className="badge">missing</span>}
          </span>
          {selectedThread && !showSettings && (() => {
            const folder = selectedThread.worktreePath ?? selected.path;
            return <span className="header-folder" data-tauri-drag-region title={readablePath(folder)}>
              <FileDirectoryIcon size={12} />
              <span>{middleEllipsis(displayPath(folder), 52)}</span>
            </span>;
          })()}
        </>) : !isWindows ? (
          <span className="title" data-tauri-drag-region>
            <strong>Oxide</strong>
          </span>
        ) : null}
        </div>
        {!isWindows && <span className="grow" data-tauri-drag-region />}
        <div className="header-actions" data-tauri-drag-region>
        {openError && <span className="error header-error" role="alert">{openError}</span>}
        {selected && !selected.missing && currentThreadId !== null && (
          <button className="icon-btn" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void revealCheckout()}>
            <FileDirectoryIcon size={16} />
          </button>
        )}
        <button
          className="icon-btn"
          aria-pressed={dockVisible}
          title={`Surfaces: Files, Terminal, Pull request, Issues (${keys("toggleTools")})`}
          aria-label="Toggle tools panel"
          onClick={() => {
            const willShow = !dockVisible;
            setShowTools(willShow);
            setRegionPriority("tools");
            setShowSettings(false);
            if (willShow) requestAnimationFrame(() => focusRegion("dock"));
          }}
        >
          <SidebarExpandIcon size={16} />
          {modifierHeld && <kbd className="shortcut-badge header-shortcut-badge">{keys("toggleTools")}</kbd>}
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
            onCloseProject={async (projectId) => {
              const closed = await commands.setProjectOpen(projectId, false);
              if (closed.status === "error") return closed.error.message;
              const listed = await commands.listProjects();
              const updatedProjects = listed.status === "ok"
                ? listed.data
                : (projects ?? []).map((project) => project.id === projectId ? { ...project, open: false } : project);
              setProjects(updatedProjects);
              if (selectedId === projectId) {
                const next = sidebarProjects(updatedProjects).find((project) => project.id !== projectId);
                restore.current = null;
                setSelectedId(next?.id ?? null);
                setThreads(null);
                setSelectedThreadId(null);
              }
              return listed.status === "error" ? listed.error.message : null;
            }}
            onSelect={(p) => {
              restore.current = null;
              pendingThread.current = null;
              setShowSettings(false);
              setSelectedId(p.id);
              setThreads(null);
              setSelectedThreadId(null);
            }}
            threads={threads === null ? null : sidebarThreads}
            threadCount={threads?.length ?? 0}
            selectedThreadId={selectedThreadId}
            onSelectThread={(threadId) => {
              setMaximized(false);
              setShowSettings(false);
              selectThread(threadId);
            }}
            onDeleteThread={(threadId) => void deleteThread(threadId)}
            onNewThread={() => {
              void startNewThread();
            }}
            onRenameThread={onThreadTitleChange}
            onOpenPalette={() => overlays.current?.openPalette()}
            onOpenService={openService}
            onServiceConflict={showServiceConflict}
            onOpenSettings={() => { setSettingsSection(null); setShowSettings(true); }}
            settingsOpen={showSettings}
            modifierHeld={modifierHeld}
            threadQuery={threadQuery}
            onThreadQueryChange={setThreadQuery}
          />
          <ResizeHandle label="Resize sidebar" controls="workspace-sidebar" axis="x" edge="end"
            {...layout.sidebar} onResize={sidebarSize.resize} onCommit={sidebarSize.commit} onReset={sidebarSize.reset} onCancel={sidebarSize.cancel} />
        </div>
        {maximized && dockVisible && <button className="thread-restore-handle" aria-label="Restore Thread" title="Restore Thread" onClick={() => {
          setMaximized(false);
          requestAnimationFrame(() => focusRegion("centre"));
        }}><ChevronRightIcon size={16} /></button>}
        <div className="centre-column" hidden={maximized && dockVisible}>
          {showSettings && <SettingsView section={settingsSection} onRunCommand={(command) => { setShowSettings(false); runInstallCommand(command); }} onClose={() => setShowSettings(false)} />}
          <div className="chat-workbench" hidden={showSettings}>
          {threadLoadError && threadLoadError.projectId === selected?.id ? (
            <main className="centre empty-thread" aria-label="Project load error"><p className="error" role="alert">Could not load Threads for {selected?.name}: {threadLoadError.message}</p><button className="btn" onClick={() => { setThreadLoadError(null); setThreadReload((value) => value + 1); }}>Retry</button></main>
          ) : starting ? (
            <main className="centre thread-loading" aria-label="Loading Project"><Skeleton kind="conversation" label="Loading Threadsâ€¦" /></main>
          ) : selected && currentThreadId === null ? (
            <ProjectOverview project={selected} threads={threads ?? []}
              onNewThread={() => void startNewThread()}
              onOpenThread={(id) => { selectThread(id); }}
              onSuggestionAccepted={(thread) => {
                if (currentProjectRef.current !== thread.projectId) return;
                setThreads((previous) => [thread, ...(previous ?? []).filter((t) => t.id !== thread.id)]);
                selectThread(thread.id);
              }}
              onOpenPullRequest={() => { setShowTools(true); setActiveTool("Pull request"); }} />
          ) : selected ? (
            <>
              <div className="centre-view-switch" role="tablist" aria-label="Project workspace">
                <button
                  role="tab"
                  aria-label="Thread view"
                  aria-selected={centreView === "thread"}
                  tabIndex={centreView === "thread" ? 0 : -1}
                  onClick={() => setCentreViews((previous) => ({ ...previous, [selected.id]: "thread" }))}
                >
                  Thread
                </button>
                <button
                  role="tab"
                  aria-label="Code view"
                  aria-selected={centreView === "code"}
                  tabIndex={centreView === "code" ? 0 : -1}
                  disabled={!workbenchContext}
                  title={workbenchContext ? "The Project's Code workspace" : "Select a Thread to open its checkout in Code"}
                  onClick={showCodeWorkspace}
                >
                  Code
                </button>
              </div>
            <main className="centre" aria-label="Thread" hidden={centreView === "code"}>
                              <ThreadView
                  visible={!showSettings && !(maximized && dockVisible) && centreView === "thread"}
                  threadId={selectedThreadId}
                  projectId={selected.id}
                  gitControls={currentThreadId !== null && !selected.missing ? (
                    <GitHeader
                      projectId={selected.id}
                      threadId={currentThreadId}
                      threadsKey={threadsKey}
                      agentBusy={selectedThread ? ["working", "needs-input"].includes(selectedThread.status) : false}
                      threadProvider={selectedThread?.provider}
                      threadIssue={selectedThread?.issueNumber != null ? `#${selectedThread.issueNumber}` : null}
                      threadWorking={selectedThread?.status === "working"}
                      onThreadCreated={(thread) => {
                        setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)]);
                        setSelectedThreadId(thread.id);
                      }}
                      onRestored={onRestored}
                      onOpenPullRequest={openPullRequest}
                      onChanged={onGitChanged}
                    />
                  ) : undefined}
                  draft={getDraft(drafts, selectedThreadId)}
                  onDraftChange={(text) =>
                    setDrafts((prev) => setDraft(prev, selectedThreadId, text))
                  }
                  onClearThread={() => {
                    void startNewThread();
                  }}
                  onThreadCreated={(newThread) => {
                    setThreads((prev) => [newThread, ...(prev || [])]);
                    setSelectedThreadId(newThread.id);

                  }}
                  onThreadUpdated={onThreadUpdated}
                  onStatusChange={onThreadStatusChange}
                  onThreadTitleChange={onThreadTitleChange}
                  prefill={prefill}
                  onPrefillUsed={() => setPrefill(null)}
                  onOpenThread={(id) => {
                    setSelectedThreadId(id);

                  }}
                  onThreadContinued={(continued, from) => {
                    setThreads((prev) => [
                      continued.thread,
                      ...(prev?.map((t) => (t.id === from ? { ...t, continuedIn: continued.thread.id } : t)) ?? []),
                    ]);
                    setPrefill({ threadId: continued.thread.id, text: continued.recap });
                    setSelectedThreadId(continued.thread.id);

                  }}
                  transcriptRevision={transcriptRevision}
                  initialProvider={selectedThread?.provider}
                  newThreadFocus={newThreadFocus?.threadId === currentThreadId ? newThreadFocus : null}
                  onNewThreadFocusHandled={() => setNewThreadFocus(null)}
                />
            </main>
            {workbenches.map((context) => openedSurfaces[context.key]?.code && (
              <Suspense key={context.key} fallback={centreView === "code" && context.key === workbenchContext?.key
                ? <Skeleton kind="code" label="Loading Codeâ€¦" /> : null}>
                <CodeWorkbench
                  projectId={context.projectId}
                  threadId={context.threadId}
                  rootPath={context.rootPath}
                  contextKey={context.key}
                  visible={centreView === "code" && context.key === workbenchContext?.key}
                  showExplorer={false}
                  onChanged={onGitChanged}
                  onOpenLanguageSettings={() => { setSettingsSection("language"); setMaximized(false); setShowSettings(true); }}
                  openRequest={codeRequest?.contextKey === context.key ? codeRequest : null}
                />
              </Suspense>
            ))}
            </>
          ) : (
            <main className="centre empty-thread" aria-label="Thread">
              <div className="empty-state">
                <RepoIcon size={24} />
                <p>Open a Project to begin.</p>
                <button className="btn primary" onClick={() => overlays.current?.openPalette()}>
                  Open a Project <kbd>{keys("openProject")}</kbd>
                </button>
              </div>
            </main>
          )}
          </div>
        </div>
          <aside className="tools" aria-label="Tools panel" id="workspace-tools" hidden={!dockVisible}>
            {!maximized && <ResizeHandle label="Resize Tools" controls="workspace-tools" axis="x" edge="start" direction={-1}
              {...layout.tools} onResize={toolsSize.resize} onCommit={toolsSize.commit} onReset={toolsSize.reset} onCancel={toolsSize.cancel} />}
            <nav className="tabs tools-tabs" role="tablist" aria-label="Surfaces" ref={surfaceTabsRef} onKeyDown={onSurfaceTabsKeyDown}>
              {/* The strip scrolls on its own so labels never shed text; utility actions stay pinned. */}
              <div className="tools-tab-strip" role="presentation">
                {TOOL_TABS.map(({ name, Icon }) => (
                  <button
                    key={name}
                    role="tab"
                    className="tab"
                    aria-label={name}
                    title={`${name} (${keys(TOOL_TAB_ACTION[name])})`}
                    aria-selected={activeTool === name}
                    tabIndex={activeTool === name ? 0 : -1}
                    onClick={() => selectSurface(name)}
                  >
                    <Icon size={14} /> <span className="tool-tab-label">{name}</span>
                    {modifierHeld && <kbd className="shortcut-badge">{keys(TOOL_TAB_ACTION[name])}</kbd>}
                  </button>
                ))}
              </div>
              <div className="tools-tab-actions">
                {canMaximize && <button className="icon-btn sm" title={`${maximized ? "Restore Surface" : "Maximize Surface"} (${keys("maximizeSurface")})`} aria-label={maximized ? "Restore Surface" : "Maximize Surface"} onClick={() => {
                  const next = !maximized;
                  setMaximized(next);
                  requestAnimationFrame(() => focusRegion(next ? "dock" : "centre"));
                }}>{maximized ? <ScreenNormalIcon size={14} /> : <ScreenFullIcon size={14} />}{modifierHeld && <kbd className="shortcut-badge">{keys("maximizeSurface")}</kbd>}</button>}
                <button className="icon-btn sm" title={`Close panel (${keys("toggleTools")})`} aria-label="Close tools panel" onClick={() => {
                  setShowTools(false);
                  requestAnimationFrame(() => {
                    document.querySelector<HTMLElement>('button[aria-label="Toggle tools panel"]')?.focus();
                  });
                }}>
                  <XIcon size={14} />
                </button>
              </div>
            </nav>
            {selected && visitedTools[`${selected.id}:Pull request`] && (
              <div className="surface-content" hidden={activeTool !== "Pull request"}><Suspense fallback={<Skeleton kind="list" label="Loading pull requestsâ€¦" />}>
                <PullRequestPanel
                  createRequest={createPrRequest}
                  onCreateHandled={() => setCreatePrRequest(0)}
                  projectId={selected.id}
                  threadId={currentThreadId}
                  threads={threads ?? []}
                  refreshKey={gitRevision + turnRevision.count}
                  onChanged={onGitChanged}
                  onFixPullRequest={(prompt, ownerThreadId, reviewRound) => fixPullRequest(selected.id, prompt, ownerThreadId, reviewRound)}
                />
              </Suspense></div>
            )}
            {workbenchContext && openedSurfaces[workbenchContext.key]?.files && (
              <div className="surface-content" hidden={activeTool !== "Files"}>
                <Suspense fallback={dockVisible && activeTool === "Files" ? <Skeleton kind="tree" label="Loading filesâ€¦" /> : null}>
                  <FilesPanel
                    key={workbenchContext.key}
                    projectId={workbenchContext.projectId}
                    threadId={workbenchContext.threadId}
                    revision={gitRevision + turnRevision.count}
                    onOpenFile={(path) => openCodeFile(path)}
                  />
                </Suspense>
              </div>
            )}
            {Object.entries(terminalSurfaces).map(([id, state]) => {
              const projectId = Number(id); const isSelectedProject = projectId === selected?.id;
              return <Suspense key={id} fallback={isSelectedProject && dockVisible && activeTool === "Terminal" ? <Skeleton kind="code" label="Loading Terminalâ€¦" /> : null}>
                <TerminalSurface projectId={projectId} terminals={state} checkout={isSelectedProject ? workbenchContext : null}
                  visible={isSelectedProject && dockVisible && activeTool === "Terminal"}
                  queuedCommand={isSelectedProject ? installCommand : null} onCommandConsumed={() => setInstallCommand(null)}
                  onOpenTab={openTerminalTab}
                  onSelectTab={(tabId) => setTerminals((previous) => selectTab(previous, projectId, tabId))}
                  onCloseTab={(tabId) => setTerminals((previous) => closeTab(previous, projectId, tabId))}
                  onRunningChange={(tabId, command) => setTerminals((previous) => setRunning(previous, projectId, tabId, command))}
                  onServiceConflict={showServiceConflict} />
              </Suspense>;
            })}
            {selected && currentThreadId === null && activeTool === "Files" && (
              <section className="surface-empty">
                <FileIcon size={32} />
                <p className="surface-empty-title">Select a Thread to browse files.</p>
                <p className="surface-empty-description">The Files Surface shows the selected Thread’s checkout.</p>
                <button className="btn primary" onClick={() => void startNewThread()}>New Thread</button>
              </section>
            )}
            {!selected && (
              <section className="surface-empty">
                <RepoIcon size={32} />
                <p className="surface-empty-title">Open a Project to use its tools.</p>
                <p className="surface-empty-description">The right dock holds four Surfaces for the selected Project: Files, Terminal, Pull request and Issues.</p>
                <button className="btn primary" onClick={() => overlays.current?.openPalette()}>Open a Project</button>
              </section>
            )}
            {selected && visitedTools[`${selected.id}:Issues`] && (
              <div className="surface-content" hidden={activeTool !== "Issues"}><Suspense fallback={<Skeleton kind="list" label="Loading issuesâ€¦" />}>
                <IssuesSurface
                  projectId={selected.id}
                  onDispatched={(thread) => {
                    // The Thread opens through the same dispatch/setup flow; if the
                    // user moved to another Project meanwhile, it only joins that Project's list there.
                    if (currentProjectRef.current !== thread.projectId) return;
                    setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)]);
                    setSelectedThreadId(thread.id);
                    setShowSettings(false);
                    setMaximized(false);
                  }}
                />
              </Suspense></div>
            )}
          </aside>
      </div>
    </div>
  );
}

interface SidebarProps {
  projects: Project[] | null;
  selected: Project | null;
  onCloseProject: (projectId: number) => Promise<string | null>;
  onSelect: (p: Project) => void;
  /** The selected Project's Threads for the sidebar, already filtered and ordered like ⌘1..9. */
  threads: Thread[] | null;
  /** The Thread count before filtering, to distinguish "none" from "no match". */
  threadCount: number;
  selectedThreadId: number | null;
  onSelectThread: (threadId: number) => void;
  onDeleteThread: (threadId: number) => void;
  onNewThread: () => void;
  onRenameThread?: (threadId: number, newTitle: string) => void;
  /** âŒ˜â‡§N: every known Project, scanned ones included, is found there. */
  onOpenPalette: () => void;
  onOpenService: (serviceId: number) => void;
  /** A sidebar restart lost the port race; App owns the switch/restart dialog. */
  onServiceConflict: (conflict: ProjectServiceConflict) => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** The primary modifier is held, so inline shortcut badges show. */
  modifierHeld: boolean;
  /** The sidebar's Thread filter, shared so ⌘1..9 follows the visible list. */
  threadQuery: string;
  onThreadQueryChange: (query: string) => void;
}

/** Open Projects, each with its Threads. Scanned repositories stay out until opened from âŒ˜â‡§N. */
function Sidebar({
  projects,
  selected,
  onCloseProject,
  onSelect,
  threads,
  threadCount,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onNewThread,
  onRenameThread,
  onOpenPalette,
  onOpenService,
  onServiceConflict,
  onOpenSettings,
  settingsOpen,
  modifierHeld,
  threadQuery,
  onThreadQueryChange,
}: SidebarProps) {
  const shortcuts = useShortcuts();
  const keys = (action: ShortcutAction) => formatAccelerator(shortcuts[action]);
  const [error, setError] = useState<string | null>(null);
  const [closingProjectId, setClosingProjectId] = useState<number | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  const finishRename = async (threadId: number) => {
    setEditingThreadId(null);
    const trimmed = renameText.trim();
    if (!trimmed) return;
    await commands.renameThread(threadId, trimmed);
    onRenameThread?.(threadId, trimmed);
  };

  const close = async (p: Project) => {
    if (closingProjectId !== null) return;
    setClosingProjectId(p.id);
    try {
      const message = await onCloseProject(p.id);
      if (message) setError(message);
      else setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClosingProjectId(null);
    }
  };

  // The selected Project always shows, even before the Core has marked it open.
  const listed = sidebarProjects(projects ?? []);
  const shown = selected && !listed.some((p) => p.id === selected.id) ? [selected, ...listed] : listed;
  const now = new Date();

  const renderThread = (t: Thread, index: number) => (
    <li key={t.id} className="thread-row">
      {editingThreadId === t.id ? (
        <input
          className="thread-rename-input"
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onBlur={() => void finishRename(t.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void finishRename(t.id);
            if (e.key === "Escape") setEditingThreadId(null);
          }}
          autoFocus
          aria-label={`Rename thread ${threadTitle(t)}`}
        />
      ) : (
        <button
          className="thread-item"
          aria-current={t.id === selectedThreadId}
          onClick={() => onSelectThread(t.id)}
          onDoubleClick={(e) => {
            e.preventDefault();
            setEditingThreadId(t.id);
            setRenameText(threadTitle(t));
          }}
          title={`${threadTitle(t)} (${t.status}). Double-click to rename.`}
        >
          <span className={`status-dot ${t.status}`} aria-label={`Status: ${t.status}`} />
          <span className="thread-item-title">{threadTitle(t)}</span>
          {t.blindReview && (
            <span className="thread-item-branch" title="Blind review" aria-label="Blind review">
              <EyeIcon size={12} />
            </span>
          )}
          {isBoardThread(t) && (
            <span className="thread-item-branch" title={`Board Thread: own worktree on ${t.branch}`} aria-label="Board Thread">
              <GitBranchIcon size={12} />
            </span>
          )}
          {modifierHeld && index < 9 ? (
            <span className="shortcut-badge">{formatAccelerator(`Mod+${index + 1}`)}</span>
          ) : (
            <span className="thread-item-age">{relativeAge(t.updatedAt, now)}</span>
          )}
        </button>
      )}
      <button
        className="row-action"
        onClick={() => onDeleteThread(t.id)}
        aria-label={`Delete ${threadTitle(t)}`}
        title={`Delete`}
      >
        <TrashIcon size={12} />
      </button>
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-actions">
        <button className="btn grow" onClick={onNewThread} disabled={!selected} title={`New Thread in this Project (${keys("newThread")})`}>
          <PlusIcon size={14} /> New Thread
          {modifierHeld && <kbd className="shortcut-badge">{keys("newThread")}</kbd>}
        </button>
        <button className="btn" onClick={onOpenPalette} title={`Open a Project, or a new Thread in another one (${keys("openProject")})`} aria-label="Open a Project">
          <RepoIcon size={14} />
          {modifierHeld && <kbd className="shortcut-badge">{keys("openProject")}</kbd>}
        </button>
      </div>
      {selected && (
        <label className="sidebar-search">
          <SearchIcon size={12} />
          <input
            type="search"
            placeholder="Search Threads"
            aria-label="Search Threads by title"
            value={threadQuery}
            onChange={(e) => onThreadQueryChange(e.target.value)}
          />
        </label>
      )}
      {error && <p className="error sidebar-note">{error}</p>}
      <div className="sidebar-scroll">
        {projects && shown.length === 0 && (
          <div className="sidebar-empty">
            <RepoIcon className="sidebar-empty-icon" size={18} />
            <div className="sidebar-empty-copy">
              <p className="sidebar-empty-title">No open Projects</p>
              <p className="sidebar-empty-hint">Open a project to see its Threads here.</p>
            </div>
            <button className="btn primary sidebar-empty-action" onClick={onOpenPalette} title={`Open a Project (${keys("openProject")})`}>
              <RepoIcon size={14} /> Open a Project
              {modifierHeld && <kbd className="shortcut-badge">{keys("openProject")}</kbd>}
            </button>
          </div>
        )}
        <ul className="project-list">
          {shown.map((p) => {
            const isSelected = p.id === selected?.id;
            return (
              <li key={p.id} className={`project-node${p.missing ? " missing" : ""}`}>
                <div className="project-row">
                  <button className="project" aria-current={isSelected} aria-expanded={isSelected} onClick={() => onSelect(p)} title={readablePath(p.path)}>
                    {isSelected ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    <RepoIcon size={13} />
                    <span className="project-name">{p.name}</span>
                    {p.missing && <span className="badge">missing</span>}
                  </button>
                  <button className="row-action" onClick={() => void close(p)} disabled={closingProjectId === p.id} aria-busy={closingProjectId === p.id} aria-label={`Close ${p.name}`} title={closingProjectId === p.id ? "Closing Projectâ€¦" : `Close Project (it stays in ${keys("openProject")})`}>
                    <XIcon size={13} />
                  </button>
                </div>
                {isSelected && (
                  <ul className="thread-list" aria-label="Thread list">
                    {threads && threads.length === 0 && (
                      <li className="sidebar-note">{threadCount === 0 ? "No Threads yet" : "No matching Threads"}</li>
                    )}
                    {threads?.map((t, index) => renderThread(t, index))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {selected && <ProjectServices projectId={selected.id} onOpenService={onOpenService} onServiceConflict={onServiceConflict} />}
      <button className="sidebar-footer" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings} title={`Settings (${keys("openSettings")})`}>
        <GearIcon size={14} /> Settings
        {modifierHeld && <kbd className="shortcut-badge">{keys("openSettings")}</kbd>}
      </button>
    </nav>
  );
}

function AppMenu({ onNewThread }: { onNewThread: () => void }) {
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
    File: [{ label: "New Thread", action: onNewThread }],
    Edit: ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"].map((label) => ({ label, action: () => {
      const command = label === "Select All" ? "selectAll" : label.toLowerCase();
      if (window.dispatchEvent(new CustomEvent("oxide-editor-edit", { detail: command, cancelable: true }))) document.execCommand(command);
    } })),
    Window: [{ label: "Minimize", action: () => { void win.minimize(); } }, { label: "Maximize / Restore", action: () => { void win.toggleMaximize(); } }],
  };
  return <nav ref={root} className="app-menu" aria-label="Application menu">
    {Object.entries(menus).map(([name, items]) => <div className="app-menu-item" key={name}>
      <button type="button" aria-haspopup="menu" aria-expanded={open === name} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(open === name ? null : name)}>{name}</button>
      {open === name && <div className="app-menu-popup" role="menu">
        {items.map(({ label, action }) => <button key={label} role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { action(); setOpen(null); }}>{label}</button>)}
      </div>}
    </div>)}
  </nav>;
}

function WindowControls() {
  const window = getCurrentWindow();
  return <div className="window-controls" role="group" aria-label="Window controls">
    <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void window.minimize()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
    </button>
    <button type="button" aria-label="Maximize or restore" title="Maximize or restore" onClick={() => void window.toggleMaximize()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
    </button>
    <button type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => void window.close()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2L2 10" /></svg>
    </button>
  </div>;
}

function WindowResizeHandles() {
  const directions = ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"] as const;
  return <div className="window-resize-handles" aria-hidden="true">
    {directions.map((direction) => <div key={direction} className={`window-resize window-resize-${direction.toLowerCase()}`}
      onMouseDown={(event) => { if (event.button === 0) void getCurrentWindow().startResizeDragging(direction); }} />)}
  </div>;
}

type WorkspaceOverlaysHandle = {
  openPalette: () => void;
  openDelete: (id: number, title: string, shells: string[]) => void;
  hasOverlay: () => boolean;
  dismissTopmost: () => boolean;
};

function WorkspaceOverlays({ ref, projects, onProjectsScanned, onStartThread, onOpenProject, onThreadDeleted }: {
  ref: Ref<WorkspaceOverlaysHandle>;
  projects: Project[];
  onProjectsScanned: (projects: Project[]) => void;
  onStartThread: (project: Project) => void;
  onOpenProject: (project: Project) => void;
  onThreadDeleted: (id: number) => void;
}) {
  const [showPalette, setShowPalette] = useState(false);
  const [pending, setPending] = useState<{ id: number; title: string; discardChanges: boolean; shells: string[] } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invoker = useRef<HTMLElement | null>(null);

  const restoreFocus = () => {
    if (invoker.current && invoker.current.isConnected) {
      invoker.current.focus();
    } else {
      document.querySelector<HTMLElement>('#workspace-sidebar .thread-item, #workspace-sidebar input')?.focus();
    }
  };

  useImperativeHandle(ref, () => ({
    openPalette: () => {
      invoker.current = document.activeElement as HTMLElement | null;
      setShowPalette(true);
    },
    openDelete: (id, title, shells) => {
      invoker.current = document.activeElement as HTMLElement | null;
      setError(null);
      setPending({ id, title, discardChanges: false, shells });
    },
    hasOverlay: () => Boolean(pending || showPalette),
    dismissTopmost: () => {
      if (pending) {
        setPending(null);
        restoreFocus();
        return true;
      }
      if (showPalette) {
        setShowPalette(false);
        restoreFocus();
        return true;
      }
      return false;
    },
  }), [pending, showPalette]);

  useEffect(() => {
    if (!showPalette) return;
    let active = true;
    void commands.rescanProjects().then((result) => {
      if (active && result.status === "ok") onProjectsScanned(result.data);
    });
    return () => { active = false; };
  }, [showPalette, onProjectsScanned]);

  async function confirmDelete() {
    if (!pending || deleting) return;
    setDeleting(true); setError(null);
    try {
      const result = await performThreadDelete(pending.id, pending.discardChanges, commands.deleteThread);
      if (result.status === "error") setError(result.message);
      else if (result.status === "needs-confirmation") setPending((current) => current ? { ...current, discardChanges: true } : null);
      else { onThreadDeleted(pending.id); setPending(null); restoreFocus(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeleting(false); }
  }

  const cancelDelete = () => {
    setPending(null);
    restoreFocus();
  };

  return <>
    {pending && <div className="modal-backdrop" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancelDelete(); } }}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-thread-title">
        <h2 id="delete-thread-title">{pending.discardChanges ? "Discard worktree changes and delete?" : `Delete â€œ${pending.title}â€?`}</h2>
        <p>{pending.discardChanges ? "This Thread's worktree has uncommitted changes. Deleting removes the worktree and discards them; the branch is kept." : "Its conversation is removed permanently."}</p>
        {pending.shells.length > 0 && <>
          <p>Deleting also closes the terminals in its worktree:</p>
          <ul className="delete-shells">{pending.shells.map((shell, index) => <li key={index} className="mono">{shell}</li>)}</ul>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button onClick={cancelDelete} disabled={deleting}>Cancel</button>
          <button autoFocus className="danger" onClick={() => void confirmDelete()} disabled={deleting}>{deleting ? "Deletingâ€¦" : "Delete Thread"}</button>
        </div>
      </div>
    </div>}
    {showPalette && <ProjectPalette projects={projects} defaultParent="~/Developer" onClose={() => { setShowPalette(false); restoreFocus(); }}
      onStartThread={onStartThread} onOpenProject={onOpenProject} />}
  </>;
}
