// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

type ThreadViewProps = {
  threadId: number;
  initialProvider?: string;
  newThreadFocus?: { threadId: number; id: number } | null;
  onClearThread?: (threadId?: number) => void;
};
const seen = vi.hoisted(() => [] as ThreadViewProps[]);
vi.mock("./ThreadView", () => ({
  ThreadView: (props: ThreadViewProps) => {
    seen.push(props);
    return (
      <div
        data-thread={props.threadId}
        data-provider={props.initialProvider ?? ""}
        data-focus={props.newThreadFocus?.id ?? ""}
      >
        <button type="button" data-clear={props.threadId} onClick={() => props.onClearThread?.(props.threadId)}>
          Clear
        </button>
      </div>
    );
  },
}));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Alpha", path: "/alpha", hidden: false, open: true, missing: false };
const thread = (id: number, provider: string) => ({
  id, projectId: 1, title: `T${id}`, status: "completed", provider,
  updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
  branch: null, worktreePath: null, issueNumber: null,
});

const calls: { command: string; args: unknown }[] = [];
let existingTurns = 0;
let defaultProvider = "antigravity";

beforeEach(() => {
  clearQueryCache();
  seen.length = 0;
  calls.length = 0;
  existingTurns = 0;
  defaultProvider = "antigravity";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return [thread(2, "claude")];
      case "list_turns": return { offset: 0, turns: [], turnCount: existingTurns };
      case "get_settings": return { settings: { defaultProvider, providers: {} }, errors: [] };
      case "create_thread": return thread(3, defaultProvider);
      case "clear_thread": return { ...thread((args as { threadId: number }).threadId, "claude"), title: null };
      case "subscribe_board": return [];
      case "plugin:event|listen": return 1;
      case "remember_selection": return null;
      default: return null;
    }
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
const newThreadButton = () => [...host.querySelectorAll<HTMLButtonElement>(".sidebar-actions button")]
  .find((button) => button.textContent?.includes("New Thread"))!;

it("asks the open empty Thread to focus its composer instead of silently reselecting it", async () => {
  existingTurns = 0;
  await act(async () => root.render(<App />));
  await settle();
  const shown = host.querySelector<HTMLElement>('[data-thread="2"]')!;
  expect(shown).not.toBeNull();
  expect(shown.getAttribute("data-focus")).toBe("");

  await act(async () => newThreadButton().click());
  await settle();

  expect(host.querySelector('[data-thread="2"]')).not.toBeNull();
  expect(Number(host.querySelector<HTMLElement>('[data-thread="2"]')!.getAttribute("data-focus"))).toBeGreaterThan(0);
  expect(calls.some(({ command }) => command === "create_thread")).toBe(false);
});

it("gives a newly created Thread its default Provider before the Transcript loads", async () => {
  existingTurns = 1;
  await act(async () => root.render(<App />));
  await settle();

  await act(async () => newThreadButton().click());
  await settle();

  // The first render of Thread 3 already knows the Provider: no Claude placeholder pass.
  const created = seen.filter((props) => props.threadId === 3);
  expect(created.length).toBeGreaterThan(0);
  expect(created.every((props) => props.initialProvider === "antigravity")).toBe(true);
  expect(host.querySelector<HTMLElement>('[data-thread="3"]')!.getAttribute("data-provider")).toBe("antigravity");
});

it("keeps previous threads open in tabs, supports pinning side by side, and clears the active thread in place", async () => {
  existingTurns = 1;
  await act(async () => root.render(<App />));
  await settle();

  // Open a second thread via New Thread: both thread 2 and thread 3 stay mounted as open tabs.
  await act(async () => newThreadButton().click());
  await settle();
  expect(host.querySelector('[data-thread="2"]')).not.toBeNull();
  expect(host.querySelector('[data-thread="3"]')).not.toBeNull();
  expect(host.querySelectorAll(".open-thread-tab")).toHaveLength(2);

  // Pin thread 2 so both thread 2 and thread 3 are visible side by side simultaneously.
  const pinTwo = host.querySelector<HTMLButtonElement>('[aria-label="Pin T2 side by side"]')!;
  await act(async () => pinTwo.click());
  expect(host.querySelector(".thread-panes")?.classList.contains("split")).toBe(true);
  const panes = [...host.querySelectorAll<HTMLElement>(".thread-pane")];
  expect(panes.filter((p) => !p.hidden)).toHaveLength(2);

  // Running /clear clears the thread in place instead of spawning a new thread.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-clear="3"]')!.click());
  await settle();
  expect(calls.some((c) => c.command === "clear_thread" && (c.args as { threadId: number }).threadId === 3)).toBe(true);

  // Closing tab 2 removes its mounted pane without deleting it.
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close tab T2"]')!.click());
  expect(host.querySelector('[data-thread="2"]')).toBeNull();
  expect(host.querySelectorAll(".open-thread-tab")).toHaveLength(1);
});
