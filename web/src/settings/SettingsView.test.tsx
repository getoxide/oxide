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

it("renders a section navigation menu with Appearance, Terminal, Code, Session, Shortcuts, and GitHub, showing Appearance by default", async () => {
  await renderSettings();

  const nav = host.querySelector('[role="tablist"]');
  expect(nav).not.toBeNull();
  expect(nav?.getAttribute("aria-orientation")).toBe("vertical");

  const navTabs = tabs();
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Themes", "Terminal", "Code", "Session", "Shortcuts", "GitHub"]);
  expect(navTabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false", "false", "false"]);
  expect(navTabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);

  const sectionPanels = panels();
  expect(sectionPanels).toHaveLength(7);
  expect(sectionPanels.map((panel) => panel.hidden)).toEqual([false, true, true, true, true, true, true]);
  expect(sectionPanels[0].getAttribute("aria-labelledby")).toBe(navTabs[0].id);
  expect(navTabs[0].getAttribute("aria-controls")).toBe(sectionPanels[0].id);
  expect(developerToolsCalls).toBe(1);
});

it("switches visible section content on click while preserving live state across sections", async () => {
  await renderSettings();
  const [appearanceTab, , , , sessionTab, , githubTab] = tabs();
  const [appearancePanel, , , codePanel, sessionPanel, , githubPanel] = panels();

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
  const [appearanceTab, themesTab, terminalTab, codeTab, sessionTab, shortcutsTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(themesTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(themesTab);

  await act(async () => {
    themesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(terminalTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(terminalTab);

  await act(async () => {
    terminalTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
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

it("manages disk-backed themes in Settings -> Themes: diagnostics, selection, folder open, reload, inline edit/save, and delete", async () => {
  const oceanJson = JSON.stringify({
    name: "Ocean",
    themes: [
      {
        name: "Ocean Dark",
        appearance: "dark",
        style: {
          background: "#0B192C",
          "sidebar.background": "#0E223D",
          "terminal.background": "#0B192C",
        },
      },
    ],
  }, null, 2);

  let diskThemes = [
    {
      id: "oxide-dark",
      name: "Oxide Dark",
      builtin: true,
      json: JSON.stringify({ name: "Oxide Dark", themes: [{ name: "Oxide Dark", appearance: "dark", style: { background: "#1C1C1E" } }] }),
      error: null,
    },
    {
      id: "ocean",
      name: "Ocean",
      builtin: false,
      json: oceanJson,
      error: null,
    },
    {
      id: "broken",
      name: "broken",
      builtin: false,
      json: null,
      error: "Invalid theme JSON: expected value at line 1",
    },
  ];
  let openFolderCalls = 0;
  let listCalls = 0;
  const savedPayloads: { id: string; json: string }[] = [];
  const deletedIds: string[] = [];

  mockIPC((cmd, args) => {
    if (cmd === "developer_tools") return [];
    if (cmd === "list_themes") {
      listCalls += 1;
      return diskThemes;
    }
    if (cmd === "open_themes_folder") {
      openFolderCalls += 1;
      return null;
    }
    if (cmd === "save_theme") {
      const payload = args as { id: string; json: string };
      savedPayloads.push(payload);
      const created = { id: payload.id, name: "Custom Studio", builtin: false, json: payload.json, error: null };
      diskThemes = [...diskThemes.filter((t) => t.id !== payload.id), created];
      return created;
    }
    if (cmd === "delete_theme") {
      const { id } = args as { id: string };
      deletedIds.push(id);
      diskThemes = diskThemes.filter((t) => t.id !== id);
      return null;
    }
    return null;
  });

  await renderSettings();
  const themesTab = tabs().find((tab) => tab.textContent?.trim() === "Themes")!;
  await act(async () => {
    themesTab.click();
  });

  const themesPanel = panels()[1];
  expect(themesPanel.hidden).toBe(false);
  expect(themesPanel.textContent).toContain("Ocean Dark");
  expect(themesPanel.textContent).toContain("broken");
  expect(themesPanel.textContent).toContain("Invalid theme JSON");

  const oceanChoice = themesPanel.querySelector<HTMLButtonElement>('button[role="radio"][data-theme-id="ocean"]')!;
  await act(async () => {
    oceanChoice.click();
  });
  expect(document.documentElement.style.getPropertyValue("--sidebar-background")).toBe("#0E223D");

  const openFolderBtn = Array.from(themesPanel.querySelectorAll("button")).find((b) => b.textContent?.includes("Open themes folder"))!;
  await act(async () => {
    openFolderBtn.click();
  });
  expect(openFolderCalls).toBe(1);

  const reloadBtn = Array.from(themesPanel.querySelectorAll("button")).find((b) => b.textContent?.includes("Reload from disk"))!;
  await act(async () => {
    reloadBtn.click();
  });
  expect(listCalls).toBeGreaterThanOrEqual(2);

  const newBtn = Array.from(themesPanel.querySelectorAll("button")).find((b) => b.textContent?.includes("New custom theme"))!;
  await act(async () => {
    newBtn.click();
  });

  const idInput = themesPanel.querySelector<HTMLInputElement>('input[aria-label="Theme file id"]')!;
  const jsonArea = themesPanel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Theme JSON"]')!;

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(jsonArea, "{broken");
    jsonArea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(themesPanel.querySelector('[role="alert"]')?.textContent).toBeTruthy();

  const validNewJson = JSON.stringify({
    name: "Custom Studio",
    themes: [{ name: "Custom Studio", appearance: "dark", style: { background: "#141820" } }],
  }, null, 2);
  await act(async () => {
    const idSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    idSetter.call(idInput, "custom-studio");
    idInput.dispatchEvent(new Event("input", { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(jsonArea, validNewJson);
    jsonArea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const saveBtn = Array.from(themesPanel.querySelectorAll("button")).find((b) => b.textContent?.includes("Save theme"))!;
  await act(async () => {
    saveBtn.click();
  });
  expect(savedPayloads).toEqual([{ id: "custom-studio", json: validNewJson }]);

  const deleteBtn = themesPanel.querySelector<HTMLButtonElement>('button[aria-label="Delete theme ocean"]')!;
  await act(async () => {
    deleteBtn.click();
  });
  expect(deletedIds).toEqual(["ocean"]);
});

it("renders grouped Code editor controls, persists changes, broadcasts updates, and restores defaults", async () => {
  const broadcastListener = vi.fn();
  window.addEventListener(CODE_EDITOR_SETTINGS_EVENT, broadcastListener);

  await renderSettings();
  const [, , , codeTab] = tabs();
  const [, , , codePanel] = panels();

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

it("loads and persists Terminal shell and user-config settings via IPC", async () => {
  await renderSettings();
  const [, , terminalTab] = tabs();
  const [, , terminalPanel] = panels();

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

it("supports searching, recording, clearing, conflict warnings, and resetting in Settings -> Shortcuts", async () => {
  await renderSettings();
  const [, , , , , shortcutsTab] = tabs();
  const [, , , , , shortcutsPanel] = panels();

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
