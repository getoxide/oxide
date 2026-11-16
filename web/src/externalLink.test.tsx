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

const unlisted = { status: "ok", data: "evil.example" } as const;
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

it("shows the port of the host it asks about", async () => {
  vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: "evil.example:8443" });
  vi.spyOn(commands, "openConfirmedLink").mockResolvedValue({ status: "ok", data: null });
  await act(async () => { void openExternalLink("https://evil.example:8443/x"); });
  expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain("evil.example:8443");
  await act(async () => button("Cancel").click());
});

it("does not mistake an error message that looks like the old prefix for a confirmation", async () => {
  vi.spyOn(commands, "openLink").mockResolvedValue({ status: "error", error: { message: "Unlisted link host: evil.example" } });
  expect(await openExternalLink("x")).toBe("Unlisted link host: evil.example");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
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
