// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: ({ gitControls }: { gitControls?: unknown }) => <div>{gitControls as never}</div> }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
let status: "completed" | "working";
const thread = () => ({ id: 2, projectId: 1, title: "Existing", provider: "claude", status, updatedAt: "2026-01-01T00:00:00Z" });
type Args = { threadId: number; comment: Record<string, unknown> };
const calls: { command: string; args: Args }[] = [];
let drafts: Record<string, unknown>[];

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  drafts = [];
  status = "completed";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    const args = payload as Args;
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "git_status") return { branch: "topic", upstream: "origin/topic", ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0, pickerDisabledReason: null, protected: false, unpublished: false };
    if (command === "fetch_project") return true;
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread()];
    if (command === "list_line_comments") return drafts;
    if (command === "send_line_comments") { drafts = []; return null; }
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

const press = (selector: string) => act(async () => host.querySelector<HTMLElement>(selector)!.click());
async function openThread() {
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
}

it("sends the drafts in one action once the Thread is idle", async () => {
  drafts = [{ id: 1, threadId: 2, scope: "uncommitted", path: "src/a.ts", side: "new", line: 1, code: "keep", body: "Why was this renamed?", outdated: false }];
  await openThread();
  const list = host.querySelector('[aria-label="Line comments"]')!;
  expect(list.textContent).toContain("src/a.ts:1");
  expect(list.textContent).toContain("Why was this renamed?");
  await press('[aria-label="Line comments"] .btn.primary');
  expect(calls.filter((c) => c.command === "send_line_comments")).toEqual([{ command: "send_line_comments", args: { threadId: 2 } }]);
  expect(host.querySelector('[aria-label="Line comments"]')).toBeNull();
});

it("offers Send only when the Thread is not working", async () => {
  status = "working";
  drafts = [{ id: 1, threadId: 2, scope: "uncommitted", path: "src/a.ts", side: "new", line: 1, code: "keep", body: "hm", outdated: true }];
  await openThread();
  const send = host.querySelector<HTMLButtonElement>('[aria-label="Line comments"] .btn.primary')!;
  expect(send.disabled).toBe(true);
  expect(host.querySelector('[aria-label="Line comments"]')!.textContent).toContain("Outdated");
});
