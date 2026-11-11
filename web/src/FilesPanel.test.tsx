// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { FilesPanel } from "./FilesPanel";
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); });

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const buttonWith = (text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(text))!;
const dblclick = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });

function treeIpc() {
  const calls: string[] = [];
  mockIPC((command, args) => {
    if (command === "list_dir") {
      calls.push(command);
      return (args as { path: string }).path === ""
        ? [
            { path: "src", name: "src", isDir: true },
            { path: "README.md", name: "README.md", isDir: false },
          ]
        : [{ path: "src/app.ts", name: "app.ts", isDir: false }];
    }
    if (command === "find_files") return ["src/app.ts", "src/util.ts"];
    return null;
  });
  return calls;
}

it("selects a file on a single click and only opens it on a double click", async () => {
  const open = vi.fn();
  const calls = treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();

  expect(host.querySelector(".files-viewer")).toBeNull();
  await act(async () => buttonWith("src").click());
  await settle();
  await act(async () => buttonWith("app.ts").click());
  expect(open).not.toHaveBeenCalled();
  expect(buttonWith("app.ts").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");

  await dblclick(buttonWith("app.ts"));
  expect(open).toHaveBeenCalledExactlyOnceWith("src/app.ts");
  expect(calls).not.toContain("read_file");
});

it("finds files by name and opens a result from the keyboard", async () => {
  const open = vi.fn();
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();

  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(search, "app");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(150);

  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  const result = buttonWith("src/app.ts");
  await act(async () => {
    result.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(open).toHaveBeenCalledExactlyOnceWith("src/app.ts");
});

it("opens a focused file row from the keyboard with Enter or Space", async () => {
  const open = vi.fn();
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();
  await act(async () => buttonWith("src").click());
  await settle();

  const row = buttonWith("app.ts");
  await act(async () => row.focus());
  expect(open).not.toHaveBeenCalled();
  for (const key of ["Enter", " "]) {
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }
  expect(open).toHaveBeenNthCalledWith(1, "src/app.ts");
  expect(open).toHaveBeenNthCalledWith(2, "src/app.ts");
});

it("reloads the tree when the checkout revision changes", async () => {
  const calls = treeIpc();
  const open = vi.fn();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();
  expect(calls).toHaveLength(1);

  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={1} onOpenFile={open} />));
  await settle();
  expect(calls).toHaveLength(2);
});

it("collapses every expanded folder with one control", async () => {
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={vi.fn()} />));
  await settle();

  await act(async () => buttonWith("src").click());
  await settle();
  expect(buttonWith("app.ts")).toBeTruthy();

  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Collapse all folders"]')!.click());
  expect(buttonWith("app.ts")).toBeUndefined();
  expect(buttonWith("src")).toBeTruthy();
});

it("puts the unified search field and the collapse action on the Surface toolbar", async () => {
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={vi.fn()} />));
  await settle();

  const toolbar = host.querySelector<HTMLElement>('section[aria-label="Files"] > .surface-toolbar')!;
  expect(toolbar).not.toBeNull();
  const field = toolbar.querySelector<HTMLElement>(".search-field")!;
  expect(field).not.toBeNull();
  const search = field.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  expect(search).not.toBeNull();
  // The shared search field uses the 14px SearchIcon, not a smaller one of its own.
  expect(field.querySelector("svg")?.getAttribute("width")).toBe("14");
  const collapse = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Collapse all folders"]')!;
  expect(collapse).not.toBeNull();
  // The action shares the toolbar row with the field it belongs next to.
  expect(field.parentElement).toBe(toolbar);
  expect(collapse.parentElement).toBe(toolbar);
});

it("clears the file search with Escape and returns to the tree", async () => {
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={vi.fn()} />));
  await settle();

  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(search, "app");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(150);
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);

  await act(async () => {
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(search.value).toBe("");
  expect(host.querySelector('[role="tree"]')).not.toBeNull();
  expect(buttonWith("src")).toBeTruthy();
});

it("explains an empty checkout with the shared Surface empty layout", async () => {
  mockIPC((command) => (command === "list_dir" ? [] : null));
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={vi.fn()} />));
  await settle();

  const empty = host.querySelector<HTMLElement>('section[aria-label="Files"] .surface-empty')!;
  expect(empty).not.toBeNull();
  expect(empty.querySelector("svg")?.getAttribute("width")).toBe("32");
  expect(empty.querySelector(".surface-empty-title")?.textContent).toBe("No files.");
  expect(empty.querySelector(".surface-empty-description")?.textContent).toBe("This checkout does not have any files yet.");
  expect(host.querySelector(".files-tree")).not.toBeNull();
});
