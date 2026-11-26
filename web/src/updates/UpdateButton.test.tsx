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
  operation:
    | { kind: "idle" }
    | { kind: "downloading"; downloaded: number; total: number | null }
    | { kind: "installing" }
    | { kind: "installed"; staged: boolean };
  error: string | null;
};

const behind: State = {
  channel: "inApp",
  currentVersion: "0.1.0",
  lastCheckedAt: 1,
  available: { version: "0.2.0", releaseNotesUrl: "https://github.com/getoxide/oxide/releases/tag/v0.2.0" },
  operation: { kind: "idle" },
  error: null,
};

let host: HTMLDivElement;
let root: Root;
let current: () => State | Error;
let opened: string[];
let calls: string[];
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
  calls = [];
  pushed = undefined;
  current = () => behind;
  mockIPC((command, args) => {
    if (command === "update_state") {
      const state = current();
      if (state instanceof Error) throw state;
      return state;
    }
    if (command === "install_update" || command === "restart_for_update") {
      calls.push(command);
      return null;
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

  const popover = () => document.body.querySelector('[role="dialog"]');
  const press = async (label: string) => {
    const target = [...popover()!.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
    await act(async () => target!.click());
  };

  it("installs from the popover", async () => {
    await render();
    await act(async () => button()!.click());
    await press("Install update");
    expect(calls).toEqual(["install_update"]);
  });

  it("shows the download progress", async () => {
    current = () => ({ ...behind, operation: { kind: "downloading", downloaded: 25, total: 100 } });
    await render();
    await act(async () => button()!.click());
    const bar = popover()!.querySelector("progress")!;
    expect(bar.value).toBe(25);
    expect(bar.max).toBe(100);
    expect(popover()!.textContent).toContain("25%");
    expect([...popover()!.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Install update");
  });

  it("shows what failed and offers the install again", async () => {
    current = () => ({ ...behind, error: "The signature does not match." });
    await render();
    await act(async () => button()!.click());
    expect(popover()!.querySelector('[role="alert"]')!.textContent).toContain("The signature does not match.");
    await press("Try again");
    expect(calls).toEqual(["install_update"]);
  });

  it("asks to restart once installed, warning that Terminal programs end", async () => {
    current = () => ({ ...behind, operation: { kind: "installed", staged: false } });
    await render();
    await act(async () => button()!.click());
    expect(popover()!.textContent).toMatch(/running Terminal programs will end/i);
    await press("Restart now");
    expect(calls).toEqual(["restart_for_update"]);
  });

  it("keeps the session running on Later and leaves a way back to the restart", async () => {
    current = () => ({ ...behind, operation: { kind: "installed", staged: true } });
    await render();
    await act(async () => button()!.click());
    await press("Later");
    expect(popover()).toBeNull();
    expect(calls).toEqual([]);
    expect(button()).not.toBeNull();
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
