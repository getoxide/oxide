// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { OXIDE_FILE_MIME, terminalPaths, useTerminalTransfer } from "./useTerminalTransfer";

const native = vi.hoisted(() => ({ drop: vi.fn<(event: unknown) => void>(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: (callback: typeof native.drop) => { native.drop = callback; return Promise.resolve(native.stop); } }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); vi.clearAllMocks(); });
function Harness({ insert, visible = true }: { insert: (text: string) => void; visible?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const transfer = useTerminalTransfer(element, visible, insert);
  return <div ref={element} data-terminal data-dragging={transfer.dragging || undefined} />;
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

it("accepts internal file tree drags carrying OXIDE_FILE_MIME and inserts the quoted path", async () => {
  const insert = vi.fn();
  await act(async () => root.render(<Harness insert={insert} />));
  const target = host.querySelector("[data-terminal]")!;
  const dataTransfer = {
    types: [OXIDE_FILE_MIME, "text/plain"],
    dropEffect: "none",
    getData: (type: string) => (type === OXIDE_FILE_MIME ? "/Users/me/my file.txt" : ""),
  };

  const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
  await act(async () => { target.dispatchEvent(dragOver); });
  expect(dragOver.defaultPrevented).toBe(true);
  expect(target.getAttribute("data-dragging")).toBe("true");

  const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(dropEvent, "dataTransfer", { value: dataTransfer });
  await act(async () => { target.dispatchEvent(dropEvent); });
  expect(dropEvent.defaultPrevented).toBe(true);
  expect(target.hasAttribute("data-dragging")).toBe(false);
  expect(insert).toHaveBeenCalledExactlyOnceWith("'/Users/me/my file.txt' ");
});
