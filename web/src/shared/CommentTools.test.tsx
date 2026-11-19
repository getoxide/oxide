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

it("asks before deleting, then removes the comment and reloads", async () => {
  const onDeleted = vi.fn();
  await act(async () => root.render(<CommentTools projectId={1} id="IC_1" onEdit={() => {}} onDeleted={onDeleted} onError={() => {}} />));
  await act(async () => byLabel("Delete comment").click());
  expect(deleteComment).not.toHaveBeenCalled();
  const confirm = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Delete")!;
  await act(async () => confirm.click());
  expect(deleteComment).toHaveBeenCalledWith(1, "IC_1");
  expect(onDeleted).toHaveBeenCalled();
});

it("offers Edit and reports it", async () => {
  const onEdit = vi.fn();
  await act(async () => root.render(<CommentTools projectId={1} id="IC_1" onEdit={onEdit} onDeleted={() => {}} onError={() => {}} />));
  await act(async () => byLabel("Edit comment").click());
  expect(onEdit).toHaveBeenCalled();
});
