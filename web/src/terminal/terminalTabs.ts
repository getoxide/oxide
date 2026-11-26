/** A Project's terminals: plain shells in its folder, shown in the sidebar and the centre. */
export interface TerminalTab {
  id: number;
  name: string;
  /** The user named it: a running program never takes the name's place. */
  customName: boolean;
  /** The command a Command block is running now, if any. */
  running: string | null;
}

/** Commands that run another one: the name shown is the program they run. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice"]);
/** The wrappers' flags that take the next word as their value (`sudo -u root`, `nice -n 5`). */
const VALUE_FLAGS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-S"],
  nice: ["-n"],
};

/**
 * The program a command line runs, for a Terminal's name: the first command before any shell
 * operator, past variable assignments and wrappers (`sudo`, `env`, …) and their flags, as a
 * basename. `null` when the line names none. Only the shell's own wrappers are skipped: no program
 * is special-cased, and the name is a label, never a status (ADR-0018).
 */
export function programName(command: string | null): string | null {
  if (!command) return null;
  const line = command.split(/\r?\n/).find((part) => part.trim()) ?? "";
  // A quoted assignment (`FOO="a b"`) is one word; a subshell or group opens on its first command.
  const segment = (line.split(/\|\||&&|[|;&]/)[0] ?? "").replace(/=("[^"]*"|'[^']*')/g, "=_").replace(/^[\s({]+/, "");
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index++; continue; }
    if (WRAPPERS.has(word)) {
      index++;
      while (index < words.length && words[index].startsWith("-")) {
        index += VALUE_FLAGS[word]?.includes(words[index]) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  const word = words[index]?.replace(/^["']|["']$/g, "");
  if (!word) return null;
  const base = word.split(/[\\/]/).filter(Boolean).pop();
  return base || null;
}

/** What the sidebar calls a Terminal: its own name, or while it runs a program, that program. */
export function terminalTitle(tab: TerminalTab): string {
  return tab.customName ? tab.name : programName(tab.running) ?? tab.name;
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
  const tab: TerminalTab = { id: project.nextId, name: `Terminal ${project.nextId}`, customName: false, running: null };
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

/** A blank name keeps the old one. A name the user gives stays from then on: programs never replace it. */
export function renameTerminal(state: TerminalsByProject, projectId: number, tabId: number, name: string): TerminalsByProject {
  const project = of(state, projectId);
  const trimmed = name.trim();
  const tab = project.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !trimmed || (tab.customName && tab.name === trimmed)) return state;
  return { ...state, [projectId]: { ...project, tabs: project.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, name: trimmed, customName: true } : candidate) } };
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
