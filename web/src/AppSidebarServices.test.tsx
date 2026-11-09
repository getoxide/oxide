// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: () => <div data-thread-view /> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./TerminalSurface", () => ({ TerminalSurface: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} },
});
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

const project = { id: 1, name: "Alpha", path: "/alpha", hidden: false, open: true, missing: false };
const thread = {
  id: 2, projectId: 1, title: "Feature", status: "completed", provider: "claude",
  updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
  branch: null, worktreePath: null, issueNumber: null,
};
const service = {
  id: 9, projectId: 1, threadId: null, command: "npm run dev", checkout: "/alpha",
  status: "running", pid: 900, port: 5173, url: "http://localhost:5173",
  startedAt: "2026-01-01T00:00:00Z", exitCode: null,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command) => {
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return [thread];
      case "list_turns": return { offset: 0, turns: [], turnCount: 0 };
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
      case "subscribe_board": return [];
      case "list_project_services": return [service];
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

it("pins the Project Services widget above the Settings button in the sidebar", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const sidebar = host.querySelector(".sidebar")!;
  const widget = sidebar.querySelector(".project-services");
  const footer = sidebar.querySelector(".sidebar-footer");
  expect(widget).not.toBeNull();
  expect(widget?.textContent).toContain("npm run dev");
  expect(widget?.textContent).toContain(":5173");
  expect(footer).not.toBeNull();
  // The widget sits between the scroll area and Settings, so it stays pinned.
  expect(widget!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sidebar.querySelector(".sidebar-scroll")!.compareDocumentPosition(widget!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
