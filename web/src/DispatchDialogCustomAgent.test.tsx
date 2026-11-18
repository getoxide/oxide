// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Thread } from "./bindings";
import { DispatchDialog } from "./DispatchDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

const issue = { number: 5, title: "Crash on save", body: "It crashes.", url: "https://github.com/o/r/issues/5" };
const created = { id: 31, provider: "custom:mine", terminal: true, status: "running" } as unknown as Thread;
let calls: { name: string; args: Record<string, unknown> }[] = [];
const called = (name: string) => calls.filter((c) => c.name === name).map((c) => c.args);

beforeEach(() => {
  calls = [];
  mockIPC((name, args) => {
    calls.push({ name, args: (args ?? {}) as Record<string, unknown> });
    switch (name) {
      case "get_settings":
        return {
          settings: {
            defaultProvider: "claude",
            openThreadsAsTerminals: false,
            providers: { claude: { model: null, effort: null, permissionMode: "ask" } },
            customAgents: [{ id: "mine", name: "My agent", command: "my-agent" }],
          },
          errors: [],
        };
      case "git_status": return { branch: "main" };
      case "list_branches": return [{ name: "main", current: true, remote: false }];
      case "create_terminal_thread_from_issue": return created;
      case "terminal_issue_prompt": return "Work on GitHub issue #5 of this repository.";
      default: return null;
    }
  });
});
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); vi.restoreAllMocks(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

it("starts a Custom agent bare from an issue and pastes the prompt only when the user asks", async () => {
  const dispatched: Thread[] = [];
  await act(async () => root.render(
    <DispatchDialog projectId={1} issue={issue} onClose={() => {}} onDispatched={(t) => dispatched.push(t)} />,
  ));
  await settle();
  const select = container.querySelector<HTMLSelectElement>("select")!;
  expect([...select.options].map((o) => o.textContent)).toContain("My agent (custom)");
  await act(async () => {
    select.value = "custom:mine";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // No Model, Effort or Permission mode for a Custom agent, and the limits are stated.
  expect([...container.querySelectorAll("label")].map((l) => l.textContent).join("|")).not.toMatch(/Model|Effort|Permission mode/);
  expect(container.textContent).toContain("no status or Turns unless it emits OSC 7501");

  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle();
  const start = called("create_terminal_thread_from_issue")[0]!;
  expect(start.provider).toBe("custom:mine");
  expect(start.model).toBeNull();
  expect(start.permissionMode).toBeNull();
  // Started, but nothing was pasted yet and the dialog waits for the user.
  expect(called("deliver_agent_prompt")).toHaveLength(0);
  expect(dispatched).toHaveLength(0);
  const shown = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt to paste"]')!;
  expect(shown.value).toContain("GitHub issue #5");

  const paste = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Paste into the terminal"))!;
  await act(async () => paste.click());
  await settle();
  expect(called("deliver_agent_prompt")[0]).toMatchObject({ threadId: 31, prompt: "Work on GitHub issue #5 of this repository." });
  expect(dispatched).toEqual([created]);
});

it("can skip the paste and still opens the Thread", async () => {
  const dispatched: Thread[] = [];
  await act(async () => root.render(
    <DispatchDialog projectId={1} issue={issue} onClose={() => {}} onDispatched={(t) => dispatched.push(t)} />,
  ));
  await settle();
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "custom:mine";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle();
  const skip = [...container.querySelectorAll("button")].find((b) => b.textContent === "Skip")!;
  await act(async () => skip.click());
  expect(called("deliver_agent_prompt")).toHaveLength(0);
  expect(dispatched).toEqual([created]);
});
