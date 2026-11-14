// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { App } from "./App";

vi.mock("./ThreadView", () => ({
  ThreadView: ({ threadId }: { threadId: number }) => <div>
    <span data-testid="thread">{threadId}</span>
    <div role="textbox" contentEditable aria-label="Message" suppressContentEditableWarning />
    {threadId === 20 && <div aria-label="Approval" className="approval-card pending"><button className="approval-btn allow">Allow</button></div>}
  </div>,
}));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const container = document.createElement("div"); document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

const project = (id: number, name: string) => ({ id, name, path: `/${name}`, hidden: false, open: true, missing: false });
const thread = (id: number, projectId: number, status: string, extra: { title?: string; branch?: string } = {}) => ({
  id, projectId, title: extra.title ?? `T${id}`, status, provider: "codex", updatedAt: "2026-01-01T00:00:00Z",
  branch: extra.branch ?? null, worktreePath: extra.branch ? `/wt/${extra.branch}` : null,
});
const card = (t: ReturnType<typeof thread>, approvals = 0) => ({
  thread: t, pullRequest: null,
  pendingApprovals: Array.from({ length: approvals }, () => ({ approvalId: "a1", kind: "command", summary: "rm", options: [] })),
});

type Thread = ReturnType<typeof thread>;
type BoardCard = ReturnType<typeof card>;
function setup(fixture?: { threads?: Record<number, Thread[]>; boards?: Record<number, BoardCard[]> }) {
  const channels: Record<number, { onmessage: (event: unknown) => void }> = {};
  const threads: Record<number, Thread[]> = fixture?.threads ?? { 1: [thread(10, 1, "working")], 2: [thread(20, 2, "needs-input")] };
  mockIPC((command, args) => {
    const a = args as { projectId?: number; onEvent?: { onmessage: (event: unknown) => void } };
    if (command === "list_projects" || command === "rescan_projects") return [project(1, "Alpha"), project(2, "Beta")];
    if (command === "last_selection") return { projectId: 1, threadId: 10 };
    if (command === "list_threads") return threads[a.projectId!];
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "subscribe_board") {
      channels[a.projectId!] = a.onEvent!;
      return fixture?.boards?.[a.projectId!] ?? (a.projectId === 2 ? [card(threads[2][0], 1)] : [card(threads[1][0])]);
    }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  return channels;
}
const shownThread = () => container.querySelector('[data-testid="thread"]')?.textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});

/** Alpha has an error, an interrupted Thread and a plain question; Beta has a pending Approval on a branch. */
function richSetup() {
  const threads: Record<number, Thread[]> = {
    1: [
      thread(10, 1, "working", { title: "Alpha work" }),
      thread(11, 1, "error", { title: "Build failed", branch: "fix/build" }),
      thread(12, 1, "interrupted", { title: "Lost session" }),
      thread(13, 1, "needs-input", { title: "Waiting on prompt" }),
    ],
    2: [thread(20, 2, "needs-input", { title: "Release check", branch: "feat/beta" })],
  };
  return setup({
    threads,
    boards: { 1: threads[1].map((t) => card(t)), 2: [card(threads[2][0], 1)] },
  });
}

it("jumps straight to the most urgent item from the keyboard", async () => {
  richSetup();
  await act(async () => root.render(<App />));
  expect(shownThread()).toBe("10");
  await press("a", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(shownThread()).toBe("20");
  expect(document.activeElement?.className).toContain("approval-btn");
});
