// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createDefaultThread } from "./createDefaultThread";

afterEach(() => clearMocks());

function ipc(openThreadsAsTerminals: boolean) {
  const names: string[] = [];
  mockIPC((name) => {
    names.push(name);
    if (name === "get_settings") {
      return { settings: { defaultProvider: "claude", openThreadsAsTerminals, providers: { claude: { model: null, effort: null, permissionMode: "ask" } } }, errors: [] };
    }
    return { id: 1 };
  });
  return names;
}

it("opens a terminal Thread only when asked to and the preview setting is on", async () => {
  const names = ipc(true);
  await createDefaultThread(5, { terminal: true });
  expect(names).toContain("create_terminal_thread");
  expect(names).not.toContain("create_thread");
});

it("keeps the chat Thread with the setting off", async () => {
  const names = ipc(false);
  await createDefaultThread(5, { terminal: true });
  expect(names).toContain("create_thread");
  expect(names).not.toContain("create_terminal_thread");
});

it("starts a terminal Thread with the chosen Provider, Model, Effort and Permission mode", async () => {
  const calls: Record<string, unknown>[] = [];
  mockIPC((name, args) => {
    if (name === "get_settings") {
      return { settings: { defaultProvider: "claude", openThreadsAsTerminals: true, providers: {} }, errors: [] };
    }
    calls.push({ name, ...(args as object) });
    return { id: 1 };
  });
  await createDefaultThread(5, {
    terminal: true,
    launch: { provider: "claude", model: "sonnet", effort: "low", permissionMode: "full-access" },
  });
  expect(calls).toEqual([
    { name: "create_terminal_thread", projectId: 5, provider: "claude", model: "sonnet", effort: "low", permissionMode: "full-access" },
  ]);
});

it("passes nothing for the defaults, which Core takes from Settings", async () => {
  const calls: Record<string, unknown>[] = [];
  mockIPC((name, args) => {
    if (name === "get_settings") {
      return { settings: { defaultProvider: "claude", openThreadsAsTerminals: true, providers: {} }, errors: [] };
    }
    calls.push({ name, ...(args as object) });
    return { id: 1 };
  });
  await createDefaultThread(5, { terminal: true });
  expect(calls).toEqual([
    { name: "create_terminal_thread", projectId: 5, provider: null, model: null, effort: null, permissionMode: null },
  ]);
});

it("keeps the chat Thread for flows that send a prompt, even with the setting on", async () => {
  const names = ipc(true);
  await createDefaultThread(5);
  expect(names).toContain("create_thread");
  expect(names).not.toContain("create_terminal_thread");
});
