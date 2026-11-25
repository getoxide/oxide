// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { TerminalInput, type TerminalInputHandle } from "./TerminalInput";
import { readablePath } from "./headerLines";
import { historyMatches } from "./terminalBlocks";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.scrollIntoView = vi.fn();
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
});
afterEach(async () => {
  await act(async () => root.render(null));
  clearMocks();
  vi.unstubAllGlobals();
});
function input(): HTMLTextAreaElement {
  return container.querySelector("textarea")!;
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(value: string) {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}
const history = [
  { command: "git diff", at: 1, exitCode: 0 },
  { command: "git status", at: 2, exitCode: 0 },
];
it("Up uses a prefix search while Ctrl+R supports fuzzy history search", () => {
  expect(historyMatches("echo git status", "git", true)).toBe(false);
  expect(historyMatches("git status", "git", true)).toBe(true);
  expect(historyMatches("git status", "gtst")).toBe(true);
});
it("Right accepts the latest matching history entry, while Tab requests real shell completion", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    return {
      replacementIndex: 0,
      replacementLength: 3,
      matches: [{ text: "git.exe", label: "git", detail: "Application" }],
    };
  });
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={history}
        sessionId={1}
        disabled={false}
        visible
        fresh
        onRun={() => {
          throw new Error("must not execute suggestions");
        }}
      />,
    ),
  );
  await type("git");
  await key("ArrowRight");
  expect(input().value).toBe("git status");
  expect(calls).toEqual([]);
  await type("git");
  await key("Tab");
  expect(calls).toEqual(["complete_terminal"]);
  expect(input().value).toBe("git.exe");
});
it("Up opens searchable history and navigates older commands without executing them", async () => {
  const run = vi.fn();
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={history}
        sessionId={1}
        disabled={false}
        visible
        fresh
        onRun={run}
      />,
    ),
  );
  // The prompt is the symbol and the input; the directory lives in the Terminal header.
  expect(container.querySelector("form")?.textContent).not.toContain("/project");
  await key("ArrowUp");
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(
    container.querySelector('[aria-selected="true"]')?.textContent,
  ).toContain("git status");
  await key("ArrowUp");
  expect(
    container.querySelector('[aria-selected="true"]')?.textContent,
  ).toContain("git diff");
  await key("Enter");
  expect(input().value).toBe("git diff");
  expect(run).not.toHaveBeenCalled();
  await key("Enter");
  expect(run).toHaveBeenCalledWith("git diff");
});
it("normalizes extended drive and UNC paths without losing the network share", () => {
  expect(readablePath("\\\\?\\C:\\work")).toBe("C:\\work");
  expect(readablePath("\\\\?\\UNC\\server\\share")).toBe("\\\\server\\share");
  expect(readablePath("/home/work")).toBe("/home/work");
});

it.each([
  ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"],
  ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15"],
  ["Linux", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"],
])("shows the same $ prompt on %s", async (_platform, userAgent) => {
  vi.stubGlobal("navigator", { ...navigator, userAgent });
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={[]}
        sessionId={1}
        disabled={false}
        visible
        fresh
        onRun={() => {}}
      />,
    ),
  );
  expect(container.querySelector(".terminal-prompt-symbol")?.textContent).toBe("$");
});

it("runs on Enter from an inline command line with no chat-style send button, and Shift+Enter keeps editing", async () => {
  const runs: string[] = [];
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={[]}
        sessionId={1}
        disabled={false}
        visible
        fresh
        onRun={(command) => runs.push(command)}
      />,
    ),
  );
  expect(container.querySelector('[aria-label="Run command"]')).toBeNull();
  expect(container.querySelectorAll(".terminal-command-entry button")).toHaveLength(0);
  await type("echo one");
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(runs).toEqual([]);
  await type("echo one\necho two");
  await key("Enter");
  expect(runs).toEqual(["echo one\necho two"]);
  expect(input().value).toBe("");
});

const listing = {
  replacementIndex: 3,
  replacementLength: 1,
  matches: [
    { text: "src/", label: "src/", detail: "Directory" },
    { text: "sample.txt", label: "sample.txt", detail: "File" },
  ],
};

it("lists shell completions as a compact list at the word being completed, directories ending in /", async () => {
  mockIPC(() => listing);
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={[]}
        sessionId={1}
        disabled={false}
        visible
        fresh={false}
        onRun={() => {}}
      />,
    ),
  );
  await type("cd s");
  await key("Tab");
  const menu = container.querySelector<HTMLElement>(".terminal-input-menu")!;
  // A list, not a card: no title, close button or key hints.
  expect(menu.querySelector("header, footer, kbd")).toBeNull();
  expect(menu.querySelector('[aria-label="Close suggestions"]')).toBeNull();
  expect(menu.textContent).not.toContain("Shell completions");
  const options = [...menu.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  // The kind shows as the trailing / of a directory, not as a word.
  expect(options).toEqual(["src/", "sample.txt"]);
  // Anchored under the caret's word: it starts at the column the completion replaces.
  expect(menu.style.getPropertyValue("--terminal-menu-column")).toBe("3");

  await key("ArrowDown");
  await key("Enter");
  expect(input().value).toBe("cd sample.txt");
  await type("cd s");
  await key("Tab");
  await key("Escape");
  expect(container.querySelector(".terminal-input-menu")).toBeNull();
});

it("dismisses the completion list when the command line loses focus", async () => {
  mockIPC(() => listing);
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={[]}
        sessionId={1}
        disabled={false}
        visible
        fresh={false}
        onRun={() => {}}
      />,
    ),
  );
  await type("cd s");
  await key("Tab");
  expect(container.querySelector(".terminal-input-menu")).not.toBeNull();
  const outside = document.createElement("button");
  document.body.append(outside);
  await act(async () => {
    input().focus();
    outside.focus();
  });
  expect(container.querySelector(".terminal-input-menu")).toBeNull();
  outside.remove();
});

it("shows history in the same compact list: a search field, the commands, no close button or key hints", async () => {
  await act(async () =>
    root.render(
      <TerminalInput
        ref={createRef<TerminalInputHandle>()}
        history={history}
        sessionId={1}
        disabled={false}
        visible
        fresh={false}
        onRun={() => {}}
      />,
    ),
  );
  await key("ArrowUp");
  const menu = container.querySelector<HTMLElement>(".terminal-input-menu")!;
  expect(menu.querySelector('[aria-label="Search command history"]')).not.toBeNull();
  expect(menu.querySelector('[aria-label="Close suggestions"], footer, kbd')).toBeNull();
  expect([...menu.querySelectorAll('[role="option"] code')].map((code) => code.textContent)).toEqual([
    "git diff",
    "git status",
  ]);
});
