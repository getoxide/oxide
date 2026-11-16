// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { LinkConfirmDialog } from "./LinkConfirmDialog";
import { openExternalLink } from "./externalLink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<LinkConfirmDialog />));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const unlisted = { status: "error", error: { message: "Unlisted link host: evil.example" } } as const;
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith(text))!;

it("opens GitHub links without asking", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  expect(await openExternalLink("https://github.com/a/b")).toBeNull();
  expect(open).toHaveBeenCalled();
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

it("shows the full host of any other link and opens it only after confirmation", async () => {
  vi.spyOn(commands, "openLink").mockResolvedValue(unlisted);
  const confirmed = vi.spyOn(commands, "openConfirmedLink").mockResolvedValue({ status: "ok", data: null });
  let result: Promise<string | null>;
  await act(async () => { result = openExternalLink("https://evil.example/x"); });
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain("evil.example");
  expect(confirmed).not.toHaveBeenCalled();
  await act(async () => button("Open evil.example").click());
  expect(await result!).toBeNull();
  expect(confirmed).toHaveBeenCalledWith("https://evil.example/x");
});

it("opens nothing when the user cancels", async () => {
  vi.spyOn(commands, "openLink").mockResolvedValue(unlisted);
  const confirmed = vi.spyOn(commands, "openConfirmedLink").mockResolvedValue({ status: "ok", data: null });
  let result: Promise<string | null>;
  await act(async () => { result = openExternalLink("https://evil.example/x"); });
  await act(async () => button("Cancel").click());
  expect(await result!).toBeNull();
  expect(confirmed).not.toHaveBeenCalled();
});

it("passes other errors through", async () => {
  vi.spyOn(commands, "openLink").mockResolvedValue({ status: "error", error: { message: "Unexpected link: x" } });
  expect(await openExternalLink("x")).toBe("Unexpected link: x");
});
