// @vitest-environment jsdom
import { act, useState } from "react";
import type { Channel } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { TerminalWorkbench } from "./TerminalWorkbench";

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
    focus() {}
    blur() {}
    dispose() {}
    onData() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
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
  await act(async () => root.render(<TerminalWorkbench projectId={1} threadId={null} rootPath="/test" contextKey="1" visible queuedCommand={null} onCommandConsumed={() => {}} />));
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

/** A shell whose `start_project_service` result the caller controls. */
async function openServiceShell(service: () => unknown) {
  const calls: { name: string; args: unknown }[] = [];
  mockIPC((name, args) => {
    calls.push({ name, args });
    if (name === "start_block_terminal") return { id: 1 };
    if (name === "start_project_service") return service();
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} threadId={null} rootPath="/test" contextKey="1" visible queuedCommand={null} onCommandConsumed={() => {}} />));
  return {
    calls,
    names: () => calls.map((call) => call.name),
    serviceCall: () => calls.find((call) => call.name === "start_project_service"),
    async submit(value: string) {
      const input = container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => container.querySelector("form")!.requestSubmit());
      await settle();
    },
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
  await act(async () => root.render(<TerminalWorkbench projectId={1} threadId={null} rootPath="/test" contextKey="1" visible queuedCommand={null} onCommandConsumed={() => {}} />));
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
  expect(block.querySelector('[role="img"][aria-label="Running"]')).not.toBeNull();
  expect(block.textContent).not.toMatch(/\d\s?ms|\d\s?s\b/);
  now = 1_017;
  await shell.output("a.txt\r\n");
  await shell.end(0);
  expect(spoken(block)).not.toContain("Running");
  expect(block.textContent).toContain("17 ms");
  expect(spoken(block)).toContain("Command duration: 17 ms");
  expect(block.textContent).not.toContain("Done");
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
    expect(block.querySelector("header")?.textContent).toMatch(/^(ls|pwd)/);
  }
});

it("detaches a recognised server into a Project Service and frees the prompt", async () => {
  const shell = await openServiceShell(() => ({
    id: 9,
    projectId: 1,
    threadId: null,
    command: "npm run dev",
    checkout: "/test",
    status: "running",
    pid: 4242,
    port: 5173,
    url: "http://localhost:5173",
    startedAt: "2026-01-01T00:00:00Z",
    exitCode: null,
  }));

  await shell.submit("npm run dev");

  expect(shell.serviceCall()?.args).toEqual({ projectId: 1, threadId: null, command: "npm run dev" });
  expect(shell.names()).not.toContain("run_terminal_block");
  expect(shell.names()).not.toContain("resize_terminal");
  expect(shell.names()).not.toContain("write_terminal");
  expect(writes.join("")).toContain("Starting Project Service");
  expect(writes.join("")).toContain("[Oxide] Started Project Service 'npm run dev' on http://localhost:5173 (PID 4242)");
  const [block] = blocks();
  expect(block.querySelector(".terminal-service-badge")?.textContent).toBe("service");
  expect(block.classList.contains("running")).toBe(false);
  expect(block.querySelector('[role="img"][aria-label="Running"]')).toBeNull();
  expect(container.querySelector("textarea")).not.toBeNull();
  expect(JSON.parse(localStorage.getItem("oxide:terminal-history:1")!)).toEqual([
    expect.objectContaining({ command: "npm run dev", exitCode: 0 }),
  ]);
});

it("keeps an early service failure inline in its command block", async () => {
  const shell = await openServiceShell(() =>
    Promise.reject({
      message:
        "Project Service `npm run dev` exited with code 2 during its 1.5s startup check.\nError: missing module",
    }),
  );

  await shell.submit("npm run dev");

  const output = writes.join("");
  expect(output).toContain("exited with code 2");
  expect(output).toContain("Error: missing module");
  const [block] = blocks();
  expect(block.classList.contains("running")).toBe(false);
  expect(block.textContent).toContain("exit 2");
  expect(container.querySelector("textarea")).not.toBeNull();
  expect(shell.names()).not.toContain("run_terminal_block");
  expect(shell.names()).not.toContain("list_project_services");
  expect(JSON.parse(localStorage.getItem("oxide:terminal-history:1")!)).toEqual([
    expect.objectContaining({ command: "npm run dev", exitCode: 2 }),
  ]);
});

it("detaches a trailing ampersand command without passing the ampersand to the service", async () => {
  const shell = await openServiceShell(() => ({
    id: 10,
    projectId: 1,
    threadId: null,
    command: "sleep 300",
    checkout: "/test",
    status: "running",
    pid: 999,
    port: null,
    url: null,
    startedAt: "2026-01-01T00:00:00Z",
    exitCode: null,
  }));

  await shell.submit("sleep 300 &");

  expect(shell.serviceCall()?.args).toEqual({ projectId: 1, threadId: null, command: "sleep 300" });
  expect(shell.names()).not.toContain("run_terminal_block");
  const output = writes.join("");
  expect(output).toContain("[Oxide] Started Project Service 'sleep 300' (PID 999)");
  expect(output).not.toContain("http://");
});

it("keeps an ordinary command in the shell", async () => {
  const shell = await openShell();
  await shell.submit("echo hi");
  await shell.start();
  await shell.end(0);

  expect(shell.calls).toContain("run_terminal_block");
  expect(shell.calls).not.toContain("start_project_service");
});

it("detaches a queued setup command through the same interception", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const consumed = vi.fn();
  mockIPC((name, args) => {
    calls.push({ name, args });
    if (name === "start_block_terminal") return { id: 1 };
    if (name === "start_project_service")
      return {
        id: 11,
        projectId: 1,
        threadId: 2,
        command: "pnpm dev",
        checkout: "/test",
        status: "running",
        pid: 321,
        port: 3000,
        url: "http://localhost:3000",
        startedAt: "2026-01-01T00:00:00Z",
        exitCode: null,
      };
    return null;
  });

  function Queued() {
    const [queued, setQueued] = useState<{ id: number; command: string } | null>({
      id: 1,
      command: "pnpm dev",
    });
    return (
      <TerminalWorkbench
        projectId={1}
        threadId={2}
        rootPath="/test"
        contextKey="1:2"
        visible
        queuedCommand={queued}
        onCommandConsumed={() => {
          consumed();
          setQueued(null);
        }}
      />
    );
  }

  await act(async () => root.render(<Queued />));
  await settle();

  expect(calls.find((call) => call.name === "start_project_service")?.args).toEqual({
    projectId: 1,
    threadId: 2,
    command: "pnpm dev",
  });
  expect(consumed).toHaveBeenCalled();
});
