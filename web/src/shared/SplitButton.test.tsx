// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SplitButton, SplitMenu, SplitMenuItem } from "./SplitButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
});

const primary = vi.fn();
const first = vi.fn();
const second = vi.fn();

async function render(props: { disabled?: boolean; menuDisabled?: boolean; pending?: boolean; risky?: boolean } = {}) {
  await act(async () =>
    root.render(
      <SplitButton label="Close as completed" onClick={primary} menuLabel="Close options" {...props}>
        <SplitMenu label="Close reason">
          <SplitMenuItem title="Close as completed" help="Done" onSelect={first} />
          <SplitMenuItem title="Close as not planned" help="Stale" onSelect={second} />
        </SplitMenu>
      </SplitButton>,
    ),
  );
}
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-label="Close options"]')!;
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const key = (target: Element, k: string) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

afterEach(() => {
  primary.mockReset();
  first.mockReset();
  second.mockReset();
});

it("renders one blue group: the action and an attached chevron that opens a menu", async () => {
  await render();
  const group = host.querySelector(".split-btn")!;
  const buttons = group.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0].classList.contains("primary")).toBe(true);
  expect(buttons[1].classList.contains("primary")).toBe(true);
  expect(toggle().getAttribute("aria-haspopup")).toBe("menu");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await act(async () => buttons[0].click());
  expect(primary).toHaveBeenCalledTimes(1);
  expect(items()).toHaveLength(0);
});

it("runs a menu item with one click and closes the menu", async () => {
  await render();
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => items()[1].click());
  expect(second).toHaveBeenCalledTimes(1);
  expect(primary).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

it("moves through the items with the arrow keys and closes on Escape, back on the chevron", async () => {
  await render();
  await act(async () => toggle().click());
  expect(document.activeElement).toBe(items()[0]);
  await key(items()[0], "ArrowDown");
  expect(document.activeElement).toBe(items()[1]);
  await key(items()[1], "ArrowDown");
  expect(document.activeElement).toBe(items()[0]);
  await key(items()[0], "ArrowUp");
  expect(document.activeElement).toBe(items()[1]);
  await key(items()[1], "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(toggle());
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
});

it("keeps the chevron usable while only the main action is disabled", async () => {
  await render({ disabled: true });
  expect(host.querySelector<HTMLButtonElement>(".split-btn-main")!.disabled).toBe(true);
  expect(toggle().disabled).toBe(false);
});

it("locks both halves while an action is pending, and marks a risky merge", async () => {
  await render({ pending: true, risky: true });
  const group = host.querySelector(".split-btn")!;
  expect(group.classList.contains("risky")).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(".split-btn-main")!.disabled).toBe(true);
  expect(host.querySelector(".split-btn-main")!.classList.contains("pending")).toBe(true);
  expect(toggle().disabled).toBe(true);
});
