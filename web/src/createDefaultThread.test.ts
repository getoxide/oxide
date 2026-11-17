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

it("keeps the chat Thread for flows that send a prompt, even with the setting on", async () => {
  const names = ipc(true);
  await createDefaultThread(5);
  expect(names).toContain("create_thread");
  expect(names).not.toContain("create_terminal_thread");
});
