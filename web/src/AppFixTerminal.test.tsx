// @vitest-environment jsdom
// Fix on a pull request with terminal Threads: the prompt is shown, then pasted into the branch's
// running agent or used to start a new Thread; never while the agent waits for an answer.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: ({ threadId }: { threadId: number }) => <div data-thread={threadId} /> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./AgentTerminalView", () => ({ AgentTerminalView: () => null, agentStatusLabel: () => "" }));
vi.mock("./PullRequestPanel", () => ({ PullRequestPanel: ({ onFixPullRequest }: { onFixPullRequest: (prompt: string, owner: number | null) => Promise<void> }) =>
  <button onClick={() => void onFixPullRequest("Fix PR #42\n- Fix failing CI check: build\n> external", 2)}>Fix PR</button>,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
const thread = (status: string) => ({ id: 2, projectId: 1, title: "Existing", provider: "claude", status, terminal: true, updatedAt: "2026-01-01T00:00:00Z" });
const calls: { command: string; args: unknown }[] = [];
let ownerStatus: string;

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  ownerStatus = "running";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread(ownerStatus)];
    if (command === "get_settings") return { settings: { defaultProvider: "claude", openThreadsAsTerminals: true, providers: {} }, errors: [] };
    if (command === "create_terminal_thread_with_fix") return { ...thread("running"), id: 3 };
    if (command === "plugin:event|listen") return 1;
    return null;
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

const sent = (command: string) => calls.filter((c) => c.command === command);
async function openFix() {
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Toggle tools panel"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Pull request"]')!.click());
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Fix PR")!.click());
}
const confirm = () => host.querySelector<HTMLButtonElement>('[role="dialog"] .primary')!;

it("pastes the confirmed Fix into the branch's running agent, and only on confirm", async () => {
  await openFix();
  expect(host.querySelector('[role="dialog"] pre')?.textContent).toContain("Fix failing CI check: build");
  expect(sent("deliver_agent_prompt")).toEqual([]);

  await act(async () => confirm().click());

  expect(sent("deliver_agent_prompt")).toEqual([{
    command: "deliver_agent_prompt", args: { threadId: 2, prompt: "Fix PR #42\n- Fix failing CI check: build\n> external" },
  }]);
  expect(sent("send_prompt")).toEqual([]);
  expect(sent("write_agent_terminal")).toEqual([]);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it("refuses while the agent waits for an answer, delivering nothing", async () => {
  ownerStatus = "needs-input";
  await openFix();
  expect(host.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("waiting for an answer");
  expect(confirm().disabled).toBe(true);
  await act(async () => confirm().click());
  expect(sent("deliver_agent_prompt")).toEqual([]);
});

it("starts a new Thread with the prompt when the branch's agent is not running, after confirm", async () => {
  ownerStatus = "stopped";
  await openFix();
  expect(confirm().textContent).toBe("Start new Thread");
  expect(sent("create_terminal_thread_with_fix")).toEqual([]);

  await act(async () => confirm().click());

  expect(sent("create_terminal_thread_with_fix")).toEqual([{
    command: "create_terminal_thread_with_fix",
    args: { projectId: 1, prompt: "Fix PR #42\n- Fix failing CI check: build\n> external", reviewRound: false, provider: null, model: null, effort: null, permissionMode: null },
  }]);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
