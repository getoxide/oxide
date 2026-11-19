// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./shared/queryCache";
import { App } from "./App";

vi.mock("./shared/QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./terminal/TerminalWorkbench", () => ({
  TerminalWorkbench: ({ projectId, contextKey, visible }: { projectId: number; contextKey: string; visible: boolean }) => (
    <div className="terminal-stub" data-project={projectId} data-context={contextKey} data-visible={String(visible)} />
  ),
}));
vi.mock("./pull-requests/PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./issues/IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));
vi.mock("./editor/FilesPanel", () => ({ FilesPanel: () => <div className="files-panel">Files content</div> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });

let host: HTMLDivElement;
let root: Root;
let calls: { command: string; args: unknown }[];
const projects = [
  { id: 1, name: "Project Alpha", path: "/alpha", hidden: false, open: true, missing: false },
  { id: 2, name: "Project Beta", path: "/beta", hidden: false, open: true, missing: false },
];

beforeEach(async () => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  clearQueryCache();
  calls = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "list_projects": case "rescan_projects": return projects;
      case "last_selection": return 1;
      case "set_project_open": return null;
      case "plugin:event|listen": return 1;
      default: return null;
    }
  });
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearMocks();
  vi.restoreAllMocks();
});

const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
const all = (selector: string) => Array.from(host.querySelectorAll<HTMLElement>(selector));
const click = (element: Element | null) => act(async () => (element as HTMLElement).click());
const label = (name: string) => q<HTMLButtonElement>(`[aria-label="${name}"]`);
const terminalNames = (project: string) => all(`[aria-label="Terminals of ${project}"] .terminal-item-title`).map((node) => node.textContent);
const visibleTerminals = () => all(".terminal-stub").filter((node) => node.dataset.visible === "true");

it("lists the open Projects with their terminals and nothing else", () => {
  expect(all(".project-name").map((node) => node.textContent)).toEqual(["Project Alpha", "Project Beta"]);
  expect(terminalNames("Project Alpha")).toEqual([]);
  expect(host.textContent).toContain("No terminals");
  expect(host.querySelector(".status-dot")).toBeNull();
  expect(host.textContent).not.toMatch(/Model|Effort|Usage/);
});

it("offers New terminal in an empty centre and opens a shell in that Project", async () => {
  expect(host.textContent).toContain("No terminal open in Project Alpha.");
  await click(q('main[aria-label="No terminal"] button.primary'));
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1"]);
  expect(all(".terminal-stub")).toHaveLength(1);
  expect(all(".terminal-stub")[0].dataset.project).toBe("1");
  expect(visibleTerminals()).toHaveLength(1);
  expect(host.textContent).not.toContain("No terminal open");
});

it("opens several terminals in the same Project and switches without unmounting any", async () => {
  await click(label("New terminal in Project Alpha"));
  await click(label("New terminal in Project Alpha"));
  await click(label("New terminal in Project Alpha"));
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
  const before = all(".terminal-stub");
  expect(before).toHaveLength(3);
  expect(visibleTerminals()[0].dataset.context).toBe("1:3");

  await click(all('[aria-label="Terminals of Project Alpha"] .terminal-item')[0]);

  expect(all(".terminal-stub")).toEqual(before);
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["1:1"]);
});

it("keeps each Project's terminals apart and shows the selected one", async () => {
  await click(label("New terminal in Project Alpha"));
  await click(label("New terminal in Project Beta"));
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["2:1"]);
  await click(all(".project")[0]);
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["1:1"]);
  expect(all(".terminal-stub")).toHaveLength(2);
});

it("renames a terminal by double-clicking it", async () => {
  await click(label("New terminal in Project Alpha"));
  const row = q<HTMLElement>('[aria-label="Terminals of Project Alpha"] .terminal-item')!;
  await act(async () => { row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
  const input = q<HTMLInputElement>('input[aria-label="Rename Terminal 1"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "server");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(terminalNames("Project Alpha")).toEqual(["server"]);
});

it("closes a terminal from the sidebar and unmounts its shell", async () => {
  await click(label("New terminal in Project Alpha"));
  await click(label("New terminal in Project Alpha"));
  await click(label("Close Terminal 2"));
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1"]);
  expect(all(".terminal-stub")).toHaveLength(1);
  expect(visibleTerminals()[0].dataset.context).toBe("1:1");
});

it("closing a Project ends its terminals and asks Core to keep it known but closed", async () => {
  await click(label("New terminal in Project Alpha"));
  await click(label("New terminal in Project Beta"));
  await click(label("Close Project Alpha"));
  expect(calls.some((call) => call.command === "set_project_open" && JSON.stringify(call.args) === JSON.stringify({ id: 1, open: false }))).toBe(true);
  expect(all(".terminal-stub").map((node) => node.dataset.project)).toEqual(["2"]);
});

it("gives the right dock exactly Files, Issues and Pull request", async () => {
  await click(label("Toggle tools panel"));
  expect(all('[role="tab"]').map((tab) => tab.getAttribute("aria-label"))).toEqual(["Files", "Issues", "Pull request"]);
  await click(label("Pull request"));
  expect(host.textContent).toContain("PR content");
  await click(label("Issues"));
  expect(host.textContent).toContain("Issues content");
});

it("opens Settings on an empty page", async () => {
  await click(q(".sidebar-footer"));
  const settings = q('main[aria-label="Settings"]')!;
  expect(settings.querySelectorAll("input, select, textarea")).toHaveLength(0);
  await click(label("Close settings"));
  expect(q('main[aria-label="Settings"]')).toBeNull();
});

it("does nothing when a former Oxide shortcut is pressed", async () => {
  await click(label("New terminal in Project Alpha"));
  const before = host.innerHTML;
  const callCount = calls.length;
  for (const init of [
    { key: "n", metaKey: true }, { key: "n", ctrlKey: true }, { key: "N", metaKey: true, shiftKey: true },
    { key: "m", metaKey: true, shiftKey: true }, { key: "1", metaKey: true }, { key: "1", ctrlKey: true, altKey: true },
    { key: "b", metaKey: true }, { key: ",", metaKey: true }, { key: "ArrowUp", metaKey: true }, { key: "ArrowDown", ctrlKey: true },
    { key: "Enter", metaKey: true, shiftKey: true },
  ]) {
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })); });
  }
  expect(host.innerHTML).toBe(before);
  expect(calls).toHaveLength(callCount);
});

it("never calls the commands of removed features", () => {
  const names = calls.map((call) => call.command);
  for (const gone of ["list_threads", "create_thread", "get_settings", "detect_provider", "subscribe_board", "subscribe_usage_limits"]) {
    expect(names).not.toContain(gone);
  }
});
