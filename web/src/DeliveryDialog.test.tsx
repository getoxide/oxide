// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeliveryDialog } from "./DeliveryDialog";

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
  host.remove();
});

const render = async (props: Partial<Parameters<typeof DeliveryDialog>[0]> = {}) => {
  const onConfirm = vi.fn(async () => {});
  const onCancel = vi.fn();
  await act(async () => root.render(
    <DeliveryDialog title="Send Fix" prompt={"Fix the check\n> quoted"} destination="paste" confirmLabel="Send to Thread"
      onConfirm={onConfirm} onCancel={onCancel} {...props} />,
  ));
  return { onConfirm, onCancel };
};
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

it("shows the exact prompt and delivers nothing until the user confirms", async () => {
  const { onConfirm } = await render();
  await act(async () => {});
  expect(host.querySelector("pre")?.textContent).toBe("Fix the check\n> quoted");
  expect(host.textContent).toContain("does not press Enter");
  expect(host.textContent).toContain("external content");
  expect(onConfirm).not.toHaveBeenCalled();
  await act(async () => button("Send to Thread").click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("cancelling or pressing Escape delivers nothing", async () => {
  const { onConfirm, onCancel } = await render();
  await act(async () => {});
  await act(async () => button("Cancel").click());
  expect(onCancel).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("refuses to deliver while the agent waits for an answer and says why", async () => {
  const { onConfirm } = await render({ blocked: "The agent is waiting for an answer." });
  await act(async () => {});
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("The agent is waiting for an answer.");
  expect(button("Send to Thread").disabled).toBe(true);
  await act(async () => button("Send to Thread").click());
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps the dialog open and shows the reason when delivery fails", async () => {
  await render({ onConfirm: async () => { throw new Error("The agent is not running."); } });
  await act(async () => {});
  await act(async () => button("Send to Thread").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("The agent is not running.");
  expect(button("Send to Thread").disabled).toBe(false);
});

it("says a new Thread starts on the prompt when that is the destination", async () => {
  await render({ destination: "new-thread", confirmLabel: "Start new Thread" });
  await act(async () => {});
  expect(host.textContent).toContain("first prompt");
  expect(host.textContent).not.toContain("does not press Enter");
});
