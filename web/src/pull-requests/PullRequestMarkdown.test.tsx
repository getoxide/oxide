// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { Markdown, MarkdownImages } from "./PullRequestMarkdown";

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

const PNG_DATA = "data:image/png;base64,iVBORw0KGgo=";

it("loads a GitHub image through Core, from its signed URL, once", async () => {
  const fetch = vi.spyOn(commands, "fetchGithubImage").mockResolvedValue({ status: "ok", data: PNG_DATA });
  const asset = "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
  const signed = "https://private-user-images.githubusercontent.com/1/2-11111111-2222-3333-4444-555555555555.png?jwt=x";
  const view = (n: number) => (
    <MarkdownImages projectId={3} signed={[{ url: asset, signedUrl: signed }]}>
      <Markdown key={n} source={`![The panel](${asset})`} />
    </MarkdownImages>
  );
  await act(async () => root.render(view(1)));
  const img = host.querySelector("img") as HTMLImageElement;
  expect(img.getAttribute("src")).toBe(PNG_DATA);
  expect(img.alt).toBe("The panel");
  expect(fetch).toHaveBeenCalledWith(3, signed);
  await act(async () => root.render(view(2)));
  expect(host.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("offers an image on another host as a link instead of loading it", async () => {
  const fetch = vi.spyOn(commands, "fetchGithubImage");
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await act(async () =>
    root.render(
      <MarkdownImages projectId={3} signed={[]}>
        <Markdown source="![build status](https://img.shields.io/badge/ci-green.png)" />
      </MarkdownImages>,
    ),
  );
  expect(host.querySelector("img")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("build status");
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open image")!;
  await act(async () => button.click());
  expect(open).toHaveBeenCalledWith("https://img.shields.io/badge/ci-green.png");
});

it("falls back to the link when GitHub does not send the image", async () => {
  vi.spyOn(commands, "fetchGithubImage").mockResolvedValue({ status: "error", error: { message: "GitHub did not send the image." } });
  await act(async () =>
    root.render(
      <MarkdownImages projectId={3} signed={[]}>
        <Markdown source='<img alt="Broken" src="https://user-images.githubusercontent.com/1/2-broken.png">' />
      </MarkdownImages>,
    ),
  );
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Broken");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Open image")).toBe(true);
});
