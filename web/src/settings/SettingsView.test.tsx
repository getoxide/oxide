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

beforeEach(() => {
  localStorage.clear();
  developerToolsCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "developer_tools") {
      developerToolsCalls += 1;
      return [
        { id: "git", name: "Git", installed: true, canInstall: false, path: "/usr/bin/git", documentation: "https://git-scm.com" },
        { id: "gh", name: "GitHub CLI", installed: true, canInstall: false, path: "/usr/bin/gh", documentation: "https://cli.github.com" },
      ];
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

it("renders a section navigation menu with Appearance, Session, Shortcuts, and GitHub, showing Appearance by default", async () => {
  await renderSettings();

  const nav = host.querySelector('[role="tablist"]');
  expect(nav).not.toBeNull();
  expect(nav?.getAttribute("aria-orientation")).toBe("vertical");

  const navTabs = tabs();
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Session", "Shortcuts", "GitHub"]);
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
  const [appearanceTab, sessionTab, , githubTab] = tabs();
  const [appearancePanel, sessionPanel, , githubPanel] = panels();

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
  const [appearanceTab, sessionTab, shortcutsTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(sessionTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(sessionTab);

  await act(async () => {
    sessionTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(shortcutsTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(shortcutsTab);

  await act(async () => {
    shortcutsTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
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
  expect(shortcutsTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(shortcutsTab);
});

it("calls onClose when the close button is clicked", async () => {
  const { onClose } = await renderSettings();
  const closeButton = host.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')!;
  await act(async () => {
    closeButton.click();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("supports searching, recording, clearing, conflict warnings, and resetting in Settings -> Shortcuts", async () => {
  await renderSettings();
  const [, , shortcutsTab] = tabs();
  const [, , shortcutsPanel] = panels();

  await act(async () => {
    shortcutsTab.click();
  });
  expect(shortcutsPanel.hidden).toBe(false);
  expect(shortcutsPanel.textContent).toContain("Navigation");
  expect(shortcutsPanel.textContent).toContain("Projects & Terminals");
  expect(shortcutsPanel.textContent).toContain("Surfaces & Panels");
  expect(shortcutsPanel.textContent).toContain("Code");

  // Search filters actions
  const searchInput = shortcutsPanel.querySelector<HTMLInputElement>('input[aria-label="Search shortcuts"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(searchInput, "New terminal");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(shortcutsPanel.textContent).toContain("New terminal");
  expect(shortcutsPanel.textContent).not.toContain("Open Settings");

  // Clear search
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(searchInput, "");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const newTermBtn = shortcutsPanel.querySelector<HTMLButtonElement>('button[aria-label="Shortcut for New terminal"]')!;

  // Enter recording mode and cancel with Escape
  await act(async () => {
    newTermBtn.click();
  });
  expect(newTermBtn.textContent).toContain("Press keys");
  await act(async () => {
    newTermBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(newTermBtn.textContent).not.toContain("Press keys");

  // Enter recording mode and clear with Backspace
  await act(async () => {
    newTermBtn.click();
  });
  await act(async () => {
    newTermBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  });
  expect(newTermBtn.textContent).toContain("Unassigned");

  // Record a bare Ctrl+R binding -> triggers Terminal-conflict warning
  await act(async () => {
    newTermBtn.click();
  });
  await act(async () => {
    newTermBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true }));
  });
  expect(shortcutsPanel.textContent).toContain("Terminal");

  // Record a duplicate binding (same as Toggle sidebar: Mod+Shift+B) -> triggers duplicate warning
  await act(async () => {
    newTermBtn.click();
  });
  await act(async () => {
    newTermBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  expect(shortcutsPanel.textContent).toContain("Toggle sidebar");

  // Per-action Reset restores default
  const resetOne = shortcutsPanel.querySelector<HTMLButtonElement>('button[aria-label="Reset New terminal"]')!;
  await act(async () => {
    resetOne.click();
  });
  expect(shortcutsPanel.textContent).not.toContain("Unassigned");

  // Customize again and use Reset all shortcuts
  await act(async () => {
    newTermBtn.click();
  });
  await act(async () => {
    newTermBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  });
  const resetAll = shortcutsPanel.querySelector<HTMLButtonElement>('button[aria-label="Reset all shortcuts"]')!;
  await act(async () => {
    resetAll.click();
  });
  expect(newTermBtn.textContent).not.toContain("Unassigned");
});
