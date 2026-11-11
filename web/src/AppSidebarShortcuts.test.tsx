// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({
  ThreadView: ({ threadId }: { threadId: number }) => (
    <div data-thread={threadId}>
      <div role="textbox" contentEditable aria-label="Message" suppressContentEditableWarning />
    </div>
  ),
}));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./dictation", () => ({ DictationController: () => null }));
vi.mock("./CodeWorkbench", () => ({ CodeWorkbench: () => <div className="code-workbench">Editor</div> }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div className="files-navigation" /> }));
vi.mock("./TerminalSurface", () => ({ TerminalSurface: () => <div className="terminal-surface">Terminal</div> }));
vi.mock("./DiffPanel", () => ({ DiffPanel: () => <div className="diff-panel">Diff content</div> }));
vi.mock("./PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Oxide", path: "/repo", hidden: false, open: true, missing: false };
const thread = (id: number, title: string) => ({
  id, projectId: 1, provider: "claude", title, status: "completed", updatedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z", branch: null, worktreePath: null, issueNumber: null,
});
const threads = [thread(2, "Alpha work"), thread(3, "Beta work")];

const isMac = /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);
const primaryKey = isMac ? "Meta" : "Control";
const primary = isMac ? { metaKey: true } : { ctrlKey: true };
const label = (key: string) => isMac ? `⌘${key}` : `Ctrl+${key}`;

beforeEach(() => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command) => {
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return threads;
      case "git_diff": case "git_turn_diff": return { base: "main", files: [] };
      case "git_status": return { branch: "main", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: false, pickerDisabledReason: null };
      case "list_turns": return { turnCount: 1, turns: [] };
      case "plugin:event|listen": return 1;
      case "remember_selection": return null;
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {}, shortcuts: {} }, errors: [] };
      default: return null;
    }
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
const key = (type: "keydown" | "keyup", name: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init }));
  });
const holdPrimary = async () => {
  await key("keydown", primaryKey, primary);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
};
const badges = () => Array.from(host.querySelectorAll(".thread-row .shortcut-badge")).map((badge) => badge.textContent);

it("reveals thread shortcut badges while the primary modifier is held, and hides them on release", async () => {
  await act(async () => root.render(<App />));
  await settle();
  expect(badges()).toEqual([]);

  await holdPrimary();
  expect(badges()).toEqual([label("1"), label("2")]);

  await key("keyup", primaryKey, primary);
  expect(badges()).toEqual([]);
});

it("switches to the numbered thread with the primary modifier plus a digit", async () => {
  await act(async () => root.render(<App />));
  await settle();
  expect(host.querySelector('.thread-item[aria-current="true"]')?.textContent).toContain("Alpha work");

  await key("keydown", "2", { code: "Digit2", ...primary });
  await settle();

  expect(host.querySelector('.thread-item[aria-current="true"]')?.textContent).toContain("Beta work");
  expect(host.querySelector('[data-thread="3"]')).not.toBeNull();
});

it("reveals inline badges on primary actions only while the primary modifier is held", async () => {
  await act(async () => root.render(<App />));
  await settle();
  const newThread = () => host.querySelector<HTMLButtonElement>(".sidebar-actions .btn.grow")!;
  const openProject = () => host.querySelector<HTMLButtonElement>('.sidebar-actions button[aria-label="Open a Project"]')!;
  expect(newThread().querySelector(".inline-shortcut-kbd")).toBeNull();

  await holdPrimary();
  expect(newThread().querySelector(".inline-shortcut-kbd")?.textContent).toBe(label("N"));
  expect(openProject().querySelector(".inline-shortcut-kbd")?.textContent).toBe(isMac ? "⌘⇧N" : "Ctrl+Shift+N");

  await key("keyup", primaryKey, primary);
  expect(newThread().querySelector(".inline-shortcut-kbd")).toBeNull();
  expect(openProject().querySelector(".inline-shortcut-kbd")).toBeNull();
});

it("resets the modifier state on Escape and window blur", async () => {
  await act(async () => root.render(<App />));
  await settle();

  await holdPrimary();
  expect(badges()).toHaveLength(2);
  await key("keydown", "Escape");
  expect(badges()).toEqual([]);

  await holdPrimary();
  expect(badges()).toHaveLength(2);
  await act(async () => { window.dispatchEvent(new Event("blur")); });
  expect(badges()).toEqual([]);
});

it("numbers the visible, filtered thread list", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const search = host.querySelector<HTMLInputElement>(".sidebar-search input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Beta");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();

  await holdPrimary();
  expect(badges()).toEqual([label("1")]);

  await key("keydown", "1", { code: "Digit1", ...primary });
  await settle();
  expect(host.querySelector('.thread-item[aria-current="true"]')?.textContent).toContain("Beta work");
});
