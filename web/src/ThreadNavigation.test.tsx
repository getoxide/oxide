// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); vi.restoreAllMocks(); });
const snapshot = (id: number) => ({ thread: { id, projectId: 1, title: `Conversation ${id}`, provider: "codex", status: "completed", permissionMode: "auto-edit" }, capabilities: { reasoningText: true }, supportedPermissionModes: ["auto-edit"], turns: [], turnOffset: 0, turnCount: 0, lastSeq: 0 });
it("shows an integrated skeleton for a new Thread, restores a visited one immediately, and refreshes it", async () => {
  let deferred = false;
  let finish!: (value: unknown) => void;
  mockIPC((command, args) => {
    if (command === "subscribe_thread") return deferred ? new Promise((resolve) => { finish = resolve; }) : snapshot((args as { threadId: number }).threadId);
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit"] };
    if (command === "git_status") return { branch: "main" };
    return [];
  });
  const onStatusChange = vi.fn();
  const render = (threadId: number) => act(async () => root.render(<ThreadView threadId={threadId} projectId={1} draft="follow up" onThreadCreated={vi.fn()} onStatusChange={onStatusChange} prefill={null} onPrefillUsed={vi.fn()} onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await render(7);
  expect(host.textContent).toContain("Conversation 7");
  deferred = true;
  await render(8);
  expect(host.querySelector('.transcript .skeleton')).not.toBeNull();
  expect(host.textContent).not.toContain("Conversation 7");
  await act(async () => finish(snapshot(8)));
  await render(7);
  expect(host.textContent).toContain("Conversation 7");
  expect(host.querySelector('.transcript .skeleton')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(true);
  await act(async () => finish(snapshot(7)));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(false);
});

it("caches and restores switched Threads without calling JSON.stringify on the transcript", async () => {
  const bigContent = "x".repeat(4000);
  const fullSnapshot = (id: number) => ({
    ...snapshot(id),
    turns: [{
      id: id * 10,
      turnIndex: 0,
      prompt: `Prompt ${id}`,
      model: null,
      effort: null,
      segments: [{ kind: "text", text: `Prompt ${id}` }],
      status: "completed",
      startedAt: "2026-10-22T10:00:00Z",
      completedAt: "2026-10-22T10:00:05Z",
      items: [{
        id: id * 100,
        itemIndex: 0,
        kind: "agent_message",
        content: bigContent,
        parentItemIndex: null,
        command: { line: null, outcome: "unknown", exitCode: null },
        createdAt: "2026-10-22T10:00:02Z",
      }],
      error: null,
      approvals: [],
      unknownEvents: [],
    }],
    turnCount: 1,
  });

  mockIPC((command, args) => {
    if (command === "subscribe_thread") return fullSnapshot((args as { threadId: number }).threadId);
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit"] };
    if (command === "git_status") return { branch: "main" };
    return [];
  });

  const render = (threadId: number) => act(async () => root.render(<ThreadView threadId={threadId} projectId={1} draft="" onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()} onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await render(10);
  expect(host.textContent).toContain("Conversation 10");

  const stringifySpy = vi.spyOn(JSON, "stringify");
  await render(11);
  expect(host.textContent).toContain("Conversation 11");
  await render(10);
  expect(host.textContent).toContain("Conversation 10");

  const serializedTranscript = stringifySpy.mock.calls.some(([arg]) =>
    Array.isArray(arg) && arg.some((entry) => entry && typeof entry === "object" && "turns" in entry),
  );
  expect(serializedTranscript).toBe(false);
});
