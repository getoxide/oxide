// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalRow } from "./TerminalRow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("ul");
document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); });

async function render() {
  const onRename = vi.fn();
  await act(async () => root.render(
    <TerminalRow name="Terminal 1" current running={null} onSelect={() => {}} onRename={onRename} onClose={() => {}} />,
  ));
  return onRename;
}
const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Rename Terminal 1"]');
const type = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
  field()!.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (name: string) => act(async () => { field()!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });

it("renames in place on a Force Click, with the whole name selected", async () => {
  const onRename = await render();
  const force = new Event("webkitmouseforcewillbegin", { cancelable: true });
  host.querySelector(".terminal-item")!.dispatchEvent(force);
  expect(force.defaultPrevented).toBe(true);
  await act(async () => { host.querySelector(".terminal-item")!.dispatchEvent(new Event("webkitmouseforcedown", { cancelable: true })); });
  expect(document.activeElement).toBe(field());
  expect([field()!.selectionStart, field()!.selectionEnd]).toEqual([0, "Terminal 1".length]);
  await type("server");
  await key("Enter");
  expect(onRename).toHaveBeenCalledWith("server");
  expect(field()).toBeNull();
});

it("keeps the old name when Escape leaves the field", async () => {
  const onRename = await render();
  await act(async () => { host.querySelector(".terminal-item")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await type("discarded");
  await key("Escape");
  expect(field()).toBeNull();
  expect(onRename).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Terminal 1");
});
