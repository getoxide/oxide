// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));

function press(key: string, shiftKey = false) {
  act(() => container.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })));
}

it("announces bounds and supports keyboard movement, limits and reset", () => {
  const commit = vi.fn();
  function Panel() {
    const [value, setValue] = useState(240);
    return <ResizeHandle label="Resize sidebar" controls="sidebar" axis="x" edge="end"
      value={value} min={160} max={400} onResize={setValue} onCommit={commit} onCancel={() => {}} onReset={() => setValue(240)} />;
  }
  act(() => root.render(<Panel />));
  const separator = container.querySelector("[role=separator]")!;
  expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  expect(separator.getAttribute("aria-valuetext")).toBe("240 pixels");
  press("ArrowRight");
  expect(commit).toHaveBeenLastCalledWith(248);
  press("ArrowLeft", true);
  expect(commit).toHaveBeenLastCalledWith(216);
  press("Home");
  press("ArrowLeft");
  expect(commit).toHaveBeenLastCalledWith(160);
  press("End");
  press("ArrowRight");
  expect(commit).toHaveBeenLastCalledWith(400);
  press("Enter");
  expect(separator.getAttribute("aria-valuenow")).toBe("240");
});

it("moves a bottom panel upward to increase its height and ignores unrelated arrows", () => {
  const commit = vi.fn();
  act(() => root.render(<ResizeHandle label="Resize Terminal" controls="terminal" axis="y" edge="start" direction={-1}
    value={200} min={140} max={400} onResize={() => {}} onCommit={commit} onCancel={() => {}} onReset={() => {}} />));
  expect(container.querySelector("[role=separator]")?.getAttribute("aria-orientation")).toBe("horizontal");
  press("ArrowLeft");
  expect(commit).not.toHaveBeenCalled();
  press("ArrowUp");
  expect(commit).toHaveBeenLastCalledWith(208);
  press("ArrowDown", true);
  expect(commit).toHaveBeenLastCalledWith(168);
});

it("keeps dragging when the parent re-renders with new callbacks on every move, and ends cleanly", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  const commit = vi.fn();
  // Like the centre's divider: fresh inline callbacks, and every resize re-renders the parent.
  function Split() {
    const [drag, setDrag] = useState<number | null>(null);
    const [divider, setDivider] = useState(600);
    return <ResizeHandle label="Resize Terminal and Code" controls="terminal" axis="x" edge="start"
      value={drag ?? divider} min={360} max={840} onResize={(value) => setDrag(value)}
      onCommit={(value) => { setDrag(null); setDivider(value); commit(value); }} onCancel={() => setDrag(null)} onReset={() => {}} />;
  }
  act(() => root.render(<Split />));
  const separator = container.querySelector<HTMLElement>("[role=separator]")!;
  const pointer = (type: string, clientX: number) => act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.assign(event, { pointerId: 1, isPrimary: true });
    separator.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await pointer("pointerdown", 800);
  expect(separator.dataset.dragging).toBe("true");
  await pointer("pointermove", 750);
  expect(separator.getAttribute("aria-valuenow")).toBe("550");
  await pointer("pointermove", 700);
  expect(separator.getAttribute("aria-valuenow")).toBe("500");
  await pointer("pointerup", 700);
  expect(commit).toHaveBeenLastCalledWith(500);
  expect(separator.dataset.dragging).toBe("false");
  expect(document.documentElement.classList.contains("oxide-resizing-columns")).toBe(false);
  vi.unstubAllGlobals();
});
