// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./shared/queryCache";
import { App } from "./App";
import { revealInFileManagerLabel } from "./shared/platform";
import stylesCss from "./styles/styles.css?raw";
import interactionsCss from "./styles/interactions.css?raw";
import workbenchCss from "./styles/workbench.css?raw";
import appearanceCss from "./styles/appearance.css?raw";

const failingOpens = vi.hoisted(() => ({ current: false }));
vi.mock("./shared/QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./terminal/TerminalWorkbench", () => ({
  TerminalWorkbench: ({ projectId, contextKey, visible, headerAction }: { projectId: number; contextKey: string; visible: boolean; headerAction?: ReactNode }) => (
    <div className="terminal-stub" data-project={projectId} data-context={contextKey} data-visible={String(visible)}>{headerAction}</div>
  ),
}));
vi.mock("./pull-requests/PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./issues/IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));
vi.mock("./editor/FilesPanel", () => ({
  FilesPanel: ({ projectId, onOpenFile }: { projectId: number; onOpenFile: (path: string) => void }) => (
    <div className="files-panel" data-project={projectId} onDoubleClick={() => onOpenFile("src/main.ts")}>Files content</div>
  ),
}));
vi.mock("./editor/CodeWorkbench", () => ({
  CodeWorkbench: ({ projectId, visible, openRequest, onOpenFilesChange, onOpenFailed, headerAction }: {
    projectId: number; visible: boolean; openRequest: { path: string } | null; onOpenFilesChange?: (open: boolean) => void;
    onOpenFailed?: () => void; headerAction?: ReactNode;
  }) => {
    useEffect(() => {
      // A file that fails to load never reports an open file; the workbench says so instead.
      if (openRequest && failingOpens.current) onOpenFailed?.();
      else onOpenFilesChange?.(openRequest !== null);
    }, [openRequest, onOpenFilesChange, onOpenFailed]);
    return (
      <div className="code-stub" data-project={projectId} data-visible={String(visible)}>
        {openRequest?.path}
        <button className="code-stub-close" onClick={() => onOpenFilesChange?.(false)}>close last</button>
        {headerAction}
      </div>
    );
  },
}));

const observers: { element: Element; callback: ResizeObserverCallback }[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class {
  constructor(private callback: ResizeObserverCallback) {}
  observe(element: Element) { observers.push({ element, callback: this.callback }); }
  disconnect() {}
} });

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
  localStorage.clear();
  failingOpens.current = false;
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
const rowOf = (project: string) => all(".project-row").find((row) => row.textContent?.includes(project))!;
const menuLabel = (node: Element) => node.querySelector("span")?.textContent ?? node.textContent;
/** Right-clicks a Project row and picks an entry of the menu that opens. */
const fromMenu = async (project: string, entry: string) => {
  await act(async () => { rowOf(project).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 })); });
  const item = all('[role="menuitem"]').find((node) => menuLabel(node) === entry);
  expect(item, `menu entry ${entry}`).toBeDefined();
  await click(item!);
};
const newTerminal = (project: string) => fromMenu(project, "New terminal");
const removeProject = (project: string) => fromMenu(project, "Close project");
/** The Files button on a Project row, beside its +. */
const filesButton = (index: number) => all(".project-row")[index].querySelector<HTMLButtonElement>(".project-files")!;
const openFiles = async (index: number) => click(filesButton(index));
/** The Files view's header button that returns to the Terminals view. */
const backToTerminals = () => label("Back to Terminals");
const visibleTerminals = () => all(".terminal-stub").filter((node) => node.dataset.visible === "true");

it("lists the open Projects with their terminals and no empty-list placeholder", () => {
  expect(all(".project-name").map((node) => node.textContent)).toEqual(["Project Alpha", "Project Beta"]);
  expect(terminalNames("Project Alpha")).toEqual([]);
  expect(host.textContent).not.toContain("No terminals");
  expect(q('[aria-label="Terminals of Project Alpha"]')?.children.length).toBe(0);
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
  await newTerminal("Project Alpha");
  await newTerminal("Project Alpha");
  await newTerminal("Project Alpha");
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
  const before = all(".terminal-stub");
  expect(before).toHaveLength(3);
  expect(visibleTerminals()[0].dataset.context).toBe("1:3");

  await click(all('[aria-label="Terminals of Project Alpha"] .terminal-item')[0]);

  expect(all(".terminal-stub")).toEqual(before);
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["1:1"]);
});

it("keeps each Project's terminals apart and shows the selected one", async () => {
  await newTerminal("Project Alpha");
  await newTerminal("Project Beta");
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["2:1"]);
  await click(all(".project")[0]);
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["1:1"]);
  expect(all(".terminal-stub")).toHaveLength(2);
});

it("renames a terminal by double-clicking it", async () => {
  await newTerminal("Project Alpha");
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
  await newTerminal("Project Alpha");
  await newTerminal("Project Alpha");
  await click(label("Close Terminal 2"));
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1"]);
  expect(all(".terminal-stub")).toHaveLength(1);
  expect(visibleTerminals()[0].dataset.context).toBe("1:1");
});

it("closing a Project ends its terminals and asks Core to keep it known but closed", async () => {
  await newTerminal("Project Alpha");
  await newTerminal("Project Beta");
  await removeProject("Project Alpha");
  expect(calls.some((call) => call.command === "set_project_open" && JSON.stringify(call.args) === JSON.stringify({ id: 1, open: false }))).toBe(true);
  expect(all(".terminal-stub").map((node) => node.dataset.project)).toEqual(["2"]);
});

it("toggles the right dock open and closed at once, with no transition under any motion preference", async () => {
  const dock = q<HTMLElement>("#workspace-tools")!;
  expect(dock.hidden).toBe(true);
  await click(label("Toggle tools panel"));
  expect(dock.hidden).toBe(false);
  await click(label("Toggle tools panel"));
  expect(dock.hidden).toBe(true);

  // Any rule naming the dock itself (`.tools`, `.tools[hidden]`) must not animate it.
  for (const css of [stylesCss, interactionsCss, workbenchCss, appearanceCss]) {
    expect(css.length).toBeGreaterThan(0);
    const dockRules = [...css.matchAll(/(?:^|[},])\s*\.tools(?:\[hidden\])?\s*\{([^}]*)\}/g)].map((match) => match[1]);
    for (const body of dockRules) expect(body).not.toMatch(/transition|animation|translate|opacity: 0|allow-discrete/);
    expect(css).not.toMatch(/@starting-style\s*\{[^}]*\.tools\b/);
  }
});

it("gives the right dock only Issues and Pull request, Issues first, without naming Files", async () => {
  await click(label("Toggle tools panel"));
  expect(all('.tools [role="tab"]').map((tab) => tab.getAttribute("aria-label"))).toEqual(["Issues", "Pull request"]);
  expect(q('.tools [role="tab"][aria-selected="true"]')?.getAttribute("aria-label")).toBe("Issues");
  expect(host.textContent).toContain("Issues content");
  expect(q(".files-panel")).toBeNull();
  await click(label("Pull request"));
  expect(host.textContent).toContain("PR content");
  await click(label("Issues"));
  expect(host.textContent).toContain("Issues content");
});

it("describes the empty dock without naming Files", async () => {
  await act(async () => root.unmount());
  mockIPC((command) => (command === "list_projects" || command === "rescan_projects" ? [] : null));
  root = createRoot(host);
  await act(async () => root.render(<App />));
  await click(label("Toggle tools panel"));
  expect(host.textContent).toContain("The right dock holds Issues and Pull request");
  expect(host.textContent).not.toContain("holds Files");
});

it("has no Sidebar switch: a Project row's Files button opens its Files view and the header returns", async () => {
  expect(q('[role="tablist"][aria-label="Sidebar view"]')).toBeNull();
  expect(all('#workspace-sidebar [role="tab"]')).toHaveLength(0);
  expect(all(".files-panel")).toHaveLength(0);
  expect(filesButton(1).getAttribute("aria-label")).toBe("Files of Project Beta");
  await openFiles(1);
  expect(all(".files-panel").map((node) => node.dataset.project)).toEqual(["2"]);
  expect(q<HTMLElement>('nav[aria-label="Projects"]')?.hidden).toBe(true);
  expect(q('nav[aria-label="Files"]')?.textContent).toContain("Project Beta");
  expect(backToTerminals()?.textContent).toContain("Project Beta");
  expect(backToTerminals()?.textContent).toContain("Terminals");
  await click(backToTerminals());
  expect(all(".files-panel")).toHaveLength(0);
  expect(q<HTMLElement>('nav[aria-label="Projects"]')?.hidden).toBe(false);
  expect(all(".project")[1].getAttribute("aria-current")).toBe("true");
});

it("disables a Project row's Files button while its folder is missing", async () => {
  await act(async () => root.unmount());
  projects[1].missing = true;
  try {
    root = createRoot(host);
    await act(async () => root.render(<App />));
    expect(filesButton(0).disabled).toBe(false);
    expect(filesButton(1).disabled).toBe(true);
  } finally {
    projects[1].missing = false;
  }
});

it("opens a file from the Files view in the Code workspace on double click", async () => {
  await openFiles(0);
  await act(async () => { q(".files-panel")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(q<HTMLElement>(".code-stub")?.dataset.visible).toBe("true");
  expect(q(".code-stub")?.textContent).toContain("src/main.ts");
});

const openFile = async (index = 0) => {
  await openFiles(index);
  await act(async () => { q(".files-panel")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};
const codeVisible = (index = 0) => all(".code-stub")[index]?.dataset.visible === "true";

it("splits the centre into Terminal and Code when a file opens, and closes the Code half with the last file", async () => {
  await newTerminal("Project Alpha");
  expect(q<HTMLElement>(".centre-code-half")?.hidden).toBe(true);
  await openFile();
  expect(codeVisible()).toBe(true);
  expect(visibleTerminals()).toHaveLength(1);
  expect(q(".centre-terminal-half")?.hasAttribute("hidden")).toBe(false);
  expect(q('[role="separator"][aria-label="Resize Terminal and Code"]')).not.toBeNull();
  await click(q(".code-stub-close"));
  expect(codeVisible()).toBe(false);
  expect(q('[role="separator"][aria-label="Resize Terminal and Code"]')).toBeNull();
  expect(visibleTerminals()).toHaveLength(1);
});

it("keeps the open file when switching Terminals and removes Back to terminals", async () => {
  await newTerminal("Project Alpha");
  await newTerminal("Project Alpha");
  await openFile();
  expect(host.textContent).not.toContain("Back to terminals");
  await click(all('[aria-label="Terminals of Project Alpha"] .terminal-item')[0]);
  expect(codeVisible()).toBe(true);
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["1:1"]);
});

it("shows the Code workspace full width without Terminals, then splits when a Terminal opens", async () => {
  await openFile();
  expect(codeVisible()).toBe(true);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(true);
  expect(host.textContent).not.toContain("No terminal open");
  expect(q('[role="separator"][aria-label="Resize Terminal and Code"]')).toBeNull();
  await newTerminal("Project Alpha");
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(false);
  expect(codeVisible()).toBe(true);
  expect(visibleTerminals()).toHaveLength(1);
  expect(q('[role="separator"][aria-label="Resize Terminal and Code"]')).not.toBeNull();
});

it("keeps each Project's Code workspace mounted when moving between Projects", async () => {
  await newTerminal("Project Alpha");
  await openFile(0);
  const stub = all(".code-stub")[0];
  await click(all(".project")[1]);
  expect(all(".code-stub")[0]).toBe(stub);
  expect(codeVisible()).toBe(false);
  await click(all(".project")[0]);
  expect(codeVisible()).toBe(true);
});

it("resets the divider to 50/50 on double click", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  const divider = q<HTMLElement>('[role="separator"][aria-label="Resize Terminal and Code"]')!;
  const before = divider.getAttribute("aria-valuenow");
  await act(async () => { divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  expect(divider.getAttribute("aria-valuenow")).not.toBe(before);
  await act(async () => { divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(divider.getAttribute("aria-valuenow")).toBe(before);
  expect(Number(divider.getAttribute("aria-valuemin"))).toBe(360);
});

it("maximizes a half without unmounting the other, and restores the split", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  const terminal = q(".terminal-stub");
  const code = q(".code-stub");
  await click(label("Maximize Code"));
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(true);
  expect(codeVisible()).toBe(true);
  expect(q(".terminal-stub")).toBe(terminal);
  expect(label("Maximize Code")).toBeNull();
  await click(label("Restore Terminal and Code"));
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(false);
  expect(visibleTerminals()).toHaveLength(1);
  await click(label("Maximize Terminal"));
  expect(q<HTMLElement>(".centre-code-half")?.hidden).toBe(true);
  expect(q(".code-stub")).toBe(code);
  expect(codeVisible()).toBe(false);
});

it("offers no maximize button while only one half exists", async () => {
  await newTerminal("Project Alpha");
  expect(label("Maximize Terminal")).toBeNull();
  expect(label("Maximize Code")).toBeNull();
});

const dividerNow = () => q('[role="separator"][aria-label="Resize Terminal and Code"]')?.getAttribute("aria-valuenow");
const nudgeDivider = () => act(async () => {
  q('[role="separator"][aria-label="Resize Terminal and Code"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
});

it("gives each Project its own divider and maximized half, restored when it is selected again", async () => {
  await newTerminal("Project Alpha");
  await openFile(0);
  const alphaDefault = dividerNow();
  await nudgeDivider();
  const alphaMoved = dividerNow();
  expect(alphaMoved).not.toBe(alphaDefault);
  await click(label("Maximize Code"));
  await newTerminal("Project Beta");
  expect(label("Maximize Code")).toBeNull();
  expect(visibleTerminals().map((node) => node.dataset.project)).toEqual(["2"]);
  await click(all(".project")[0]);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(true);
  expect(codeVisible()).toBe(true);
  await click(label("Restore Terminal and Code"));
  expect(dividerNow()).toBe(alphaMoved);
});

const reload = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};

it("with session restore off, keeps the divider and the maximized half across a reload, but no Terminals or files", async () => {
  localStorage.setItem("oxide:restore-session:v1", "false");
  await newTerminal("Project Alpha");
  await openFile(0);
  await nudgeDivider();
  const moved = dividerNow();
  await click(label("Maximize Terminal"));
  await reload();
  expect(all(".terminal-stub")).toHaveLength(0);
  await newTerminal("Project Alpha");
  expect(all(".code-stub")).toHaveLength(0);
  await openFile(0);
  expect(dividerNow()).toBe(moved);
});

it("with session restore on, reopens the Terminals with their names and the Code workspace", async () => {
  await newTerminal("Project Alpha");
  await newTerminal("Project Alpha");
  await openFile(0);
  await reload();
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1", "Terminal 2"]);
  expect(visibleTerminals().map((node) => node.dataset.context)).toEqual(["1:2"]);
  expect(all(".code-stub").map((node) => node.dataset.project)).toEqual(["1"]);
  await newTerminal("Project Alpha");
  expect(terminalNames("Project Alpha")).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
});

it("opens a Terminal in a Project at once with the + beside its name", async () => {
  await click(label("New terminal in Project Beta"));
  expect(terminalNames("Project Beta")).toEqual(["Terminal 1"]);
  expect(all(".project")[1].getAttribute("aria-current")).toBe("true");
  expect(visibleTerminals().map((node) => node.dataset.project)).toEqual(["2"]);
});

it("forgets a closed Terminal's saved blocks", async () => {
  await newTerminal("Project Alpha");
  localStorage.setItem("oxide:terminal-session:1:1", JSON.stringify({ cwd: null, blocks: [] }));
  await click(label("Close Terminal 1"));
  expect(localStorage.getItem("oxide:terminal-session:1:1")).toBeNull();
});

it("restores the split when the hidden half is chosen explicitly", async () => {
  await newTerminal("Project Alpha");
  await newTerminal("Project Alpha");
  await openFile();
  await click(label("Maximize Code"));
  await click(all('[aria-label="Terminals of Project Alpha"] .terminal-item')[0]);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(false);
  expect(codeVisible()).toBe(true);
  await click(label("Maximize Terminal"));
  expect(codeVisible()).toBe(false);
  await openFile();
  expect(codeVisible()).toBe(true);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(false);
});

it("leaves the Files view when another route selects a Project", async () => {
  await openFiles(0);
  expect(all(".files-panel")).toHaveLength(1);
  await newTerminal("Project Beta");
  expect(all(".files-panel")).toHaveLength(0);
  expect(all(".project")[1].getAttribute("aria-current")).toBe("true");
});

it("toggles a Project's Terminals and selects it when its name is clicked, with no chevron", async () => {
  const alpha = () => all(".project")[0];
  const beta = () => all(".project")[1];
  expect(all(".project-chevron")).toHaveLength(0);
  expect(alpha().getAttribute("aria-current")).toBe("true");
  expect(beta().getAttribute("aria-expanded")).toBe("true");

  await click(beta());
  expect(beta().getAttribute("aria-current")).toBe("true");
  expect(alpha().getAttribute("aria-current")).toBe("false");
  expect(beta().getAttribute("aria-expanded")).toBe("false");
  expect(beta().classList.contains("open")).toBe(false);

  await click(beta());
  expect(beta().getAttribute("aria-current")).toBe("true");
  expect(beta().getAttribute("aria-expanded")).toBe("true");
  expect(beta().classList.contains("open")).toBe(true);
});

it("marks only the active Project's row as selected, and moves the mark with the selection", async () => {
  expect(rowOf("Project Alpha").dataset.selected).toBe("true");
  expect(rowOf("Project Beta").dataset.selected).toBeUndefined();
  await click(all(".project")[1]);
  expect(rowOf("Project Beta").dataset.selected).toBe("true");
  expect(rowOf("Project Alpha").dataset.selected).toBeUndefined();
});

it("shows a collapsed Project's terminal count and keeps its icon dim", async () => {
  await newTerminal("Project Alpha");
  await click(all(".project")[0]);
  expect(all(".project")[0].classList.contains("open")).toBe(false);
  expect(rowOf("Project Alpha").querySelector(".project-count")?.textContent).toBe("1");
});

it("closes a Project from its menu, with no × on its row, ending its terminals, removing it from the sidebar, and updating selection", async () => {
  const stateful = projects.map((project) => ({ ...project }));
  await act(async () => root.unmount());
  clearQueryCache();
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "list_projects": case "rescan_projects": return stateful;
      case "last_selection": return 1;
      case "set_project_open": {
        const { id, open } = args as { id: number; open: boolean };
        const target = stateful.find((project) => project.id === id);
        if (target) target.open = open;
        return target ?? null;
      }
      case "plugin:event|listen": return 1;
      default: return null;
    }
  });
  root = createRoot(host);
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  await newTerminal("Project Alpha");
  await newTerminal("Project Beta");
  await click(q('[aria-label="Terminals of Project Alpha"] .terminal-item'));
  expect(all(".project")[0].getAttribute("aria-current")).toBe("true");
  expect(label("Close Project Alpha")).toBeNull();
  expect(Array.from(rowOf("Project Alpha").querySelectorAll(".row-action")).map((node) => node.getAttribute("aria-label")))
    .toEqual(["Files of Project Alpha", "New terminal in Project Alpha"]);
  expect(Array.from(q('[aria-label="Terminals of Project Alpha"]')!.querySelectorAll(".row-action")).map((node) => node.getAttribute("aria-label")))
    .toEqual(["Close Terminal 1"]);

  await removeProject("Project Alpha");
  expect(calls.some((call) => call.command === "set_project_open" && JSON.stringify(call.args) === JSON.stringify({ id: 1, open: false }))).toBe(true);
  expect(all(".project-name").map((node) => node.textContent)).toEqual(["Project Beta"]);
  expect(all(".project")[0].getAttribute("aria-current")).toBe("true");
  expect(all(".terminal-stub").map((node) => node.dataset.project)).toEqual(["2"]);
  expect(stateful.find((project) => project.id === 1)?.open).toBe(false);
});

it("offers enriched context actions on a Project row's menu and invokes Reveal and Copy path", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const revealLabel = revealInFileManagerLabel();
  await act(async () => { rowOf("Project Beta").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  expect(all('[role="menuitem"]').map(menuLabel)).toEqual([
    "New terminal",
    "Open Files",
    revealLabel,
    "Copy path",
    "Close project",
  ]);

  await click(all('[role="menuitem"]').find((node) => menuLabel(node) === revealLabel)!);
  expect(calls.some((call) => call.command === "reveal_in_finder" && JSON.stringify(call.args) === JSON.stringify({ projectId: 2 }))).toBe(true);

  await fromMenu("Project Beta", "Copy path");
  expect(writeText).toHaveBeenCalledWith("/beta");
});

it("opens Settings with Appearance, Themes, Terminal, Code, Session, Shortcuts, and GitHub sections, and closes them", async () => {
  await click(q(".sidebar-footer"));
  const settings = q('main[aria-label="Settings"]')!;
  const navTabs = Array.from(settings.querySelectorAll('[role="tab"]'));
  expect(navTabs.map((tab) => tab.textContent)).toEqual(["Appearance", "Themes", "Terminal", "Code", "Session", "Shortcuts", "GitHub"]);
  expect(settings.querySelectorAll('[role="radio"]').length).toBeGreaterThanOrEqual(2);
  await click(navTabs.find((tab) => tab.textContent === "Session") ?? null);
  const restore = settings.querySelector<HTMLInputElement>('#settings-panel-session input[role="switch"]')!;
  expect(restore.checked).toBe(true);
  await click(restore);
  expect(localStorage.getItem("oxide:restore-session:v1")).toBe("false");
  await click(label("Close settings"));
  expect(q('main[aria-label="Settings"]')).toBeNull();
});

it("does nothing when a former Oxide shortcut is pressed", async () => {
  await newTerminal("Project Alpha");
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

const setCentreWidth = (width: number) => act(async () => {
  for (const { element, callback } of observers) {
    if (element.classList.contains("centre-workbench") && element.isConnected) {
      callback([{ contentRect: { width, height: 600 } } as ResizeObserverEntry], {} as ResizeObserver);
    }
  }
});

it("shows only the last chosen half below 720 px and restores the split above it", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  const terminal = q(".terminal-stub");
  const code = q(".code-stub");
  await setCentreWidth(719);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(true);
  expect(codeVisible()).toBe(true);
  expect(q(".terminal-stub")).toBe(terminal);
  await click(all('[aria-label="Terminals of Project Alpha"] .terminal-item')[0]);
  expect(q<HTMLElement>(".centre-code-half")?.hidden).toBe(true);
  expect(visibleTerminals()).toHaveLength(1);
  expect(q(".code-stub")).toBe(code);
  await openFile();
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(true);
  expect(codeVisible()).toBe(true);
  await setCentreWidth(720);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(false);
  expect(q<HTMLElement>(".centre-code-half")?.hidden).toBe(false);
});

it("restores the split at the remembered divider when widened, unless a half is maximized", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  await nudgeDivider();
  const moved = dividerNow();
  await setCentreWidth(600);
  expect(dividerNow()).toBeUndefined();
  await setCentreWidth(1000);
  expect(dividerNow()).not.toBeUndefined();
  await click(label("Maximize Code"));
  await setCentreWidth(600);
  await setCentreWidth(1000);
  expect(q<HTMLElement>(".centre-terminal-half")?.hidden).toBe(true);
  await click(label("Restore Terminal and Code"));
  expect(Number(dividerNow())).toBeGreaterThan(0);
  expect(moved).toBeDefined();
});

// A real click focuses the button first; `element.click()` does not.
const press = (element: Element | null) => act(async () => { (element as HTMLElement).focus(); (element as HTMLElement).click(); });
const focused = () => document.activeElement;

it("moves focus to the Files view's back button and, going back, to the Project's Files button", async () => {
  await press(filesButton(1));
  expect(focused()).toBe(backToTerminals());
  await press(backToTerminals());
  expect(all(".files-panel")).toHaveLength(0);
  expect(focused()).toBe(filesButton(1));
});

it("keeps focus on the pressed button when a half is maximized or restored", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  await press(label("Maximize Code"));
  expect(focused()).toBe(label("Restore Terminal and Code"));
  await press(label("Restore Terminal and Code"));
  expect(focused()).toBe(label("Maximize Code"));
  await press(label("Maximize Terminal"));
  expect(focused()).toBe(label("Restore Terminal and Code"));
});

it("orders the tab stops sidebar, Terminal half, Code half, dock", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  await click(backToTerminals());
  const follows = (a: Element | null, b: Element | null) => Boolean(a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(q('nav[aria-label="Projects"]'), q(".centre-terminal-half"))).toBe(true);
  expect(follows(q(".centre-terminal-half"), q(".centre-code-half"))).toBe(true);
  expect(follows(q(".centre-code-half"), q('aside[aria-label="Tools panel"]'))).toBe(true);
  await openFiles(0);
  expect(follows(backToTerminals(), q(".files-panel"))).toBe(true);
  expect(follows(q(".files-panel"), q(".centre-terminal-half"))).toBe(true);
});

it("moves focus into the Code half when a file opens, with or without Terminals", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  expect(q(".centre-code-half")!.contains(focused())).toBe(true);
  await removeProject("Project Alpha");
  await openFile(0);
  expect(q(".centre-code-half")!.contains(focused())).toBe(true);
});

it("leaves no empty Code half when the requested file fails to open", async () => {
  await newTerminal("Project Alpha");
  failingOpens.current = true;
  await openFile();
  expect(codeVisible()).toBe(false);
  expect(q<HTMLElement>(".centre-code-half")?.hidden).toBe(true);
  expect(visibleTerminals()).toHaveLength(1);
});

it("forgets a closed Project's split layout", async () => {
  await newTerminal("Project Alpha");
  await openFile();
  await click(label("Maximize Terminal"));
  expect(Object.keys(JSON.parse(localStorage.getItem("oxide:split-layouts:v1")!))).toEqual(["1"]);
  await click(backToTerminals());
  await removeProject("Project Alpha");
  expect(JSON.parse(localStorage.getItem("oxide:split-layouts:v1")!)).toEqual({});
});

it("opens a Project row's menu from the keyboard, under the focused button", async () => {
  const button = all(".project")[1];
  button.getBoundingClientRect = () => ({ left: 40, bottom: 90, top: 60, right: 200, width: 160, height: 30, x: 40, y: 60, toJSON: () => ({}) });
  await act(async () => { button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })); });
  expect(all('[role="menuitem"]').map(menuLabel)).toEqual([
    "New terminal",
    "Open Files",
    revealInFileManagerLabel(),
    "Copy path",
    "Close project",
  ]);
  expect(q<HTMLElement>(".context-menu")?.style.left).toBe("40px");
});

it("does not carry a Project row's menu entries over to the next right-click", async () => {
  await act(async () => { rowOf("Project Beta").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await act(async () => { q(".sidebar-footer")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
  expect(all('[role="menuitem"]').map(menuLabel)).toEqual(["Open a Project…", "New terminal", "Settings"]);
});

it("offers Rename, New terminal, and Close terminal on a Terminal row's context menu", async () => {
  await newTerminal("Project Alpha");
  const row = q('[aria-label="Terminals of Project Alpha"] .terminal-row')!;
  await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })); });
  expect(all('[role="menuitem"]').map(menuLabel)).toEqual(["Rename", "New terminal", "Close terminal"]);
});

it("expands a collapsed Project when a terminal is opened in it from the menu", async () => {
  const beta = () => all(".project")[1];
  await click(beta());
  expect(beta().getAttribute("aria-expanded")).toBe("false");
  await newTerminal("Project Beta");
  expect(beta().getAttribute("aria-expanded")).toBe("true");
});
