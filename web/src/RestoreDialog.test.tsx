// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { RestoreDialog } from "./RestoreDialog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); });

function mock(turns: { turnIndex: number; startedAt: string }[], start: boolean) {
  vi.spyOn(commands, "listTurnPicks").mockResolvedValue({
    status: "ok",
    data: turns.map((t) => ({ ...t, prompt: "", checkpointed: true })),
  });
  vi.spyOn(commands, "startStateAvailable").mockResolvedValue({ status: "ok", data: start });
  vi.spyOn(commands, "pendingRestore").mockResolvedValue({ status: "ok", data: null });
  const preview = vi.spyOn(commands, "restorePreview").mockResolvedValue({ status: "ok", data: { turnIndex: 1, files: [{ path: "a.txt", change: "rewritten" }] } });
  const restore = vi.spyOn(commands, "restoreTurn").mockResolvedValue({ status: "ok", data: { turnIndex: 1, files: [], undone: false } });
  return { preview, restore };
}

const render = () => act(async () => root.render(<RestoreDialog threadId={7} onClose={() => {}} onRestored={() => {}} />));
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent ?? "");

it("lists the Turns by time without a prompt, and the starting state", async () => {
  mock([{ turnIndex: 0, startedAt: "2026-11-18T10:00:00Z" }, { turnIndex: 1, startedAt: "2026-11-18T11:30:00Z" }], true);
  await render();
  const labels = buttons();
  expect(labels.some((l) => l.includes("before Turn 2") && l.includes("·"))).toBe(true);
  expect(labels.filter((l) => l.includes("before Turn 1"))).toHaveLength(1);
  expect(labels.some((l) => l.includes("starting state"))).toBe(true);
});

it("offers the starting state when the agent reported no Turns", async () => {
  mock([], true);
  await render();
  expect(host.textContent).not.toContain("No Turn of this Thread");
  expect(buttons().some((l) => l.includes("starting state"))).toBe(true);
});

it("previews and restores the starting state with no Turn index", async () => {
  const { preview, restore } = mock([], true);
  await render();
  const start = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("starting state"))!;
  await act(async () => start.click());
  expect(preview).toHaveBeenCalledWith(7, null);
  expect(host.textContent).toContain("when the Thread started");
  const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Restore")!;
  await act(async () => confirm.click());
  expect(restore).toHaveBeenCalledWith(7, null);
});
