// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RefreshNotice } from "./RefreshNotice";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
});

it("refreshes silently: no spinner pill while a background fetch runs", async () => {
  await act(async () => root.render(<RefreshNotice query={{ state: "ready", data: [], refreshing: true }} />));
  expect(host.querySelector(".refresh-spinner")).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toBe("");
});

it("still notes a failed refresh under the stale data", async () => {
  await act(async () =>
    root.render(<RefreshNotice query={{ state: "ready", data: [], refreshing: false, refreshError: "rate limited" }} />),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Couldn't refresh: rate limited");
});
