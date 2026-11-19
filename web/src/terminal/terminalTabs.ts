/** A Project's terminals: plain shells in its folder, shown in the sidebar and the centre. */
export interface TerminalTab {
  id: number;
  name: string;
  /** The command a Command block is running now, if any. */
  running: string | null;
}

export interface ProjectTerminals {
  tabs: TerminalTab[];
  selectedId: number | null;
  nextId: number;
}

export type TerminalsByProject = Record<number, ProjectTerminals>;

export const emptyTerminals: ProjectTerminals = { tabs: [], selectedId: null, nextId: 1 };

const of = (state: TerminalsByProject, projectId: number) => state[projectId] ?? emptyTerminals;

/** Opens a terminal in the Project and selects it. Only an explicit user action calls this. */
export function openTerminal(state: TerminalsByProject, projectId: number): TerminalsByProject {
  const project = of(state, projectId);
  const tab: TerminalTab = { id: project.nextId, name: `Terminal ${project.nextId}`, running: null };
  return { ...state, [projectId]: { tabs: [...project.tabs, tab], selectedId: tab.id, nextId: project.nextId + 1 } };
}

export function selectTerminal(state: TerminalsByProject, projectId: number, tabId: number): TerminalsByProject {
  const project = of(state, projectId);
  if (!project.tabs.some((tab) => tab.id === tabId) || project.selectedId === tabId) return state;
  return { ...state, [projectId]: { ...project, selectedId: tabId } };
}

/** Closing the selected terminal selects its neighbour; other terminals never change. */
export function closeTerminal(state: TerminalsByProject, projectId: number, tabId: number): TerminalsByProject {
  const project = of(state, projectId);
  const index = project.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = project.tabs.filter((tab) => tab.id !== tabId);
  const selectedId = project.selectedId !== tabId ? project.selectedId : (tabs[index] ?? tabs[index - 1])?.id ?? null;
  return { ...state, [projectId]: { ...project, tabs, selectedId } };
}

/** A blank name keeps the old one. */
export function renameTerminal(state: TerminalsByProject, projectId: number, tabId: number, name: string): TerminalsByProject {
  const project = of(state, projectId);
  const trimmed = name.trim();
  const tab = project.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !trimmed || tab.name === trimmed) return state;
  return { ...state, [projectId]: { ...project, tabs: project.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, name: trimmed } : candidate) } };
}

export function setRunning(state: TerminalsByProject, projectId: number, tabId: number, running: string | null): TerminalsByProject {
  const project = of(state, projectId);
  const tab = project.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.running === running) return state;
  return { ...state, [projectId]: { ...project, tabs: project.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, running } : candidate) } };
}

/** Closing a Project ends its terminals: its state is forgotten, so their views unmount. */
export function closeProjectTerminals(state: TerminalsByProject, projectId: number): TerminalsByProject {
  if (!(projectId in state)) return state;
  const next = { ...state };
  delete next[projectId];
  return next;
}
