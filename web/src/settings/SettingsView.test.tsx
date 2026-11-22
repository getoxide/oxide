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

it("renders a section navigation menu with Appearance, Session, and GitHub, showing Appearance by default", async () => {
  await renderSettings();

  const nav = host.querySelector('[role="tablist"]');
  expect(nav).not.toBeNull();
  expect(nav?.getAttribute("aria-orientation")).toBe("vertical");

  const navTabs = tabs();
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Session", "GitHub"]);
  expect(navTabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  expect(navTabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

  const sectionPanels = panels();
  expect(sectionPanels).toHaveLength(3);
  expect(sectionPanels.map((panel) => panel.hidden)).toEqual([false, true, true]);
  expect(sectionPanels[0].getAttribute("aria-labelledby")).toBe(navTabs[0].id);
  expect(navTabs[0].getAttribute("aria-controls")).toBe(sectionPanels[0].id);
  expect(developerToolsCalls).toBe(1);
});

it("switches visible section content on click while preserving live state across sections", async () => {
  await renderSettings();
  const [appearanceTab, sessionTab, githubTab] = tabs();
  const [appearancePanel, sessionPanel, githubPanel] = panels();

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
  const [appearanceTab, sessionTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
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

it("shows recommended fonts by default and reveals all system fonts when toggled across all four roles", async () => {
  let systemFontsCalls = 0;
  mockIPC((cmd) => {
    if (cmd === "developer_tools") {
      developerToolsCalls += 1;
      return [];
    }
    if (cmd === "system_fonts") {
      systemFontsCalls += 1;
      return ["Arial", "Fira Code", "Georgia"];
    }
    return null;
  });

  await renderSettings();

  // Four font roles including Issues & Pull requests Surfaces.
  const uiSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Interface font"]')!;
  const codeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Code editor font"]')!;
  const terminalSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Terminal font"]')!;
  const surfacesSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Issues & Pull requests font"]')!;
  expect(uiSelect).not.toBeNull();
  expect(codeSelect).not.toBeNull();
  expect(terminalSelect).not.toBeNull();
  expect(surfacesSelect).not.toBeNull();

  // Recommended-first: system fonts are hidden until toggled on.
  expect(systemFontsCalls).toBe(0);
  expect(Array.from(surfacesSelect.options).map((o) => o.text)).toEqual(["Inter", "System"]);

  const toggle = host.querySelector<HTMLInputElement>('input[aria-label="Show all system fonts"]')!;
  expect(toggle).not.toBeNull();
  expect(toggle.checked).toBe(false);

  await act(async () => {
    toggle.click();
  });

  expect(systemFontsCalls).toBe(1);
  expect(Array.from(surfacesSelect.options).map((o) => o.text)).toEqual([
    "Inter",
    "System",
    "Arial",
    "Fira Code",
    "Georgia",
  ]);

  // Select a system font, weight, and size for Issues & Pull requests and verify live application.
  await act(async () => {
    surfacesSelect.value = "Georgia";
    surfacesSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const surfacesWeight = host.querySelector<HTMLSelectElement>('select[aria-label="Issues & Pull requests weight"]')!;
  const surfacesSize = host.querySelector<HTMLSelectElement>('select[aria-label="Issues & Pull requests size"]')!;
  await act(async () => {
    surfacesWeight.value = "600";
    surfacesWeight.dispatchEvent(new Event("change", { bubbles: true }));
    surfacesSize.value = "16";
    surfacesSize.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(document.documentElement.style.getPropertyValue("--font-surfaces")).toBe("Georgia");
  expect(document.documentElement.style.getPropertyValue("--font-surfaces-weight")).toBe("600");
  expect(document.documentElement.style.getPropertyValue("--font-surfaces-size")).toBe("16px");
});

it("degrades gracefully to recommended fonts with a non-blocking retry option when system_fonts fails or returns empty", async () => {
  let attempt = 0;
  mockIPC((cmd) => {
    if (cmd === "developer_tools") return [];
    if (cmd === "system_fonts") {
      attempt += 1;
      if (attempt === 1) throw new Error("font enumeration failed");
      if (attempt === 2) return [];
      return ["Consolas", "Segoe UI"];
    }
    return null;
  });

  await renderSettings();
  const toggle = host.querySelector<HTMLInputElement>('input[aria-label="Show all system fonts"]')!;

  // First attempt: error -> recommended fonts remain usable, Retry button shown.
  await act(async () => {
    toggle.click();
  });
  const codeSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Code editor font"]')!;
  expect(Array.from(codeSelect.options).map((o) => o.text)).toEqual(["JetBrains Mono", "System monospace"]);
  const retry1 = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry");
  expect(retry1).toBeDefined();

  // Second attempt: empty -> still shows non-blocking Retry button.
  await act(async () => {
    retry1!.click();
  });
  const retry2 = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry");
  expect(retry2).toBeDefined();

  // Third attempt: succeeds -> system fonts appear and Retry disappears.
  await act(async () => {
    retry2!.click();
  });
  expect(Array.from(codeSelect.options).map((o) => o.text)).toEqual([
    "JetBrains Mono",
    "System monospace",
    "Consolas",
    "Segoe UI",
  ]);
  expect(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry")).toBeUndefined();
});
