// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { cancelActiveFileDrag, startFileDrag } from "./fileDrag";
import { terminalPaths, useTerminalTransfer } from "./useTerminalTransfer";

const native = vi.hoisted(() => ({ drop: vi.fn<(event: unknown) => void>(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: (callback: typeof native.drop) => { native.drop = callback; return Promise.resolve(native.stop); } }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
afterEach(async () => {
  cancelActiveFileDrag();
  await act(async () => root.render(null));
  vi.clearAllMocks();
});
function Harness({ insert, visible = true }: { insert: (text: string) => void; visible?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const transfer = useTerminalTransfer(element, visible, insert);
  return <div ref={element} data-terminal data-dragging={transfer.dragging || undefined} />;
}

function dispatchPointer(type: "pointermove" | "pointerup", clientX: number, clientY: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  window.dispatchEvent(event);
}

it("quotes shell metacharacters, spaces and apostrophes literally on Windows and POSIX", () => {
  expect(terminalPaths(["C:\\my shots\\it's $(bad).png"], true)).toBe("'C:\\my shots\\it''s $(bad).png' ");
  expect(terminalPaths(["/tmp/it's $(bad).png"], false)).toBe("'/tmp/it'\\''s $(bad).png' ");
});

it("accepts native drops only over the visible terminal, scaled by the display DPI", async () => {
  const insert = vi.fn();
  await act(async () => root.render(<Harness insert={insert} />));
  vi.spyOn(host.querySelector("[data-terminal]")!, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 } as DOMRect);
  const drop = (x: number, y: number) => native.drop({ payload: { type: "drop", paths: ["C:\\image.png"], position: { x: x * window.devicePixelRatio, y: y * window.devicePixelRatio } } });
  act(() => drop(5, 5));
  expect(insert).not.toHaveBeenCalled();
  act(() => drop(50, 50));
  expect(insert).toHaveBeenCalledExactlyOnceWith("'C:\\image.png' ");
  await act(async () => root.render(<Harness visible={false} insert={insert} />));
  act(() => drop(50, 50));
  expect(insert).toHaveBeenCalledTimes(1);
  expect(native.stop).toHaveBeenCalled();
});

it("accepts internal pointer file drags over the terminal and cancels on Escape", async () => {
  const insert = vi.fn();
  await act(async () => root.render(<Harness insert={insert} />));
  const target = host.querySelector("[data-terminal]")!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, top: 20, right: 300, bottom: 220, width: 200, height: 200 } as DOMRect);

  act(() => {
    startFileDrag({ path: "/Users/me/my file.txt", label: "my file.txt", startX: 10, startY: 50, pointerId: 7 });
    dispatchPointer("pointermove", 50, 50, 7);
  });
  expect(target.hasAttribute("data-dragging")).toBe(false);
  expect(document.querySelector(".file-drag-ghost")?.textContent).toBe("my file.txt");

  act(() => { dispatchPointer("pointermove", 150, 80, 7); });
  expect(target.getAttribute("data-dragging")).toBe("true");

  act(() => { dispatchPointer("pointerup", 150, 80, 7); });
  expect(target.hasAttribute("data-dragging")).toBe(false);
  expect(document.querySelector(".file-drag-ghost")).toBeNull();
  expect(insert).toHaveBeenCalledExactlyOnceWith("'/Users/me/my file.txt' ");

  // Dropping outside does not insert.
  act(() => {
    startFileDrag({ path: "/Users/me/other.txt", label: "other.txt", startX: 10, startY: 50, pointerId: 8 });
    dispatchPointer("pointermove", 40, 50, 8);
    dispatchPointer("pointerup", 40, 50, 8);
  });
  expect(insert).toHaveBeenCalledTimes(1);

  // Escape cancels an active drag.
  act(() => {
    startFileDrag({ path: "/Users/me/esc.txt", label: "esc.txt", startX: 10, startY: 50, pointerId: 9 });
    dispatchPointer("pointermove", 150, 80, 9);
  });
  expect(target.getAttribute("data-dragging")).toBe("true");
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(target.hasAttribute("data-dragging")).toBe(false);
  expect(document.querySelector(".file-drag-ghost")).toBeNull();
});
