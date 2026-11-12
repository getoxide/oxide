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
vi.mock("./CodeWorkbench", () => ({ CodeWorkbench: () => <div className="code-workbench">Editor</div> }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => <div className="files-navigation" /> }));
vi.mock("./TerminalSurface", () => ({ TerminalSurface: () => <div className="terminal-surface">Terminal</div> }));
vi.mock("./PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
let scrolledIntoView: Element[] = [];
const project = { id: 1, name: "Oxide", path: "/repo", hidden: false, open: true, missing: false };
const thread = (id: number, title: string) => ({
  id, projectId: 1, provider: "claude", title, status: "completed", updatedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z", branch: null, worktreePath: null, issueNumber: null,
});
const threads = [thread(2, "Alpha work"), thread(3, "Beta work")];

beforeEach(() => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  // jsdom has no scrolling; record the calls so tab focus can be proven to reveal its tab.
  scrolledIntoView = [];
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledIntoView.push(this);
  };
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command) => {
    // console.log("IPC call:", command);
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return threads;
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
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });

it("cycles major visible regions with F6 and Shift+F6 in visual order", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Initially: sidebar and centre are visible; tools dock is closed.
  const toolsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!;
  expect(toolsToggle).toBeTruthy();

  // Focus starts or moves into sidebar
  const searchInput = host.querySelector<HTMLInputElement>('.sidebar-search input')!;
  searchInput.focus();
  expect(document.activeElement).toBe(searchInput);

  // F6 from Sidebar moves to Centre (composer)
  await press("F6");
  const composer = host.querySelector<HTMLElement>('[role="textbox"]')!;
  expect(document.activeElement).toBe(composer);

  // F6 from Centre moves to Dock handle since dock is closed
  await press("F6");
  expect(document.activeElement).toBe(toolsToggle);

  // F6 from Dock handle wraps around to Sidebar
  await press("F6");
  expect(document.activeElement?.closest("#workspace-sidebar")).not.toBeNull();

  // Shift+F6 cycles backwards: Sidebar -> Dock handle -> Centre -> Sidebar
  await press("F6", { shiftKey: true });
  expect(document.activeElement).toBe(toolsToggle);

  await press("F6", { shiftKey: true });
  expect(document.activeElement).toBe(composer);

  await press("F6", { shiftKey: true });
  expect(document.activeElement?.closest("#workspace-sidebar")).not.toBeNull();
});

it("cycles through the dock's Surfaces and restores focus deliberately when collapsing/restoring", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const toolsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!;
  // Open the dock
  await act(async () => toolsToggle.click());
  await settle();

  const firstTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!;
  expect(firstTab).toBeTruthy();
  expect(firstTab.getAttribute("aria-selected")).toBe("true");
  expect(firstTab.getAttribute("tabindex")).toBe("0");

  // Surface headers rove focus with ArrowRight
  firstTab.focus();
  const tabsNav = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Surfaces"]')!;
  await act(async () => {
    tabsNav.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  });
  await settle();

  const nextTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Terminal"]')!;
  expect(nextTab.getAttribute("aria-selected")).toBe("true");

  // Collapsing a focused dock moves focus to its handle
  await press("\\", { ctrlKey: true });
  await settle();
  expect(document.activeElement).toBe(toolsToggle);

  // Restoring the dock deliberately restores focus into the dock
  await press("\\", { ctrlKey: true });
  await settle();
  expect(document.activeElement?.getAttribute("role")).toBe("tab");
});

it("shows every Surface's icon and label inside a strip that leaves the utility controls pinned", async () => {
  await act(async () => root.render(<App />));
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!.click());
  await settle();

  const nav = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Surfaces"]')!;
  // The strip is the single region the tabs live in; everything else in the header is utility chrome.
  const regionOf = (node: Element) => {
    let region = node as HTMLElement;
    while (region.parentElement && region.parentElement !== nav) region = region.parentElement!;
    return region;
  };
  const firstTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!;
  const strip = regionOf(firstTab);
  expect(strip).not.toBe(nav);

  // Labels never depend on whether the tab is active: both states keep icon + label.
  for (const name of ["Files", "Terminal", "Pull request", "Issues"]) {
    const tab = host.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${name}"]`)!;
    expect(tab).not.toBeNull();
    expect(strip.contains(tab)).toBe(true);
    expect(tab.querySelector("svg.octicon")).not.toBeNull();
    expect(tab.textContent?.trim()).toBe(name);
    // The label is its own element and carries the Surface name, so dropping it fails here.
    const label = tab.querySelector<HTMLElement>(".tool-tab-label")!;
    expect(label).not.toBeNull();
    expect(label.textContent).toBe(name);
  }

  // Maximize/Restore and Close sit after the scrolling strip, not inside it, so they stay reachable.
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Terminal"]')!.click());
  await settle();
  // The previously active tab keeps its label once it goes inactive.
  expect(firstTab.getAttribute("aria-selected")).toBe("false");
  expect(firstTab.textContent?.trim()).toBe("Files");
  // The maximize control belongs to the Files Surface.
  await act(async () => firstTab.click());
  await settle();
  const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close tools panel"]')!;
  const maximize = host.querySelector<HTMLButtonElement>('button[aria-label="Maximize Surface"]')!;
  const actions = regionOf(close);
  expect(actions).not.toBe(strip);
  expect(strip.contains(close)).toBe(false);
  expect(strip.contains(maximize)).toBe(false);
  expect(actions).toBe(regionOf(maximize));
  expect([...nav.children].indexOf(actions)).toBeGreaterThan([...nav.children].indexOf(strip));
});

it("scrolls the focused tab into view for every roving keyboard move", async () => {
  await act(async () => root.render(<App />));
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!.click());
  await settle();

  const nav = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Surfaces"]')!;
  const firstTab0 = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!;
  firstTab0.focus();

  const focusAndDispatch = async (key: string) => {
    scrolledIntoView = [];
    await act(async () => {
      nav.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle();
    return nav.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
  };

  const terminalTab = await focusAndDispatch("ArrowRight");
  expect(terminalTab.getAttribute("aria-label")).toBe("Terminal");
  expect(document.activeElement).toBe(terminalTab);
  expect(scrolledIntoView).toContain(terminalTab);

  const issuesTab = await focusAndDispatch("End");
  expect(issuesTab.getAttribute("aria-label")).toBe("Issues");
  expect(scrolledIntoView).toContain(issuesTab);

  const firstTab = await focusAndDispatch("Home");
  expect(firstTab.getAttribute("aria-label")).toBe("Files");
  expect(scrolledIntoView).toContain(firstTab);
});

it("scrolls a Surface selected by its shortcut accelerator into view", async () => {
  await act(async () => root.render(<App />));
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!.click());
  await settle();

  // Pull request is the far end of the strip, so selecting it by accelerator must reveal it.
  scrolledIntoView = [];
  await press("P", { ctrlKey: true, shiftKey: true });
  await settle();

  const pullRequestTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Pull request"]')!;
  expect(pullRequestTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(pullRequestTab);
  expect(scrolledIntoView).toContain(pullRequestTab);
});

it("handles Escape hierarchy: closes topmost overlay, else restores maximization", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Open dock and maximize it
  const toolsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!;
  await act(async () => toolsToggle.click());
  await settle();

  // Full screen is for browsing: no button on Terminal, but the Files navigator can widen.
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Terminal"]')!.click());
  await settle();
  expect(host.querySelector('button[aria-label="Maximize Surface"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!.click());
  await settle();
  const maxBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Maximize Surface"]')!;
  await act(async () => maxBtn.click());
  await settle();

  // Thread is hidden, thread-restore-handle is shown
  expect(host.querySelector('.thread-restore-handle')).not.toBeNull();

  // Open Project palette overlay (Mod+Shift+N)
  await press("N", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('.palette')).not.toBeNull();

  // Escape closes overlay first, Surface stays maximized
  await press("Escape");
  await settle();
  expect(host.querySelector('.palette')).toBeNull();
  expect(host.querySelector('.thread-restore-handle')).not.toBeNull();

  // Second Escape restores maximization
  await press("Escape");
  await settle();
  expect(host.querySelector('.thread-restore-handle')).toBeNull();
  expect(host.querySelector('[role="textbox"]')).not.toBeNull();
});

it("collapsing and restoring sidebar moves focus to handle and back into sidebar", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const searchInput = host.querySelector<HTMLInputElement>('.sidebar-search input')!;
  searchInput.focus();
  expect(document.activeElement).toBe(searchInput);

  // Collapse sidebar with Mod+Shift+E
  await press("E", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('#workspace-sidebar')?.hasAttribute("hidden")).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('button[aria-label="Toggle sidebar"]'));

  // Restore sidebar with Mod+Shift+E deliberately restores focus into sidebar
  await press("E", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('#workspace-sidebar')?.hasAttribute("hidden")).toBe(false);
  expect(document.activeElement?.closest('#workspace-sidebar')).not.toBeNull();
});

it("surface shortcut actions select the single Surface and move focus", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Terminal shortcut Mod+Shift+T
  await press("T", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");

  // Files shortcut Mod+Shift+F
  await press("F", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Files"]')?.getAttribute("aria-selected")).toBe("true");

  // Issues shortcut Mod+Shift+I
  await press("I", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Issues"]')?.getAttribute("aria-selected")).toBe("true");

  // Pull request shortcut Mod+Shift+P
  await press("P", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Pull request"]')?.getAttribute("aria-selected")).toBe("true");
});

it("overlay dismissal returns focus to the invoker element", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const openProjectBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Open a Project"]')!;
  openProjectBtn.focus();
  expect(document.activeElement).toBe(openProjectBtn);

  // Click Open a Project
  await act(async () => openProjectBtn.click());
  await settle();
  expect(host.querySelector('.palette')).not.toBeNull();

  // Press Escape to dismiss
  await press("Escape");
  await settle();
  expect(host.querySelector('.palette')).toBeNull();
  expect(document.activeElement).toBe(openProjectBtn);
});
