// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SettingsView } from "./SettingsView";
import {
  CODE_EDITOR_SETTINGS_EVENT,
  DEFAULT_CODE_EDITOR_SETTINGS,
  getCodeEditorSettings,
} from "../editor/codeEditorSettings";

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

it("renders a section navigation menu with Appearance, Code, Session, and GitHub, showing Appearance by default", async () => {
  await renderSettings();

  const nav = host.querySelector('[role="tablist"]');
  expect(nav).not.toBeNull();
  expect(nav?.getAttribute("aria-orientation")).toBe("vertical");

  const navTabs = tabs();
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Code", "Session", "GitHub"]);
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
  const [appearancePanel, codePanel, sessionPanel, githubPanel] = panels();

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
  expect(codePanel.hidden).toBe(true);
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
  const [appearanceTab, codeTab, sessionTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(codeTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(codeTab);

  await act(async () => {
    codeTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
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

it("renders grouped Code editor controls, persists changes, broadcasts updates, and restores defaults", async () => {
  const broadcastListener = vi.fn();
  window.addEventListener(CODE_EDITOR_SETTINGS_EVENT, broadcastListener);

  await renderSettings();
  const [, codeTab] = tabs();
  const [, codePanel] = panels();

  await act(async () => {
    codeTab.click();
  });
  expect(codePanel.hidden).toBe(false);

  const text = codePanel.textContent ?? "";
  expect(text).toContain("Indentation");
  expect(text).toContain("Display");
  expect(text).toContain("Editing & scrolling");
  expect(text).toContain("Cursor");

  const restoreBtn = Array.from(codePanel.querySelectorAll<HTMLButtonElement>("button")).find(
    (btn) => btn.textContent?.trim() === "Restore defaults",
  )!;
  expect(restoreBtn).toBeDefined();
  expect(restoreBtn.disabled).toBe(true);

  const setSelect = async (label: string, value: string) => {
    const select = codePanel.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect(select).not.toBeNull();
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  const toggleSwitch = async (label: string) => {
    const toggle = codePanel.querySelector<HTMLInputElement>(`input[role="switch"][aria-label="${label}"]`)!;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle.click();
    });
  };

  await setSelect("Tab size", "2");
  await toggleSwitch("Insert spaces");
  await setSelect("Word wrap", "on");
  await setSelect("Line numbers", "relative");
  await toggleSwitch("Minimap");
  await toggleSwitch("Sticky scroll");
  await setSelect("Render whitespace", "all");
  await toggleSwitch("Bracket pair colorization");
  await toggleSwitch("Font ligatures");
  await setSelect("Line height", "1.6");
  await setSelect("Auto-indent", "brackets");
  await toggleSwitch("Format on paste");
  await toggleSwitch("Smooth scrolling");
  await toggleSwitch("Scroll beyond last line");
  await setSelect("Cursor style", "block");
  await setSelect("Cursor blinking", "phase");

  expect(getCodeEditorSettings()).toEqual({
    tabSize: 2,
    insertSpaces: false,
    wordWrap: "on",
    lineNumbers: "relative",
    minimap: true,
    stickyScroll: false,
    renderWhitespace: "all",
    bracketPairColorization: false,
    fontLigatures: true,
    lineHeight: 1.6,
    autoIndent: "brackets",
    formatOnPaste: false,
    smoothScrolling: false,
    scrollBeyondLastLine: true,
    cursorStyle: "block",
    cursorBlinking: "phase",
  });
  expect(broadcastListener).toHaveBeenCalledTimes(16);
  expect(restoreBtn.disabled).toBe(false);

  await act(async () => {
    restoreBtn.click();
  });
  expect(getCodeEditorSettings()).toEqual(DEFAULT_CODE_EDITOR_SETTINGS);
  expect(restoreBtn.disabled).toBe(true);
  expect(broadcastListener).toHaveBeenCalledTimes(17);

  window.removeEventListener(CODE_EDITOR_SETTINGS_EVENT, broadcastListener);
});
