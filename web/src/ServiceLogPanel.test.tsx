// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { mergeLogLines, ServiceLogPanel } from "./ServiceLogPanel";
import type { ProjectService, ProjectServiceLogLine } from "./bindings";
import type { TerminalCheckout } from "./terminalTabs";

const checkout: TerminalCheckout = { key: "1:main", threadId: null, rootPath: "/alpha" };

const baseService: ProjectService = {
  id: 9, projectId: 1, threadId: null, command: "npm run dev", checkout: "/alpha",
  status: "running", pid: 900, port: 5173, url: "http://localhost:5173",
  startedAt: "2026-01-01T00:00:00Z", exitCode: null,
};

const line = (seq: number, stream: "stdout" | "stderr", text: string): ProjectServiceLogLine =>
  ({ seq, stream, text, at: "2026-01-01T00:00:00Z" });

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
let channel: Channel<ProjectServiceLogLine> | undefined;
let calls: { name: string; args: unknown }[] = [];
let service: ProjectService;
let stopped = false;
let backlog: ProjectServiceLogLine[] = [];
let restartResult: unknown = null;

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes(text));
const logText = () => container.querySelector('[role="log"]')?.textContent ?? "";

beforeEach(() => {
  service = { ...baseService };
  stopped = false;
  channel = undefined;
  calls = [];
  backlog = [line(0, "stdout", "ready on http://localhost:5173")];
  restartResult = null;
  root.render(null);
  mockIPC((name, args) => {
    calls.push({ name, args });
    switch (name) {
      case "project_service": return stopped ? { ...service, status: "stopped" } : service;
      case "subscribe_project_service_logs":
        channel = (args as { onLine: Channel<ProjectServiceLogLine> }).onLine;
        return backlog;
      case "restart_project_service": return restartResult ?? { outcome: "started", payload: service };
      case "stop_project_service": stopped = true; return null;
      case "clear_project_service_logs": return null;
      case "open_local_url": return null;
      case "plugin:event|listen": return 1;
      default: return null;
    }
  });
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => root.render(null));
  clearMocks();
});

const render = async (projectId = 1) => {
  await act(async () => root.render(
    <ServiceLogPanel projectId={projectId} serviceId={9} checkout={checkout} visible />,
  ));
  await settle();
};it("merges the backlog and live lines by sequence, dropping duplicates", () => {
  const merged = mergeLogLines([line(0, "stdout", "a"), line(2, "stdout", "c")], [line(2, "stdout", "c"), line(1, "stderr", "b")]);
  expect(merged.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  expect(mergeLogLines(merged, [line(2, "stdout", "c")])).toHaveLength(3);
});

it("keeps up to ten thousand lines like the Core's buffer", () => {
  const many = Array.from({ length: 10_050 }, (_, index) => line(index, "stdout", `line-${index}`));
  const merged = mergeLogLines([], many);
  expect(merged).toHaveLength(10_000);
  expect(merged[0]?.seq).toBe(50);
  expect(merged.at(-1)?.seq).toBe(10_049);
});

it("renders the service status, command and read-only backlog", async () => {
  await render();
  expect(container.textContent).toContain("npm run dev");
  expect(container.textContent).toContain("Running");
  expect(container.textContent).toContain(":5173");
  expect(logText()).toContain("ready on http://localhost:5173");
  expect(container.querySelector("input, textarea")).toBeNull();
  expect(container.querySelector('[role="log"]')).not.toBeNull();
});

it("appends live lines, colours stderr and strips ANSI escapes", async () => {
  await render();
  await act(async () => { channel?.onmessage(line(1, "stderr", "\u001b[31merror\u001b[0m bound to 127.0.0.1:4321")); });
  expect(logText()).toContain("error bound to 127.0.0.1:4321");
  expect(logText()).not.toContain("\u001b");
  expect(container.querySelector(".service-log-line.stderr")).not.toBeNull();
  // A late duplicate is dropped rather than shown twice.
  await act(async () => { channel?.onmessage(line(0, "stdout", "ready on http://localhost:5173")); });
  expect(container.querySelectorAll(".service-log-line")).toHaveLength(2);
});

it("restarts and clears logs through the Core, staying on the same service", async () => {
  await render();
  await click(button("Restart"));
  await settle();
  expect(calls).toContainEqual({ name: "restart_project_service", args: { id: 9 } });
  expect(container.textContent).toContain("Running");

  await click(button("Clear logs"));
  await settle();
  expect(calls).toContainEqual({ name: "clear_project_service_logs", args: { id: 9 } });
  expect(container.querySelectorAll(".service-log-line")).toHaveLength(0);
  // A line already in flight from before the clear does not pop back in; later output does.
  await act(async () => { channel?.onmessage(line(0, "stdout", "stale")); });
  expect(container.querySelectorAll(".service-log-line")).toHaveLength(0);
  await act(async () => { channel?.onmessage(line(3, "stdout", "fresh")); });
  expect(logText()).toContain("fresh");
});

it("stops the service but leaves its log readable", async () => {
  await render();
  await click(button("Stop"));
  await settle();
  expect(calls).toContainEqual({ name: "stop_project_service", args: { id: 9 } });
  expect(container.textContent).toContain("Stopped");
  expect(logText()).toContain("ready on http://localhost:5173");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop service"]')?.disabled).toBe(true);
});

it("detects a localhost URL from live output and opens it through Rust", async () => {
  service = { ...service, port: null, url: null };
  backlog = [line(0, "stdout", "starting the server")];
  await render();
  expect(button("Open http")).toBeUndefined();
  await act(async () => { channel?.onmessage(line(1, "stdout", "Local: http://0.0.0.0:4321/")); });
  const open = button("Open http://localhost:4321");
  expect(open).not.toBeUndefined();
  await click(open);
  expect(calls).toContainEqual({ name: "open_local_url", args: { url: "http://localhost:4321" } });
});

it("routes a restart port conflict to the app instead of failing silently", async () => {
  const conflicts: unknown[] = [];
  await act(async () => root.render(
    <ServiceLogPanel
      projectId={1}
      serviceId={9}
      checkout={checkout}
      visible
      onServiceConflict={(conflict) => conflicts.push(conflict)}
    />,
  ));
  await settle();

  restartResult = {
    outcome: "conflict",
    payload: {
      port: 5173,
      existing: { ...baseService },
      message: "Port 5173 is already used by Project Service 'npm run dev' (PID 900)",
    },
  };
  // Restart stops the service before it checks the port, so the refreshed header is Stopped.
  stopped = true;
  await click(button("Restart"));
  await settle();

  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ port: 5173, existing: { id: 9 } });
  expect(container.textContent).toContain("Stopped");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
