// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SurfaceSearch } from "./SurfaceSearch";

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

it("clears the field on Escape and submits on Enter without reloading", async () => {
  const onChange = vi.fn();
  const onClear = vi.fn();
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(<SurfaceSearch label="Search things" value="parser" onChange={onChange} onClear={onClear} onSubmit={onSubmit} />),
  );
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search things"]')!;
  expect(input.placeholder).toBe("Search things");

  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(onClear).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  // Enter submits through the form, and the form never performs a browser navigation.
  const allowed = input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(allowed).toBe(false);
});

it("renders beside-the-field controls inside the search form", async () => {
  await act(async () =>
    root.render(
      <SurfaceSearch label="Search pull requests" value="" onChange={() => {}} onClear={() => {}}>
        <button type="button">Mine</button>
      </SurfaceSearch>,
    ),
  );
  const form = host.querySelector("form.pr-search")!;
  expect(form).not.toBeNull();
  expect(form.querySelector(".search-field")).not.toBeNull();
  expect(form.querySelector("button")?.textContent).toBe("Mine");
});
