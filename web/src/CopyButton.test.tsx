// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(async () => {
  await act(async () => root.render(null));
  vi.useRealTimers();
});

async function render(text = "hello") {
  await act(async () => root.render(<CopyButton text={text} label="response" />));
}

const button = () => container.querySelector("button")!;

it("copies the text and confirms for two seconds", async () => {
  await render("the response");
  expect(button().getAttribute("aria-label")).toBe("Copy response");
  expect(button().textContent).not.toContain("Copied!");

  vi.useFakeTimers();
  await act(async () => button().click());
  await act(async () => {
    await Promise.resolve();
  });

  expect(writeText).toHaveBeenCalledWith("the response");
  expect(button().textContent).toContain("Copied!");

  await act(async () => vi.advanceTimersByTime(1900));
  expect(button().textContent).toContain("Copied!");

  await act(async () => vi.advanceTimersByTime(100));
  expect(button().textContent).not.toContain("Copied!");
});
