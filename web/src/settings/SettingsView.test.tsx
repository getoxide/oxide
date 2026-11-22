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
  expect(navTabs.map((tab) => tab.textContent?.trim())).toEqual(["Appearance", "Themes", "Session", "GitHub"]);
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
  const [appearanceTab, themesTab, sessionTab, githubTab] = tabs();

  await act(async () => {
    appearanceTab.focus();
    appearanceTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(themesTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(themesTab);

  await act(async () => {
    themesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
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
