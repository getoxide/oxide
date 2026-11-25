// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REFRESH_INTERVAL_MS, REVALIDATE_AFTER_MS, useAutoRefresh } from "./useAutoRefresh";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let tick = -1;

type ProbeProps = { enabled?: boolean; intervalMs?: number | null; maxTicks?: number };
function Probe(props: ProbeProps) {
  const value = useAutoRefresh(props);
  useEffect(() => {
    tick = value;
  });
  return null;
}
const render = (props: ProbeProps = {}) => act(async () => root.render(<Probe {...props} />));
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const fire = (target: EventTarget, type: string) => act(async () => void target.dispatchEvent(new Event(type)));
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("ticks on its interval while the window is visible, and not while it is hidden", async () => {
  await render();
  expect(tick).toBe(0);
  await advance(REFRESH_INTERVAL_MS);
  expect(tick).toBe(1);
  visibility = "hidden";
  await advance(REFRESH_INTERVAL_MS * 3);
  expect(tick).toBe(1);
});

it("follows a faster interval when asked", async () => {
  await render({ intervalMs: 6_000 });
  await advance(6_000);
  expect(tick).toBe(1);
  await advance(6_000);
  expect(tick).toBe(2);
});

it("runs no timer without a period, but still revalidates on focus", async () => {
  await render({ intervalMs: null });
  await advance(REFRESH_INTERVAL_MS * 3);
  expect(tick).toBe(0);
  await fire(window, "focus");
  expect(tick).toBe(1);
});

it("stops its timer after the given number of ticks, and does not revalidate when the period changes", async () => {
  await render({ intervalMs: 6_000, maxTicks: 2 });
  await advance(6_000 * 5);
  expect(tick).toBe(2);
  await render({ intervalMs: null });
  expect(tick).toBe(2);
  await render({ intervalMs: 6_000 });
  expect(tick).toBe(2);
  await advance(6_000);
  expect(tick).toBe(3);
});

it("pauses completely while disabled: no timer, no focus", async () => {
  await render({ enabled: false });
  await advance(REFRESH_INTERVAL_MS * 3);
  await fire(window, "focus");
  expect(tick).toBe(0);
});

it("revalidates on focus and on the window becoming visible, once the last tick is stale", async () => {
  await render();
  await fire(window, "focus");
  expect(tick).toBe(0);
  await advance(REVALIDATE_AFTER_MS);
  await fire(window, "focus");
  expect(tick).toBe(1);

  visibility = "hidden";
  await advance(REVALIDATE_AFTER_MS);
  await fire(document, "visibilitychange");
  expect(tick).toBe(1);
  visibility = "visible";
  await fire(document, "visibilitychange");
  expect(tick).toBe(2);
});

it("revalidates when a hidden Surface is shown again after a while, not on a quick switch", async () => {
  await render();
  await render({ enabled: false });
  await render({ enabled: true });
  expect(tick).toBe(0);

  await render({ enabled: false });
  await advance(REFRESH_INTERVAL_MS * 2);
  expect(tick).toBe(0);
  await render({ enabled: true });
  expect(tick).toBe(1);
});
