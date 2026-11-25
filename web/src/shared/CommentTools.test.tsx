// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const deleteComment = vi.fn();
vi.mock("../bindings", () => ({ commands: { deleteComment: (...args: unknown[]) => deleteComment(...args), editComment: vi.fn() } }));

import { CommentTools } from "./CommentTools";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

beforeEach(() => deleteComment.mockReset().mockResolvedValue({ status: "ok", data: null }));
afterEach(async () => act(async () => root.render(null)));

const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
const dialogButton = (text: string) => Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === text)!;

async function openConfirmation(props: { onDeleted?: () => void; onError?: (m: string) => void } = {}) {
  await act(async () => root.render(
    <CommentTools projectId={1} id="IC_1" onEdit={() => {}} onDeleted={props.onDeleted ?? (() => {})} onError={props.onError ?? (() => {})} />,
  ));
  await act(async () => byLabel("Delete comment").click());
}

it("asks in a modal outside the comment, then removes the comment and reloads", async () => {
  const onDeleted = vi.fn();
  await openConfirmation({ onDeleted });
  expect(deleteComment).not.toHaveBeenCalled();
  expect(dialog()).not.toBeNull();
  expect(dialog()!.getAttribute("aria-modal")).toBe("true");
  expect(container.contains(dialog())).toBe(false);
  const confirm = dialogButton("Delete");
  expect(confirm.classList.contains("danger")).toBe(true);
  await act(async () => confirm.click());
  expect(deleteComment).toHaveBeenCalledWith(1, "IC_1");
  expect(onDeleted).toHaveBeenCalled();
});

it("focuses Cancel, which closes the modal and returns focus to the Delete icon", async () => {
  await openConfirmation();
  expect(document.activeElement).toBe(dialogButton("Cancel"));
  await act(async () => dialogButton("Cancel").click());
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(byLabel("Delete comment"));
  expect(deleteComment).not.toHaveBeenCalled();
});

it("cancels on Escape and on a click on the backdrop", async () => {
  await openConfirmation();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(dialog()).toBeNull();
  await act(async () => byLabel("Delete comment").click());
  const backdrop = dialog()!.parentElement!;
  await act(async () => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await act(async () => backdrop.click());
  expect(dialog()).toBeNull();
  expect(deleteComment).not.toHaveBeenCalled();
});

it("stays open and cannot be dismissed while deleting", async () => {
  let finish: (v: unknown) => void = () => {};
  deleteComment.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await openConfirmation();
  await act(async () => dialogButton("Delete").click());
  const deleting = Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent?.includes("Deleting"))!;
  expect(deleting.disabled).toBe(true);
  expect(dialogButton("Cancel").disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  const backdrop = dialog()!.parentElement!;
  await act(async () => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await act(async () => backdrop.click());
  expect(dialog()).not.toBeNull();
  await act(async () => finish({ status: "ok", data: null }));
});

it("reports a failed delete and leaves the comment", async () => {
  deleteComment.mockResolvedValue({ status: "error", error: { message: "nope" } });
  const onError = vi.fn();
  const onDeleted = vi.fn();
  await openConfirmation({ onError, onDeleted });
  await act(async () => dialogButton("Delete").click());
  expect(onError).toHaveBeenCalledWith("nope");
  expect(onDeleted).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
});

it("offers Edit and reports it", async () => {
  const onEdit = vi.fn();
  await act(async () => root.render(<CommentTools projectId={1} id="IC_1" onEdit={onEdit} onDeleted={() => {}} onError={() => {}} />));
  await act(async () => byLabel("Edit comment").click());
  expect(onEdit).toHaveBeenCalled();
});
