// @vitest-environment jsdom
import { act } from "react";
import type { Channel } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { TerminalWorkbench } from "./TerminalWorkbench";
import { RUNNING_INDICATOR_DELAY_MS } from "./runningIndicator";
import { ContextMenu } from "../shared/ContextMenu";

const xtermSelection = { text: "" };
const dataListeners: Array<(data: string) => void> = [];

// xterm needs a real canvas and layout; the Command block around it is what is under test.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    options = {};
    buffer = { active: { baseY: 0, cursorY: 0, length: 0, getLine: () => undefined }, onBufferChange: () => ({ dispose() {} }) };
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    write(data: string) { writes.push(data); }
    paste() {}
    hasSelection() { return xtermSelection.text.length > 0; }
    getSelection() { return xtermSelection.text; }
    focus() {}
    blur() {}
    dispose() {}
    onData(listener: (data: string) => void) { dataListeners.push(listener); return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
HTMLElement.prototype.scrollIntoView = vi.fn();
for (const size of ["clientWidth", "clientHeight"]) Object.defineProperty(HTMLElement.prototype, size, { configurable: true, get: () => 600 });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const writes: string[] = [];
let now = 0;
beforeEach(() => {
  writes.length = 0;
  dataListeners.length = 0;
  xtermSelection.text = "";
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** A shell behind mocked IPC whose OSC 633 markers the test sends by hand. */
async function openShell() {
  const calls: string[] = [];
  const tokens: string[] = [];
  let channel: Channel<number[]>;
  mockIPC((name, args) => {
    calls.push(name);
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") tokens.push((args as { token: string }).token);
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible />));
  const send = async (text: string) => {
    await act(async () => channel.onmessage([...new TextEncoder().encode(text)]));
    await settle();
  };
  const token = () => tokens[tokens.length - 1];
  return {
    calls,
    async submit(value: string) {
      const input = container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => container.querySelector("form")!.requestSubmit());
      await settle();
    },
    start: () => send(`\x1b]633;Oxide;${token()};start\x07`),
    output: (text: string) => send(text),
    end: (exitCode: number, cwd = "/test") => send(`\x1b]633;Oxide;${token()};end;${exitCode};${cwd}\x07`),
    close: () => send("\x1b]633;Oxide;closed\x07"),
  };
}

function blocks() {
  return Array.from(container.querySelectorAll<HTMLElement>('[aria-label^="Command:"]'));
}
/** What a screen reader reads: text outside aria-hidden subtrees, and images by their label. */
function spoken(element: Element) {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
  copy.querySelectorAll('[role="img"][aria-label]').forEach((image) => image.replaceWith(image.getAttribute("aria-label")!));
  return copy.textContent;
}

it.each(["clear", "CLS", "Clear-Host"])("%s clears completed blocks without replacing the shell or history", async (command) => {
  const calls: string[] = [];
  let channel: Channel<number[]>;
  mockIPC((name, args) => {
    calls.push(name);
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") {
      const { token } = args as { token: string };
      channel.onmessage([...new TextEncoder().encode(`\x1b]633;Oxide;${token};start\x07hello\r\n\x1b]633;Oxide;${token};end;0;/test\x07`)]);
    }
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible />));
  const submit = async (value: string) => {
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.requestSubmit());
  };
  await submit("echo hello");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(container.querySelectorAll('[aria-label^="Command:"]')).toHaveLength(1);
  await submit(command);
  expect(container.querySelector('[aria-label^="Command:"]')).toBeNull();
  expect(calls.filter((c) => c === "start_block_terminal")).toHaveLength(1);
  expect(calls).not.toContain("close_terminal");
  expect(container.querySelector("textarea")?.value).toBe("");
  expect(JSON.parse(localStorage.getItem("oxide:terminal-history:1")!)).toEqual([expect.objectContaining({ command: "echo hello", exitCode: 0 })]);
});

it("shows a Running indicator while a command runs and only its duration once it succeeds", async () => {
  const shell = await openShell();
  now = 1_000;
  await shell.submit("ls");
  await shell.start();
  const [block] = blocks();
  // Past the running indicator delay, so the command shows as running and can be interrupted.
  await act(async () => { await new Promise((r) => setTimeout(r, RUNNING_INDICATOR_DELAY_MS + 50)); });
  expect(block.querySelector('[role="img"][aria-label="Running"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Interrupt command"]')).not.toBeNull();
  expect(block.textContent).not.toMatch(/\d\s?ms|\d\s?s\b/);
  now = 1_017;
  await shell.output("a.txt\r\n");
  await shell.end(0);
  expect(spoken(block)).not.toContain("Running");
  expect(block.textContent).toContain("17 ms");
  expect(spoken(block)).toContain("Command duration: 17 ms");
  expect(block.textContent).not.toContain("Done");
});

it("keeps the command line in place of Interrupt for a command that ends before the running indicator delay", async () => {
  const shell = await openShell();
  await shell.submit("cd sub");
  await shell.start();
  expect(container.querySelector('[aria-label="Interrupt command"]')).toBeNull();
  await shell.end(0, "/test/sub");
  await act(async () => { await new Promise((r) => setTimeout(r, RUNNING_INDICATOR_DELAY_MS + 50)); });
  expect(container.querySelector('[aria-label="Interrupt command"]')).toBeNull();
  expect(container.querySelector("textarea")).not.toBeNull();
});

it("reports a command as running to the Terminal row only once it runs past the running indicator delay", async () => {
  const reported: Array<string | null> = [];
  let channel: Channel<number[]>;
  const tokens: string[] = [];
  mockIPC((name, args) => {
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") tokens.push((args as { token: string }).token);
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible onRunningChange={(command) => reported.push(command)} />));
  const send = (text: string) => act(async () => channel.onmessage([...new TextEncoder().encode(text)]));
  const submit = async (value: string) => {
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.requestSubmit());
    await settle();
  };
  const wait = () => act(async () => { await new Promise((r) => setTimeout(r, RUNNING_INDICATOR_DELAY_MS + 50)); });
  await submit("cd sub");
  await send(`\x1b]633;Oxide;${tokens[0]};start\x07\x1b]633;Oxide;${tokens[0]};end;0;/test/sub\x07`);
  await wait();
  expect(reported.filter(Boolean)).toEqual([]);
  await submit("sleep 5");
  await send(`\x1b]633;Oxide;${tokens[1]};start\x07`);
  await wait();
  expect(reported.at(-1)).toBe("sleep 5");
});

it("shows the exit code beside the duration when a command fails", async () => {
  const shell = await openShell();
  now = 5_000;
  await shell.submit("false");
  await shell.start();
  now = 5_320;
  await shell.end(1);
  const [block] = blocks();
  expect(block.textContent).toContain("exit 1 · 320 ms");
  expect(spoken(block)).toContain("Exit 1 after 320 ms");
});

it("marks a command cut off by the shell exiting", async () => {
  const shell = await openShell();
  now = 0;
  await shell.submit("sleep 10");
  await shell.start();
  now = 1_240;
  await shell.close();
  const [block] = blocks();
  expect(block.textContent).toContain("shell exited · 1.24 s");
  expect(spoken(block)).not.toContain("Running");
  expect(container.textContent).toContain("Start a new shell");
});

it("keeps the header to the shell and its current directory, updated after every command", async () => {
  const shell = await openShell();
  const header = () => container.querySelector<HTMLElement>("header")!;
  expect(header().querySelectorAll("button")).toHaveLength(0);
  expect(header().textContent).toContain("/test");
  await shell.submit("cd sub");
  await shell.start();
  await shell.end(0, "/test/sub");
  expect(header().textContent).toContain("/test/sub");
  expect(header().querySelector('[title="/test/sub"]')).not.toBeNull();
  await shell.submit("cd nowhere");
  await shell.start();
  await shell.end(1, "/test/sub");
  expect(header().textContent).toContain("/test/sub");
  // A new shell starts at the root again.
  await shell.close();
  expect(header().textContent).toContain("/test/sub");
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Start a new shell")!.click());
  await settle();
  expect(header().textContent).not.toContain("/test/sub");
  expect(header().textContent).toContain("/test");
  expect(shell.calls.filter((c) => c === "start_block_terminal")).toHaveLength(2);
});

it("renders only the command and its status: no cwd, Copy, Reuse or Collapse", async () => {
  const shell = await openShell();
  await shell.submit("ls");
  await shell.start();
  await shell.end(0, "/test/sub");
  await shell.submit("pwd");
  await shell.start();
  await shell.end(0, "/test/sub");
  expect(blocks()).toHaveLength(2);
  for (const block of blocks()) {
    expect(block.textContent).not.toContain("/test");
    expect(block.querySelectorAll("button")).toHaveLength(0);
    expect(block.querySelector("header")?.textContent).toMatch(/^\$\s*(ls|pwd)/);
  }
});

it("keeps an ordinary command in the shell", async () => {
  const shell = await openShell();
  await shell.submit("echo hi");
  await shell.start();
  await shell.end(0);

  expect(shell.calls).toContain("run_terminal_block");
});

it("runs a server or an agent CLI in the shell like any other command, with no Oxide handling", async () => {
  for (const command of ["npm run dev", "claude", "python -m http.server 8000 &"]) {
    const shell = await openShell();
    await shell.submit(command);
    await shell.start();

    expect(shell.calls).toContain("run_terminal_block");
    expect(shell.calls.filter((name) => name !== "start_block_terminal" && name !== "run_terminal_block" && name !== "resize_terminal" && name !== "write_terminal")).toEqual([]);
    await act(async () => root.render(null));
  }
});

it("offers context actions on Command blocks and Terminal workbench (Copy, Paste, Copy command, Clear terminal, New terminal)", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const readText = vi.fn().mockResolvedValue("pasted-cmd");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText, readText } });

  const newTerminal = vi.fn();
  let channel: Channel<number[]>;
  let token = "";
  mockIPC((name, args) => {
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") token = (args as { token: string }).token;
    return null;
  });

  await act(async () => root.render(
    <>
      <ContextMenu actions={{ openProject: vi.fn(), newTerminal, openSettings: vi.fn() }} />
      <TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible onNewTerminal={newTerminal} />
    </>,
  ));

  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "echo hello");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle();
  await act(async () => channel!.onmessage([...new TextEncoder().encode(`\x1b]633;Oxide;${token};start\x07hello\r\n\x1b]633;Oxide;${token};end;0;/test\x07`)]));
  await settle();

  // Right-click Command block with xterm selection.
  xtermSelection.text = "hello";
  const block = blocks()[0]!;
  await act(async () => { block.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
  const menuLabels = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((b) => b.querySelector("span")?.textContent);
  expect(menuLabels()).toEqual(["Copy", "Paste", "Copy command", "Clear terminal", "New terminal"]);

  await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]!.click(); });
  expect(writeText).toHaveBeenCalledWith("hello");

  await act(async () => { block.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
  await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]!.click(); });
  expect(writeText).toHaveBeenCalledWith("echo hello");

  // Right-click Terminal workbench outside Command block with no selection.
  xtermSelection.text = "";
  const scrollArea = container.querySelector(".terminal-block-scroll")!;
  await act(async () => { scrollArea.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
  expect(menuLabels()).toEqual(["Paste", "Clear terminal", "New terminal"]);

  // Paste inserts into composer.
  await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]!.click(); });
  await settle();
  expect(readText).toHaveBeenCalledOnce();
  expect(container.querySelector("textarea")!.value).toBe("pasted-cmd");

  // Clear terminal clears blocks.
  await act(async () => { scrollArea.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
  await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click(); });
  expect(blocks()).toHaveLength(0);

  // New terminal invokes callback.
  await act(async () => { scrollArea.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
  await act(async () => { container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]!.click(); });
  expect(newTerminal).toHaveBeenCalledOnce();
});

it.each([
  ["macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", false],
  ["Linux", "Mozilla/5.0 (X11; Linux x86_64)", false],
  ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", true],
])("answers the shell's cursor-position probe only on Windows, where ConPTY waits for it (%s)", async (_os, userAgent, answers) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  const written: string[] = [];
  let channel: Channel<number[]>;
  mockIPC((name, args) => {
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "write_terminal") written.push(new TextDecoder().decode(new Uint8Array((args as { input: number[] }).input)));
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible />));
  await settle();
  await act(async () => channel.onmessage([...new TextEncoder().encode("\x1b[6n")]));
  await settle();
  expect(written.includes("\x1b[1;1R")).toBe(answers);
});

it("keeps keys typed during a block's launch out of the shell until the block starts", async () => {
  const written: string[] = [];
  let channel: Channel<number[]>;
  let token = "";
  mockIPC((name, args) => {
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") token = (args as { token: string }).token;
    if (name === "write_terminal") written.push(new TextDecoder().decode(new Uint8Array((args as { input: number[] }).input)));
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible />));
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "cat");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle();
  const type = (data: string) => act(async () => { for (const listener of dataListeners) listener(data); });
  await type("early");
  await settle();
  expect(written).not.toContain("early");
  await act(async () => channel!.onmessage([...new TextEncoder().encode(`\x1b]633;Oxide;${token};start\x07`)]));
  await settle();
  await type("late");
  await settle();
  expect(written).toContain("late");
});

it("leaves focus alone when a block ends in a Terminal that has been hidden since", async () => {
  let channel: Channel<number[]>;
  let token = "";
  mockIPC((name, args) => {
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") token = (args as { token: string }).token;
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible />));
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "sleep 1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle();
  await act(async () => channel!.onmessage([...new TextEncoder().encode(`\x1b]633;Oxide;${token};start\x07`)]));
  await settle();
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  await act(async () => root.render(<TerminalWorkbench projectId={1} rootPath="/test" contextKey="1" visible={false} />));
  await act(async () => channel!.onmessage([...new TextEncoder().encode(`\x1b]633;Oxide;${token};end;0;/test\x07`)]));
  await settle();
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
});


it("keeps the command line the same element, unchanged, from the start to the end of a fast command", async () => {
  const shell = await openShell();
  await shell.submit("ls");
  await shell.start();
  await shell.end(0);
  const composer = container.querySelector("form.terminal-command-composer")!;
  const seen: string[] = [];
  const look = () => {
    expect(container.querySelector("form.terminal-command-composer")).toBe(composer);
    seen.push(composer.outerHTML);
  };
  look();
  await shell.submit("cd ..");
  look();
  await shell.start();
  look();
  await shell.end(0, "/");
  look();
  expect(new Set(seen).size).toBe(1);
});
