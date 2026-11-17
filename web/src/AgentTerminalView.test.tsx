// @vitest-environment jsdom
import { act } from "react";
import type { Channel } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Thread } from "./bindings";
import { AgentTerminalView, agentStatusLabel } from "./AgentTerminalView";

const typed: { current: (data: string) => void } = { current: () => {} };
const written: string[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    options = {};
    loadAddon() {}
    open() {}
    write(data: Uint8Array) { written.push(new TextDecoder().decode(data)); }
    paste() {}
    focus() {}
    dispose() {}
    onData(callback: (data: string) => void) { typed.current = callback; return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
for (const size of ["clientWidth", "clientHeight"]) Object.defineProperty(HTMLElement.prototype, size, { configurable: true, get: () => 600 });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

const thread = (patch: Partial<Thread> = {}): Thread => ({
  id: 7, projectId: 1, provider: "claude", model: "opus", effort: null, permissionMode: "auto-edit",
  status: "running", createdAt: "", updatedAt: "", title: null, sessionLost: false, continuedFrom: null,
  continuedIn: null, branch: "oxide/thread-7", worktreePath: "/w", setupOutput: null, issueNumber: null,
  blindReview: false, terminal: true, ...patch,
});

beforeEach(() => {
  written.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const click = (label: string) => act(async () => {
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!.click();
});

function mount(
  t: Thread,
  onThreadUpdated: (thread: Thread) => void = () => {},
  reply: Record<string, unknown> = {},
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const channels: Channel<number[]>[] = [];
  mockIPC((name, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ name, args: a });
    if (name === "attach_agent_terminal") channels.push(a.onOutput as Channel<number[]>);
    if (name in reply) return reply[name];
    if (name === "restart_agent") return thread({ status: "running" });
    return null;
  });
  return {
    calls,
    channels,
    names: () => calls.map((c) => c.name),
    start: () => act(async () => root.render(
      <AgentTerminalView thread={t} visible onThreadUpdated={onThreadUpdated} />,
    )),
  };
}

it("labels the status an Agent terminal reports and how it ended", () => {
  expect(agentStatusLabel("running")).toBe("Running");
  expect(agentStatusLabel("working")).toBe("Working");
  expect(agentStatusLabel("needs-input")).toBe("Needs input");
  expect(agentStatusLabel("completed")).toBe("Completed");
  expect(agentStatusLabel("stopped")).toBe("Stopped");
  expect(agentStatusLabel("error")).toBe("Exited with an error");
});

it("attaches to the Thread's agent, shows its replayed output and sends typed input to it", async () => {
  const view = mount(thread());
  await view.start();
  await settle();
  expect(view.calls.find((c) => c.name === "attach_agent_terminal")?.args.threadId).toBe(7);

  await act(async () => view.channels[0].onmessage([...new TextEncoder().encode("hello from claude")]));
  await settle();
  expect(written.join("")).toContain("hello from claude");

  typed.current("ls\r");
  await settle();
  const write = view.calls.find((c) => c.name === "write_agent_terminal");
  expect(write?.args.threadId).toBe(7);
  expect(write?.args.input).toEqual([...new TextEncoder().encode("ls\r")]);
});

it("shows Stop while the agent runs, and unmounting the view never stops it", async () => {
  const view = mount(thread());
  await view.start();
  await settle();
  expect(container.textContent).toContain("Stop");
  expect(container.textContent).not.toContain("Restart");
  expect(container.textContent).toContain("Auto-edit");

  await act(async () => root.render(null));
  expect(view.names()).not.toContain("stop_agent");
});

it("keeps Stop for an agent that reports working, needs input or completed", async () => {
  for (const status of ["working", "needs-input", "completed"] as const) {
    const view = mount(thread({ status }));
    await view.start();
    await settle();
    expect(container.textContent).toContain("Stop");
    expect(container.textContent).not.toContain("Restart");
    await act(async () => root.render(null));
  }
});

it("Stop asks Core to end the agent", async () => {
  const view = mount(thread());
  await view.start();
  await click("Stop");
  await settle();
  expect(view.calls.find((c) => c.name === "stop_agent")?.args.threadId).toBe(7);
});

it("Restart relaunches the same Thread and attaches to the new process", async () => {
  const updated: Thread[] = [];
  const view = mount(thread({ status: "stopped" }), (t) => updated.push(t));
  await view.start();
  await settle();
  expect(container.textContent).toContain("Restart");
  await click("Restart");
  await settle();
  expect(view.calls.find((c) => c.name === "restart_agent")?.args.threadId).toBe(7);
  expect(updated[0]?.status).toBe("running");
  expect(view.names().filter((n) => n === "attach_agent_terminal")).toHaveLength(2);
});

it("shows the Setup command output when it failed and no agent started", async () => {
  const view = mount(thread({ status: "error", setupOutput: "npm ERR! nope" }));
  await view.start();
  await settle();
  expect(container.textContent).toContain("Setup command failed");
  expect(container.textContent).toContain("npm ERR! nope");
});

it("opens the Thread before attaching, so a relaunched Oxide resumes its agent lazily", async () => {
  const updated: Thread[] = [];
  const view = mount(thread({ status: "stopped" }), (t) => updated.push(t), {
    open_agent: thread({ status: "running" }),
  });
  await view.start();
  await settle();
  const names = view.names();
  expect(view.calls.find((c) => c.name === "open_agent")?.args.threadId).toBe(7);
  expect(names.indexOf("open_agent")).toBeLessThan(names.indexOf("attach_agent_terminal"));
  expect(updated.at(-1)?.status).toBe("running");
});

it("says the Provider session is gone and starts a fresh one only when the user accepts", async () => {
  const updated: Thread[] = [];
  const view = mount(thread({ status: "error" }), (t) => updated.push(t), {
    agent_session_gone: true,
    start_fresh_agent_session: thread({ status: "running" }),
  });
  await view.start();
  await settle();
  expect(container.textContent).toContain("no longer exists");
  expect(view.names()).not.toContain("start_fresh_agent_session");

  await click("Start a fresh session");
  await settle();

  expect(view.calls.find((c) => c.name === "start_fresh_agent_session")?.args.threadId).toBe(7);
  expect(updated.at(-1)?.status).toBe("running");
  expect(view.names().filter((n) => n === "attach_agent_terminal")).toHaveLength(2);
});

it("offers no fresh session while the session exists", async () => {
  const view = mount(thread({ status: "stopped" }), () => {}, { agent_session_gone: false });
  await view.start();
  await settle();
  expect(container.textContent).not.toContain("fresh session");
});
