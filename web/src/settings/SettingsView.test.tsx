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

it("renders a section navigation menu with Appearance, Terminal, Code, Session, and GitHub, showing Appearance by default", async () => {
  await renderSettings();

  const nav = host.querySelector('[role="tablist"]');
  expect(nav).not.toBeNull();
  expect(nav?.getAttribute("aria-orientation")).toBe("vertical");

  const navTabs = tabs();
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Terminal", "Code", "Session", "GitHub"]);
  expect(navTabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
  expect(navTabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);

  const sectionPanels = panels();
  expect(sectionPanels).toHaveLength(5);
  expect(sectionPanels.map((panel) => panel.hidden)).toEqual([false, true, true, true, true]);
  expect(sectionPanels[0].getAttribute("aria-labelledby")).toBe(navTabs[0].id);
  expect(navTabs[0].getAttribute("aria-controls")).toBe(sectionPanels[0].id);
  expect(developerToolsCalls).toBe(1);
});

it("switches visible section content on click while preserving live state across sections", async () => {
  await renderSettings();
  const [appearanceTab, , , sessionTab, githubTab] = tabs();
  const [appearancePanel, , codePanel, sessionPanel, githubPanel] = panels();

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
  const [appearanceTab, terminalTab, codeTab, sessionTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
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
  const [, , codeTab] = tabs();
  const [, , codePanel] = panels();

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
