// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  document.querySelectorAll("[data-typing-fixture]").forEach((node) => node.remove());
  clearMocks();
  localStorage.clear();
});

const thread = {
  id: 3,
  projectId: 1,
  provider: "claude",
  model: null,
  effort: null,
  permissionMode: "auto-edit",
  status: "completed" as const,
  title: null,
  sessionLost: false,
  continuedFrom: null,
  continuedIn: null,
  branch: null,
  worktreePath: null,
  setupOutput: null,
  issueNumber: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function setup() {
  mockIPC((command) => {
    switch (command) {
      case "subscribe_thread":
        return {
          thread,
          capabilities: { reasoningText: true },
          turns: [],
          turnOffset: 0,
          turnCount: 0,
          lastSeq: 0,
          supportedPermissionModes: ["ask", "auto-edit", "full-access"],
        };
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
      case "get_provider_capabilities": return { supportedPermissionModes: ["ask", "auto-edit", "full-access"] };
      case "git_status": return { branch: "main", added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: false };
      case "get_model_catalog": case "list_slash_commands": return [];
      case "list_turns": return { offset: 0, turns: [], turnCount: 0 };
      default: return null;
    }
  });
}

const render = (draft = "", visible = true) => act(async () => root.render(
  <ThreadView
    visible={visible}
    threadId={3}
    projectId={1}
    draft={draft}
    onThreadCreated={vi.fn()}
    onStatusChange={vi.fn()}
    prefill={null}
    onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()}
    onThreadContinued={vi.fn()}
  />,
));
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const editor = () => container.querySelector<HTMLElement>('[role="textbox"]')!;
const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
};

it("focuses the composer and keeps the typed character when the composer is not focused", async () => {
  setup();
  await render();
  await flush();
  expect(document.activeElement).not.toBe(editor());

  await press("h");
  await flush();

  expect(document.activeElement).toBe(editor());
  expect(editor().textContent).toBe("h");
});

it("leaves typing in another input, textarea, or editable surface alone", async () => {
  setup();
  await render();
  await flush();

  for (const field of [document.createElement("input"), document.createElement("textarea"), document.createElement("div")]) {
    if (field.tagName === "DIV") field.setAttribute("contenteditable", "true");
    field.setAttribute("data-typing-fixture", "");
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);

    await press("x");
    await flush();

    expect(document.activeElement).toBe(field);
    expect(editor().textContent).toBe("");
    field.remove();
  }
});

it("ignores shortcuts and non-printable keys", async () => {
  setup();
  await render();
  await flush();

  for (const init of [
    { key: "a", metaKey: true },
    { key: "a", ctrlKey: true },
    { key: "a", altKey: true },
    { key: "Enter" },
    { key: "Tab" },
    { key: "Escape" },
    { key: "ArrowDown" },
    { key: "F1" },
  ]) {
    await press(init.key, init);
    await flush();
  }

  expect(document.activeElement).not.toBe(editor());
  expect(editor().textContent).toBe("");
});

it("does not steal typing from an open modal dialog", async () => {
  setup();
  await render();
  await flush();
  const dialog = document.createElement("div");
  dialog.setAttribute("data-typing-fixture", "");
  dialog.className = "modal-backdrop";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const button = document.createElement("button");
  dialog.append(button);
  document.body.append(dialog);
  button.focus();

  await press("x");
  await flush();

  expect(document.activeElement).toBe(button);
  expect(editor().textContent).toBe("");
});

it("inserts the typed character at the caret the composer last had", async () => {
  setup();
  await render("hello");
  await flush();
  editor().focus();
  const text = editor().firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => { editor().blur(); });
  expect(document.activeElement).not.toBe(editor());

  await press("!", { shiftKey: true });
  await flush();

  expect(document.activeElement).toBe(editor());
  expect(editor().textContent).toBe("he!llo");
});

it("does not capture typing while the Thread view is hidden", async () => {
  setup();
  await render("", false);
  await flush();

  await press("h");
  await flush();

  expect(document.activeElement).not.toBe(editor());
  expect(editor().textContent).toBe("");
});
