// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { UpdatesSettingsSection } from "./UpdatesSettingsSection";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type State = {
  channel: "inApp" | "apt" | "dnf" | "development";
  installLocation?: "allowed" | "moveToApplications";
  currentVersion: string;
  lastCheckedAt: number | null;
  lastCheck: { at: number; succeeded: boolean } | null;
  checking: boolean;
  available: { version: string; releaseNotesUrl: string } | null;
  operation:
    | { kind: "idle" }
    | { kind: "downloading"; downloaded: number; total: number | null }
    | { kind: "installing" }
    | { kind: "installed"; staged: boolean };
  error: string | null;
};

const upToDate: State = {
  channel: "inApp",
  currentVersion: "0.1.0",
  lastCheckedAt: 1_700_000_000,
  lastCheck: { at: 1_700_000_000, succeeded: true },
  checking: false,
  available: null,
  operation: { kind: "idle" },
  error: null,
};
const behind: State = {
  ...upToDate,
  available: { version: "0.2.0", releaseNotesUrl: "https://github.com/getoxide/oxide/releases/tag/v0.2.0" },
};

let host: HTMLDivElement;
let root: Root;
let current: State;
let calls: string[];
let checkResult: State | Error;
let pushed: ((payload: State) => void) | undefined;

vi.mock("../shared/ipc", async (original) => ({
  ...(await original<typeof import("../shared/ipc")>()),
  listenTo: (_event: string, handler: (payload: State) => void) => {
    pushed = handler;
    return () => { pushed = undefined; };
  },
}));

async function render(state: State) {
  current = state;
  await act(async () => root.render(<UpdatesSettingsSection />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

const text = () => host.textContent ?? "";
const named = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  pushed = undefined;
  checkResult = upToDate;
  mockIPC((command) => {
    if (command === "update_state") return current;
    if (command === "check_for_updates") {
      calls.push(command);
      if (checkResult instanceof Error) throw checkResult;
      return checkResult;
    }
    if (command === "install_update" || command === "restart_for_update") {
      calls.push(command);
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

describe("Updates settings section", () => {
  it("shows the installed version and that no check has run yet", async () => {
    await render({ ...upToDate, lastCheckedAt: null, lastCheck: null });
    expect(text()).toContain("0.1.0");
    expect(text()).toContain("Not checked yet");
  });

  it("says the install is up to date and when it last checked", async () => {
    await render(upToDate);
    expect(text()).toContain("Up to date");
    expect(text()).toContain(when(1_700_000_000));
  });

  it("asks to move Oxide to Applications, still names the new version and offers no install", async () => {
    await render({ ...behind, installLocation: "moveToApplications" });
    expect(text()).toContain("Move Oxide to your Applications folder");
    expect(text()).toContain("0.2.0");
    expect(named("Install update")).toBeUndefined();
    expect(named("Check for updates")).toBeDefined();
  });

  it("checks now and shows the new version it finds", async () => {
    checkResult = behind;
    await render(upToDate);
    await act(async () => named("Check for updates")!.click());
    expect(calls).toEqual(["check_for_updates"]);
    expect(text()).toContain("0.2.0");
    expect(text()).toContain("Release notes");
  });

  it("shows a check in progress and does not offer a second one", async () => {
    await render({ ...upToDate, checking: true });
    expect(text()).toContain("Checking");
    expect(named("Check for updates")?.disabled ?? named("Checking…")?.disabled).toBe(true);
  });

  it("reports a failed check with its time, and keeps the last known update", async () => {
    await render({ ...behind, lastCheck: { at: 1_700_000_500, succeeded: false } });
    expect(text()).toContain("Last check failed");
    expect(text()).toContain(when(1_700_000_500));
    expect(text()).toContain("0.2.0");
  });

  it("offers the install flow when a newer version exists and runs it", async () => {
    await render(behind);
    await act(async () => named("Install update")!.click());
    expect(calls).toEqual(["install_update"]);
  });

  it("shows download progress pushed by Core and blocks a check meanwhile", async () => {
    await render(behind);
    await act(async () => pushed!({ ...behind, operation: { kind: "downloading", downloaded: 50, total: 100 } }));
    expect(text()).toContain("Downloading… 50%");
    expect(named("Check for updates")?.disabled).toBe(true);
  });

  it("asks to restart once installed", async () => {
    await render({ ...behind, operation: { kind: "installed", staged: false } });
    await act(async () => named("Restart now")!.click());
    expect(calls).toEqual(["restart_for_update"]);
  });

  it("has no install button on a package-manager install", async () => {
    await render({ ...behind, channel: "apt" });
    expect(text()).toContain("0.2.0");
    expect(text()).toContain("sudo apt update && sudo apt upgrade");
    expect(named("Copy")).toBeDefined();
    expect(named("Install update")).toBeUndefined();
  });

  it("says a development build does not check", async () => {
    await render({ ...upToDate, channel: "development", lastCheck: null, lastCheckedAt: null });
    expect(text()).toContain("development build");
    expect(named("Check for updates")).toBeUndefined();
  });
});
