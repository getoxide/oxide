// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { DEFAULT_SHORTCUTS } from "./shortcuts";
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
const projects = [
  { id: 1, name: "Alpha", path: "/alpha", hidden: false, open: true, missing: false },
  { id: 2, name: "Beta", path: "/beta", hidden: false, open: true, missing: false },
];
const thread = (id: number, provider: string, projectId = 1) => ({
  id, projectId, title: `T${id}`, status: "completed", provider,
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
      case "list_projects": case "rescan_projects": return projects;
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": {
        const pid = (args as { projectId?: number })?.projectId ?? 1;
        return pid === 2 ? [thread(20, "claude", 2)] : [thread(2, "claude", 1)];
      }
      case "list_turns": return { offset: 0, turns: [], turnCount: existingTurns };
      case "get_settings":
        return {
          settings: {
            defaultProvider,
            confirmQuit: true,
            deleteMergedBranches: false,
            shortcuts: DEFAULT_SHORTCUTS,
            claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
            providers: {
              claude: { model: null, effort: null, permissionMode: "ask" },
              codex: { model: null, effort: null, permissionMode: "auto-edit" },
              antigravity: { model: null, effort: null, permissionMode: "auto-edit" },
            },
          },
          errors: [],
        };
      case "get_model_catalog": return [];
      case "detect_provider": return { installed: false, authenticated: false, available: false };
      case "create_thread": return thread(3, defaultProvider, (args as { projectId?: number })?.projectId ?? 1);
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

it("keeps multiple projects expanded in the sidebar, clears threads in place, and exits settings on New Thread", async () => {
  existingTurns = 1;
  await act(async () => root.render(<App />));
  await settle();

  // Alpha starts expanded with its thread list; expanding Beta keeps Alpha expanded too.
  const alphaBtn = host.querySelector<HTMLButtonElement>('button.project[title*="alpha"]')!;
  const betaBtn = host.querySelector<HTMLButtonElement>('button.project[title*="beta"]')!;
  expect(alphaBtn.getAttribute("aria-expanded")).toBe("true");
  expect(betaBtn.getAttribute("aria-expanded")).toBe("false");

  await act(async () => betaBtn.click());
  await settle();
  expect(alphaBtn.getAttribute("aria-expanded")).toBe("true");
  expect(betaBtn.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('ul.thread-list[aria-label="Thread list for Alpha"]')).not.toBeNull();
  expect(host.querySelector('ul.thread-list[aria-label="Thread list for Beta"]')).not.toBeNull();
  expect(host.querySelector('[data-thread="20"]')).not.toBeNull();

  // Clicking a thread inside another expanded project switches to that project and thread while keeping both expanded.
  const alphaThread = host.querySelector<HTMLButtonElement>('ul.thread-list[aria-label="Thread list for Alpha"] .thread-item')!;
  await act(async () => alphaThread.click());
  await settle();
  expect(host.querySelector('[data-thread="2"]')).not.toBeNull();
  expect(alphaBtn.getAttribute("aria-expanded")).toBe("true");
  expect(betaBtn.getAttribute("aria-expanded")).toBe("true");

  // Running /clear clears the active thread in place instead of spawning a new thread.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-clear="2"]')!.click());
  await settle();
  expect(calls.some((c) => c.command === "clear_thread" && (c.args as { threadId: number }).threadId === 2)).toBe(true);

  // Open Settings, then click New Thread in the sidebar: Settings closes and creates Thread 3.
  await act(async () => host.querySelector<HTMLButtonElement>(".sidebar-footer")!.click());
  for (let i = 0; i < 40 && !host.querySelector('main.settings[aria-label="Settings"]'); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  expect(host.querySelector('main.settings[aria-label="Settings"]')).not.toBeNull();

  await act(async () => newThreadButton().click());
  await settle();
  expect(host.querySelector('main.settings[aria-label="Settings"]')).toBeNull();
  expect(host.querySelector('[data-thread="3"]')).not.toBeNull();
});
