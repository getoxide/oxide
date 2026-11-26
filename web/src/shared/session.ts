import { readJson, removeKey, removeKeysWithPrefix, storageKeys, writeJson } from "./storage";
import type { Half } from "./splitLayout";
import type { TerminalsByProject } from "../terminal/terminalTabs";

/**
 * Session restore: with the setting on, Oxide reopens what was open when it quit. The Terminals
 * of each Project come back with their names, their folder and their recent Command blocks (in
 * new shells: programs that were running are not), and the Code workspaces with their files.
 * Everything lives in the webview's storage, like the rest of the layout.
 */
export interface SessionSnapshot {
  terminals: TerminalsByProject;
  /** Projects whose Code workspace had files open. */
  code: number[];
  lastHalf: Record<number, Half>;
}

/** What one Terminal brings back: the folder its shell was in and its last Command blocks. */
export interface TerminalSessionBlock {
  command: string;
  output: string;
  exitCode: number | null;
  at: number;
  completedAt: number;
}
export interface TerminalSession {
  cwd: string | null;
  blocks: TerminalSessionBlock[];
}

/** Recent blocks kept per Terminal, and the tail of output kept per block. */
export const SESSION_BLOCKS = 10;
export const SESSION_OUTPUT = 16 * 1024;
const TERMINAL_PREFIX = storageKeys.terminalSession("");

export function restoreSessionEnabled(): boolean {
  return readJson(storageKeys.restoreSession) !== false;
}

/** Turning it off also forgets what was saved, so nothing old comes back when it is turned on. */
export function setRestoreSession(enabled: boolean): void {
  writeJson(storageKeys.restoreSession, enabled);
  if (!enabled) {
    removeKey(storageKeys.session);
    removeKeysWithPrefix(TERMINAL_PREFIX);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

export function readSession(): SessionSnapshot | null {
  if (!restoreSessionEnabled()) return null;
  const value = readJson(storageKeys.session);
  if (!isRecord(value) || !isRecord(value.terminals)) return null;
  const terminals: TerminalsByProject = {};
  for (const [key, project] of Object.entries(value.terminals)) {
    const projectId = Number(key);
    if (!isId(projectId) || !isRecord(project) || !Array.isArray(project.tabs) || !isId(project.nextId)) continue;
    const tabs = project.tabs
      .filter((tab): tab is { id: number; name: string; customName?: unknown } => isRecord(tab) && isId(tab.id) && typeof tab.name === "string" && tab.name.trim() !== "")
      .filter((tab) => tab.id < (project.nextId as number))
      .map((tab) => ({
        id: tab.id,
        name: tab.name.slice(0, 200),
        // Snapshots from before the flag: a name other than the default one was given by hand.
        customName: typeof tab.customName === "boolean" ? tab.customName : !/^Terminal \d+$/.test(tab.name),
        running: null,
      }));
    const selectedId = tabs.some((tab) => tab.id === project.selectedId) ? (project.selectedId as number) : tabs[0]?.id ?? null;
    terminals[projectId] = { tabs, selectedId, nextId: project.nextId };
  }
  const code = Array.isArray(value.code) ? value.code.filter(isId) : [];
  const lastHalf: Record<number, Half> = {};
  if (isRecord(value.lastHalf))
    for (const [key, half] of Object.entries(value.lastHalf))
      if (isId(Number(key)) && (half === "terminal" || half === "code")) lastHalf[Number(key)] = half;
  return { terminals, code, lastHalf };
}

export function writeSession(snapshot: SessionSnapshot): void {
  if (!restoreSessionEnabled()) return;
  const terminals = Object.fromEntries(Object.entries(snapshot.terminals).map(([id, project]) => [id, {
    tabs: project.tabs.map(({ id: tabId, name, customName }) => ({ id: tabId, name, customName })),
    selectedId: project.selectedId,
    nextId: project.nextId,
  }]));
  writeJson(storageKeys.session, { terminals, code: snapshot.code, lastHalf: snapshot.lastHalf });
}

export function readTerminalSession(context: string): TerminalSession | null {
  if (!restoreSessionEnabled()) return null;
  const value = readJson(storageKeys.terminalSession(context));
  if (!isRecord(value) || !Array.isArray(value.blocks)) return null;
  const blocks = value.blocks
    .filter((block): block is TerminalSessionBlock => isRecord(block) && typeof block.command === "string" &&
      typeof block.output === "string" && (block.exitCode === null || Number.isInteger(block.exitCode)) &&
      typeof block.at === "number" && typeof block.completedAt === "number")
    .slice(-SESSION_BLOCKS)
    .map((block) => ({ ...block, output: block.output.slice(-SESSION_OUTPUT) }));
  return { cwd: typeof value.cwd === "string" && value.cwd ? value.cwd : null, blocks };
}

export function writeTerminalSession(context: string, session: TerminalSession): void {
  if (!restoreSessionEnabled()) return;
  writeJson(storageKeys.terminalSession(context), {
    cwd: session.cwd,
    blocks: session.blocks.slice(-SESSION_BLOCKS).map((block) => ({ ...block, output: block.output.slice(-SESSION_OUTPUT) })),
  });
}

/** A closed Terminal leaves nothing behind. */
export function forgetTerminalSession(context: string): void {
  removeKey(storageKeys.terminalSession(context));
}

/** The line that moves a fresh shell to `cwd`: typed before any block, so its output is never shown. */
export function changeDirectoryLine(cwd: string, windows: boolean): string {
  return windows
    ? ` Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'\r`
    : ` cd -- '${cwd.replaceAll("'", "'\\''")}' 2>/dev/null\n`;
}
