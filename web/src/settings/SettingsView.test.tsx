// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SettingsView } from "./SettingsView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let developerToolsCalls = 0;
let savedTerminalSettings = { shell: "default", loadUserConfig: true };
let setTerminalSettingsCalls: { shell: string; loadUserConfig: boolean }[] = [];
let rejectNextTerminalSave: string | null = null;

beforeEach(() => {
  localStorage.clear();
  developerToolsCalls = 0;
  savedTerminalSettings = { shell: "default", loadUserConfig: true };
  setTerminalSettingsCalls = [];
  rejectNextTerminalSave = null;
  mockIPC((cmd, args) => {
    if (cmd === "developer_tools") {
      developerToolsCalls += 1;
      return [
        { id: "git", name: "Git", installed: true, canInstall: false, path: "/usr/bin/git", documentation: "https://git-scm.com" },
        { id: "gh", name: "GitHub CLI", installed: true, canInstall: false, path: "/usr/bin/gh", documentation: "https://cli.github.com" },
      ];
    }
    if (cmd === "available_shells") {
      return [
        { kind: "default", label: "System default", isDefault: true },
        { kind: "zsh", label: "Zsh", isDefault: false },
        { kind: "bash", label: "Bash", isDefault: false },
      ];
    }
    if (cmd === "terminal_settings") {
      return savedTerminalSettings;
    }
    if (cmd === "set_terminal_settings") {
      const next = (args as { settings: { shell: string; loadUserConfig: boolean } }).settings;
      setTerminalSettingsCalls.push(next);
      if (rejectNextTerminalSave) {
        const msg = rejectNextTerminalSave;
        rejectNextTerminalSave = null;
        return Promise.reject(new Error(msg));
      }
      savedTerminalSettings = next;
      return savedTerminalSettings;
    }
    return null;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  clearMocks();
});

async function renderSettings(onClose = vi.fn()) {
  await act(async () => {
    root.render(<SettingsView onClose={onClose} />);
  });
  return { onClose };
}

function tabs() {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]'));
}

function panels() {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
}

it("renders a section navigation menu with Appearance, Terminal, Session, and GitHub, showing Appearance by default", async () => {
  await renderSettings();

  const nav = host.querySelector('[role="tablist"]');
  expect(nav).not.toBeNull();
  expect(nav?.getAttribute("aria-orientation")).toBe("vertical");

  const navTabs = tabs();
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Terminal", "Session", "GitHub"]);
  expect(navTabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
  expect(navTabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);

  const sectionPanels = panels();
  expect(sectionPanels).toHaveLength(4);
  expect(sectionPanels.map((panel) => panel.hidden)).toEqual([false, true, true, true]);
  expect(sectionPanels[0].getAttribute("aria-labelledby")).toBe(navTabs[0].id);
  expect(navTabs[0].getAttribute("aria-controls")).toBe(sectionPanels[0].id);
  expect(developerToolsCalls).toBe(1);
});

it("switches visible section content on click while preserving live state across sections", async () => {
  await renderSettings();
  const [appearanceTab, , sessionTab, githubTab] = tabs();
  const [appearancePanel, , sessionPanel, githubPanel] = panels();

  const uiSizeSelect = appearancePanel.querySelector<HTMLSelectElement>('select[aria-label="Interface size"]')!;
  await act(async () => {
    uiSizeSelect.value = "16";
    uiSizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await act(async () => {
    sessionTab.click();
  });
  expect(sessionTab.getAttribute("aria-selected")).toBe("true");
  expect(appearanceTab.getAttribute("aria-selected")).toBe("false");
  expect(appearancePanel.hidden).toBe(true);
  expect(sessionPanel.hidden).toBe(false);
  expect(githubPanel.hidden).toBe(true);

  const restoreToggle = sessionPanel.querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(restoreToggle.checked).toBe(true);
  await act(async () => {
    restoreToggle.click();
  });
  expect(restoreToggle.checked).toBe(false);

  await act(async () => {
    githubTab.click();
  });
  expect(githubTab.getAttribute("aria-selected")).toBe("true");
  expect(githubPanel.hidden).toBe(false);
  expect(sessionPanel.hidden).toBe(true);
  expect(githubPanel.textContent).toContain("Set up GitHub");

  await act(async () => {
    appearanceTab.click();
  });
  expect(appearancePanel.hidden).toBe(false);
  expect(appearancePanel.querySelector<HTMLSelectElement>('select[aria-label="Interface size"]')?.value).toBe("16");

  await act(async () => {
    sessionTab.click();
  });
  expect(sessionPanel.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
  expect(developerToolsCalls).toBe(1);
});

it("supports keyboard navigation across section tabs with wrapping and Home/End", async () => {
  await renderSettings();
  const [appearanceTab, terminalTab, sessionTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(terminalTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(terminalTab);

  await act(async () => {
    terminalTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(sessionTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(sessionTab);

  await act(async () => {
    sessionTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(githubTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(githubTab);

  await act(async () => {
    githubTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(appearanceTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(appearanceTab);

  await act(async () => {
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  });
  expect(githubTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(githubTab);

  await act(async () => {
    githubTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  });
  expect(appearanceTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(appearanceTab);

  await act(async () => {
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
  expect(githubTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(githubTab);

  await act(async () => {
    githubTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  });
  expect(sessionTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(sessionTab);
});

it("calls onClose when the close button is clicked", async () => {
  const { onClose } = await renderSettings();
  const closeButton = host.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')!;
  await act(async () => {
    closeButton.click();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("loads and persists Terminal shell and user-config settings via IPC", async () => {
  await renderSettings();
  const [, terminalTab] = tabs();
  const [, terminalPanel] = panels();

  await act(async () => {
    terminalTab.click();
  });
  expect(terminalPanel.hidden).toBe(false);

  const shellSelect = terminalPanel.querySelector<HTMLSelectElement>('select[aria-label="Shell"]')!;
  const configToggle = terminalPanel.querySelector<HTMLInputElement>('input[aria-label="Load user configuration"]')!;
  expect(Array.from(shellSelect.options).map((o) => o.value)).toEqual(["default", "zsh", "bash"]);
  expect(shellSelect.value).toBe("default");
  expect(configToggle.checked).toBe(true);

  await act(async () => {
    shellSelect.value = "bash";
    shellSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(setTerminalSettingsCalls).toEqual([{ shell: "bash", loadUserConfig: true }]);
  expect(shellSelect.value).toBe("bash");

  await act(async () => {
    configToggle.click();
  });
  expect(setTerminalSettingsCalls).toEqual([
    { shell: "bash", loadUserConfig: true },
    { shell: "bash", loadUserConfig: false },
  ]);
  expect(configToggle.checked).toBe(false);

  rejectNextTerminalSave = "Shell is not supported on this OS.";
  await act(async () => {
    configToggle.click();
  });
  expect(terminalPanel.querySelector('[role="alert"]')?.textContent).toContain("Shell is not supported");
});
