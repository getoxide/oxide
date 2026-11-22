// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./shared/queryCache";
import { saveShortcutOverrides } from "./shared/shortcuts";
import { App } from "./App";

vi.mock("./shared/QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./terminal/TerminalWorkbench", () => ({
  TerminalWorkbench: ({ projectId, contextKey, visible, headerAction }: { projectId: number; contextKey: string; visible: boolean; headerAction?: ReactNode }) => (
    <div className="terminal-workbench" data-project={projectId} data-context={contextKey} data-visible={String(visible)}>
      <textarea className="xterm-helper-textarea" aria-label={`xterm-${contextKey}`} />
      {headerAction}
    </div>
  ),
}));
vi.mock("./pull-requests/PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./issues/IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));
vi.mock("./editor/FilesPanel", () => ({
  FilesPanel: ({ projectId }: { projectId: number }) => <div className="files-panel" data-project={projectId}>Files content</div>,
}));
vi.mock("./editor/CodeWorkbench", () => ({
  CodeWorkbench: ({ projectId, visible, openRequest, onOpenFilesChange, headerAction }: {
    projectId: number; visible: boolean; openRequest: { path: string } | null;
    onOpenFilesChange?: (open: boolean) => void; headerAction?: ReactNode;
  }) => {
    useEffect(() => {
      onOpenFilesChange?.(openRequest !== null);
    }, [openRequest, onOpenFilesChange]);
    return (
      <div className="code-stub" data-project={projectId} data-visible={String(visible)}>
        {headerAction}
      </div>
    );
  },
}));

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

let host: HTMLDivElement;
let root: Root;

const projects = [
  { id: 1, name: "Project Alpha", path: "/alpha", hidden: false, open: true, missing: false },
];

beforeEach(async () => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  clearQueryCache();
  localStorage.clear();
  mockIPC((cmd) => {
    if (cmd === "list_projects" || cmd === "rescan_projects") return projects;
    if (cmd === "last_selection") return 1;
    if (cmd === "developer_tools") return [];
    if (cmd === "plugin:window|is_maximized") return false;
    return null;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<App />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  clearMocks();
});

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

it("dispatches VS Code-inspired default shortcuts across Navigation, Terminals, Surfaces, and Settings", async () => {
  // Mod+, opens Settings
  press({ key: ",", ctrlKey: true });
  expect(host.querySelector('main[aria-label="Settings"]')).not.toBeNull();
  press({ key: ",", ctrlKey: true });
  expect(host.querySelector('main[aria-label="Settings"]')).toBeNull();

  // Mod+Shift+B toggles sidebar
  const sidebar = host.querySelector<HTMLElement>("#workspace-sidebar")!;
  expect(sidebar.hidden).toBe(false);
  press({ key: "B", ctrlKey: true, shiftKey: true });
  expect(sidebar.hidden).toBe(true);
  press({ key: "B", ctrlKey: true, shiftKey: true });
  expect(sidebar.hidden).toBe(false);

  // Mod+\ toggles right dock
  const tools = host.querySelector<HTMLElement>("#workspace-tools")!;
  expect(tools.hidden).toBe(true);
  press({ key: "\\", ctrlKey: true });
  expect(tools.hidden).toBe(false);
  press({ key: "\\", ctrlKey: true });
  expect(tools.hidden).toBe(true);

  // Mod+Shift+I / Mod+Shift+G open Issues / Pull request Surfaces
  press({ key: "I", ctrlKey: true, shiftKey: true });
  expect(tools.hidden).toBe(false);
  await vi.waitFor(() => expect(host.querySelector(".issues-surface")).not.toBeNull());
  press({ key: "G", ctrlKey: true, shiftKey: true });
  await vi.waitFor(() => expect(host.querySelector(".pr-panel")).not.toBeNull());

  // Mod+Shift+E opens Files view
  press({ key: "E", ctrlKey: true, shiftKey: true });
  expect(host.querySelector("#sidebar-files")).not.toBeNull();

  // Mod+Shift+T opens new terminals, PageUp/PageDown switches, Mod+Shift+W closes
  press({ key: "T", ctrlKey: true, shiftKey: true });
  press({ key: "T", ctrlKey: true, shiftKey: true });
  const terms = () => Array.from(host.querySelectorAll<HTMLElement>(".terminal-workbench"));
  expect(terms()).toHaveLength(2);
  expect(terms()[1].dataset.visible).toBe("true");

  press({ key: "PageUp", ctrlKey: true });
  expect(terms()[0].dataset.visible).toBe("true");
  press({ key: "PageDown", ctrlKey: true });
  expect(terms()[1].dataset.visible).toBe("true");

  press({ key: "W", ctrlKey: true, shiftKey: true });
  expect(terms()).toHaveLength(1);
});

it("gives Terminal priority for bare Ctrl+C/R/W when focused unless explicitly rebound", async () => {
  press({ key: "T", ctrlKey: true, shiftKey: true });
  const xtermInput = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
  xtermInput.focus();

  // Bare Ctrl+C, Ctrl+R, Ctrl+W pass through untouched (not defaultPrevented)
  expect(press({ key: "c", ctrlKey: true }, xtermInput).defaultPrevented).toBe(false);
  expect(press({ key: "r", ctrlKey: true }, xtermInput).defaultPrevented).toBe(false);
  expect(press({ key: "w", ctrlKey: true }, xtermInput).defaultPrevented).toBe(false);

  // Explicitly rebinding openSettings to Ctrl+R overrides Terminal priority
  await act(async () => {
    saveShortcutOverrides({ openSettings: "Ctrl+R" });
  });
  const reboundEvent = press({ key: "r", ctrlKey: true }, xtermInput);
  expect(reboundEvent.defaultPrevented).toBe(true);
  expect(host.querySelector('main[aria-label="Settings"]')).not.toBeNull();
});

it("updates tooltips and context menu hints dynamically when shortcuts change", async () => {
  const settingsBtn = host.querySelector<HTMLButtonElement>(".sidebar-footer")!;
  expect(settingsBtn.title).toContain("Ctrl+,");

  await act(async () => {
    saveShortcutOverrides({ openSettings: "Mod+Shift+," });
  });
  expect(settingsBtn.title).toContain("Ctrl+Shift+,");
});
