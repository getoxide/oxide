// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { UpdateButton } from "./UpdateButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type State = {
  channel: "inApp" | "apt" | "dnf" | "development";
  currentVersion: string;
  lastCheckedAt: number | null;
  available: { version: string; releaseNotesUrl: string } | null;
};

const behind: State = {
  channel: "inApp",
  currentVersion: "0.1.0",
  lastCheckedAt: 1,
  available: { version: "0.2.0", releaseNotesUrl: "https://github.com/getoxide/oxide/releases/tag/v0.2.0" },
};

let host: HTMLDivElement;
let root: Root;
let current: () => State | Error;
let opened: string[];
let pushed: ((payload: State) => void) | undefined;

vi.mock("../shared/ipc", async (original) => ({
  ...(await original<typeof import("../shared/ipc")>()),
  listenTo: (_event: string, handler: (payload: State) => void) => {
    pushed = handler;
    return () => { pushed = undefined; };
  },
}));

async function render() {
  await act(async () => root.render(<UpdateButton />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="Update available"]');

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  opened = [];
  pushed = undefined;
  current = () => behind;
  mockIPC((command, args) => {
    if (command === "update_state") {
      const state = current();
      if (state instanceof Error) throw state;
      return state;
    }
    if (command === "open_link") {
      opened.push((args as { url: string }).url);
      return null;
    }
    return null;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearMocks();
});

describe("UpdateButton", () => {
  it("appears when the feed has a newer version", async () => {
    await render();
    expect(button()?.textContent).toContain("Update");
  });

  it("is absent with the latest version installed", async () => {
    current = () => ({ ...behind, available: null });
    await render();
    expect(button()).toBeNull();
  });

  it("is absent in a development build even if a state names an update", async () => {
    current = () => ({ ...behind, channel: "development" });
    await render();
    expect(button()).toBeNull();
  });

  it("shows nothing and no error when Core cannot answer", async () => {
    current = () => new Error("no network");
    await render();
    expect(button()).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("opens a popover with the installed version, the new version and the release notes link", async () => {
    await render();
    await act(async () => button()!.click());
    const popover = document.body.querySelector('[role="dialog"]')!;
    expect(popover.textContent).toContain("0.1.0");
    expect(popover.textContent).toContain("0.2.0");
    const link = popover.querySelector("a")!;
    expect(link.textContent).toContain("Release notes");
    await act(async () => link.click());
    expect(opened).toEqual(["https://github.com/getoxide/oxide/releases/tag/v0.2.0"]);
  });

  it("follows the state Core pushes", async () => {
    current = () => ({ ...behind, available: null });
    await render();
    expect(button()).toBeNull();
    await act(async () => pushed?.(behind));
    expect(button()).not.toBeNull();
    await act(async () => pushed?.({ ...behind, available: null }));
    expect(button()).toBeNull();
  });
});
