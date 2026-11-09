// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ProjectService_Serialize as ProjectService, ProjectServiceConflict } from "./bindings";
import { ProjectServices } from "./ProjectServices";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

type Call = { command: string; args: unknown };
let calls: Call[] = [];
let servicesByProject: Record<number, ProjectService[]> = {};
let stopError: { message: string } | null = null;
let restartResult: unknown = null;

const service = (id: number, projectId = 1, overrides: Partial<ProjectService> = {}): ProjectService => ({
  id,
  projectId,
  threadId: null,
  command: `npm run dev${id}`,
  checkout: "/repo",
  status: "running",
  pid: 1000 + id,
  port: 3000 + id - 1,
  url: `http://localhost:${3000 + id - 1}`,
  startedAt: "2026-01-01T00:00:00Z",
  exitCode: null,
  ...overrides,
});

beforeEach(() => {
  calls = [];
  servicesByProject = {};
  stopError = null;
  restartResult = null;
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "list_project_services":
        return servicesByProject[(args as { projectId: number }).projectId] ?? [];
      case "stop_project_service":
        return stopError ? Promise.reject(stopError) : null;
      case "restart_project_service":
        return restartResult ?? { outcome: "started", payload: service(4) };
      default:
        return null;
    }
  }, { shouldMockEvents: true });
});

afterEach(async () => {
  await act(async () => root.render(null));
  clearMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const renderServices = (projectId: number, opened: number[] = [], stopped: number[] = [], conflicts: ProjectServiceConflict[] = []) => act(async () => {
  root.render(
    <ProjectServices
      projectId={projectId}
      onOpenService={(id) => opened.push(id)}
      onStopService={(id) => stopped.push(id)}
      onServiceConflict={(conflict) => conflicts.push(conflict)}
    />,
  );
});
const rows = () => Array.from(container.querySelectorAll<HTMLElement>(".service-item"));
const listCalls = () => calls.filter((call) => call.command === "list_project_services");

it("renders nothing when the Project has no running services", async () => {
  await renderServices(1);
  await settle();

  expect(container.querySelector(".project-services")).toBeNull();
  expect(rows()).toEqual([]);
  expect(listCalls().map((call) => (call.args as { projectId: number }).projectId)).toEqual([1]);
});

it("shows each service's command, running status and detected port", async () => {
  servicesByProject[1] = [service(1), service(2, 1, { port: null, url: null })];
  await renderServices(1);
  await settle();

  expect(rows()).toHaveLength(2);
  const first = rows()[0];
  expect(first.querySelector(".service-dot")?.getAttribute("aria-label")).toBe("Status: running");
  expect(first.textContent).toContain("npm run dev1");
  expect(first.querySelector(".service-port")?.textContent).toBe(":3000");
  expect(rows()[1].textContent).toContain("npm run dev2");
  expect(rows()[1].querySelector(".service-port")).toBeNull();
  expect(container.querySelector(".project-services-header")?.textContent).toContain("Services");
});

it("opens a service's log view when its row is clicked", async () => {
  servicesByProject[1] = [service(7)];
  const opened: number[] = [];
  await renderServices(1, opened);
  await settle();

  await act(async () => { container.querySelector<HTMLElement>(".service-open")!.click(); });

  expect(opened).toEqual([7]);
});

it("stops a service from its quick-stop button without opening it", async () => {
  servicesByProject[1] = [service(4)];
  const opened: number[] = [];
  const stopped: number[] = [];
  await renderServices(1, opened, stopped);
  await settle();

  // The Core drops a stopped service from the running list.
  servicesByProject[1] = [];
  await act(async () => { container.querySelector<HTMLElement>(".service-stop")!.click(); });
  await settle();

  const stop = calls.find((call) => call.command === "stop_project_service");
  expect(stop?.args).toEqual({ id: 4 });
  expect(opened).toEqual([]);
  expect(stopped).toEqual([4]);
  expect(rows()).toEqual([]);
});

it("restarts a service from its sidebar button without opening it", async () => {
  servicesByProject[1] = [service(4)];
  const opened: number[] = [];
  await renderServices(1, opened);
  await settle();

  await act(async () => { container.querySelector<HTMLElement>(".service-restart")!.click(); });
  await settle();

  const restart = calls.find((call) => call.command === "restart_project_service");
  expect(restart?.args).toEqual({ id: 4 });
  expect(opened).toEqual([]);
});

it("routes a sidebar restart conflict to the app dialog", async () => {
  servicesByProject[1] = [service(4)];
  const conflicts: ProjectServiceConflict[] = [];
  restartResult = {
    outcome: "conflict",
    payload: {
      port: 3003,
      existing: service(1),
      message: "Port 3003 is already used by Project Service 'npm run dev1' (PID 1001)",
    },
  };
  await renderServices(1, [], [], conflicts);
  await settle();

  await act(async () => { container.querySelector<HTMLElement>(".service-restart")!.click(); });
  await settle();

  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ port: 3003, existing: { id: 1 } });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("collapses and expands the services section", async () => {
  servicesByProject[1] = [service(1), service(2)];
  await renderServices(1);
  await settle();

  const header = container.querySelector<HTMLButtonElement>(".project-services-header")!;
  expect(header.getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toHaveLength(2);

  await act(async () => header.click());
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(rows()).toEqual([]);
  expect(container.querySelector(".project-services")).not.toBeNull();

  await act(async () => header.click());
  expect(header.getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toHaveLength(2);
});

it("refetches when the Project Services change event names this Project", async () => {
  servicesByProject[1] = [service(1)];
  await renderServices(1);
  await settle();
  expect(rows()).toHaveLength(1);

  servicesByProject[1] = [service(1), service(2)];
  await act(async () => { await emit("project-services-changed", 1); });
  await settle();

  expect(rows()).toHaveLength(2);
});

it("ignores change events for another Project", async () => {
  servicesByProject[1] = [service(1)];
  await renderServices(1);
  await settle();

  servicesByProject[1] = [service(1), service(2)];
  await act(async () => { await emit("project-services-changed", 2); });
  await settle();

  expect(rows()).toHaveLength(1);
});

it("drops the previous Project's services when the selection changes", async () => {
  servicesByProject[1] = [service(1)];
  servicesByProject[2] = [service(2, 2)];
  await renderServices(1);
  await settle();
  expect(container.textContent).toContain("npm run dev1");

  await renderServices(2);
  await settle();

  expect(container.textContent).toContain("npm run dev2");
  expect(container.textContent).not.toContain("npm run dev1");
  expect(listCalls().map((call) => (call.args as { projectId: number }).projectId)).toEqual([1, 2]);
});

it("surfaces a failed stop inline instead of crashing", async () => {
  servicesByProject[1] = [service(4)];
  stopError = { message: "service process is gone" };
  await renderServices(1);
  await settle();

  await act(async () => { container.querySelector<HTMLElement>(".service-stop")!.click(); });
  await settle();

  expect(container.querySelector('[role="alert"]')?.textContent).toBe("service process is gone");
  expect(rows()).toHaveLength(1);
});
