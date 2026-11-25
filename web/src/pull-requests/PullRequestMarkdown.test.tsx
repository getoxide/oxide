// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { Markdown } from "./PullRequestMarkdown";

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
  vi.restoreAllMocks();
});

it("shows a mention as a chip that opens the user's GitHub profile", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await act(async () => root.render(<Markdown source="Thanks @octo-cat, mail a@b.com" />));
  const chip = host.querySelector(".md-mention") as HTMLButtonElement;
  expect(chip.tagName).toBe("BUTTON");
  expect(chip.textContent).toBe("@octo-cat");
  expect(host.textContent).toBe("Thanks @octo-cat, mail a@b.com");
  await act(async () => chip.click());
  expect(open).toHaveBeenCalledWith("https://github.com/octo-cat");
});
