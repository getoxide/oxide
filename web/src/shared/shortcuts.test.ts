// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  eventToShortcut,
  findDuplicateShortcuts,
  formatShortcut,
  isTerminalConflict,
  isTerminalFocused,
  loadShortcutOverrides,
  matchesShortcut,
  parseShortcut,
  resolveShortcuts,
  saveShortcutOverrides,
  shouldDispatchShortcut,
} from "./shortcuts";
import { storageKeys } from "./storage";

describe("shortcuts engine", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("parses and formats Mod shortcuts for Windows/Linux and macOS", () => {
    expect(parseShortcut("Mod+Shift+T")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
      key: "t",
    });
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("   ")).toBeNull();

    expect(formatShortcut("Mod+Shift+T", false)).toBe("Ctrl+Shift+T");
    expect(formatShortcut("Mod+Shift+T", true)).toBe("⇧⌘T");
    expect(formatShortcut("Mod+,", false)).toBe("Ctrl+,");
    expect(formatShortcut("Mod+,", true)).toBe("⌘,");
    expect(formatShortcut("Mod+Shift+Enter", true)).toBe("⇧⌘↵");
  });

  it("matches KeyboardEvents against bindings on Windows/Linux and macOS", () => {
    const winEvent = new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true });
    expect(matchesShortcut(winEvent, "Mod+Shift+T", false)).toBe(true);
    expect(matchesShortcut(winEvent, "Mod+Shift+T", true)).toBe(false);

    const macEvent = new KeyboardEvent("keydown", { key: ",", metaKey: true });
    expect(matchesShortcut(macEvent, "Mod+,", true)).toBe(true);
    expect(matchesShortcut(macEvent, "Mod+,", false)).toBe(false);

    const bareCtrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    expect(matchesShortcut(bareCtrlC, "Ctrl+C", true)).toBe(true);
    expect(matchesShortcut(bareCtrlC, "Mod+C", false)).toBe(true);
    expect(matchesShortcut(bareCtrlC, "Mod+C", true)).toBe(false);
  });

  it("converts recorded KeyboardEvents to canonical shortcut strings", () => {
    expect(eventToShortcut(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }), false)).toBeNull();
    expect(eventToShortcut(new KeyboardEvent("keydown", { key: "a" }), false)).toBeNull();
    expect(eventToShortcut(new KeyboardEvent("keydown", { key: "K", ctrlKey: true, shiftKey: true }), false)).toBe("Mod+Shift+K");
    expect(eventToShortcut(new KeyboardEvent("keydown", { key: ",", metaKey: true }), true)).toBe("Mod+,");
    expect(eventToShortcut(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }), true)).toBe("Ctrl+C");
  });

  it("provides VS Code-inspired defaults for all required actions", () => {
    expect(DEFAULT_SHORTCUTS.openSettings).toBe("Mod+,");
    expect(DEFAULT_SHORTCUTS.openProjectPalette).toBe("Mod+Shift+O");
    expect(DEFAULT_SHORTCUTS.toggleSidebar).toBe("Mod+Shift+B");
    expect(DEFAULT_SHORTCUTS.toggleTools).toBe("Mod+\\");
    expect(DEFAULT_SHORTCUTS.newTerminal).toBe("Mod+Shift+T");
    expect(DEFAULT_SHORTCUTS.closeTerminal).toBe("Mod+Shift+W");
    expect(DEFAULT_SHORTCUTS.previousTerminal).toBe("Mod+PageUp");
    expect(DEFAULT_SHORTCUTS.nextTerminal).toBe("Mod+PageDown");
    expect(DEFAULT_SHORTCUTS.openFiles).toBe("Mod+Shift+E");
    expect(DEFAULT_SHORTCUTS.openIssues).toBe("Mod+Shift+I");
    expect(DEFAULT_SHORTCUTS.openPullRequests).toBe("Mod+Shift+G");
    expect(DEFAULT_SHORTCUTS.toggleMaximizeHalf).toBe("Mod+Shift+Enter");
    expect(DEFAULT_SHORTCUTS.saveFile).toBe("Mod+S");
    expect(DEFAULT_SHORTCUTS.saveAllFiles).toBe("Mod+Shift+S");
    expect(SHORTCUT_ACTIONS.length).toBeGreaterThanOrEqual(14);
  });

  it("detects terminal focus and gives Terminal priority for bare Ctrl+<letter> and Escape unless explicitly rebound", () => {
    const workbench = document.createElement("div");
    workbench.className = "terminal-workbench";
    const input = document.createElement("textarea");
    input.className = "xterm-helper-textarea";
    workbench.appendChild(input);
    document.body.appendChild(workbench);

    expect(isTerminalFocused(input)).toBe(true);
    expect(isTerminalFocused(document.body)).toBe(false);

    const ctrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    const ctrlR = new KeyboardEvent("keydown", { key: "r", ctrlKey: true });
    const ctrlW = new KeyboardEvent("keydown", { key: "w", ctrlKey: true });
    const esc = new KeyboardEvent("keydown", { key: "Escape" });

    // Even if an action were bound to Ctrl+C by default or Code-scoped Mod+S, Terminal focus protects bare Ctrl+<letter>.
    expect(shouldDispatchShortcut(ctrlC, { isTerminal: true, isExplicitOverride: false })).toBe(false);
    expect(shouldDispatchShortcut(ctrlR, { isTerminal: true, isExplicitOverride: false })).toBe(false);
    expect(shouldDispatchShortcut(ctrlW, { isTerminal: true, isExplicitOverride: false })).toBe(false);
    expect(shouldDispatchShortcut(esc, { isTerminal: true, isExplicitOverride: false })).toBe(false);

    // Explicit user rebind overrides Terminal priority.
    expect(shouldDispatchShortcut(ctrlR, { isTerminal: true, isExplicitOverride: true })).toBe(true);

    // Non-bare-Ctrl combos like Mod+Shift+T dispatch normally even when Terminal is focused.
    const modShiftT = new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true });
    expect(shouldDispatchShortcut(modShiftT, { isTerminal: true, isExplicitOverride: false })).toBe(true);

    workbench.remove();
  });

  it("detects bare Ctrl+<letter> terminal conflicts and duplicate bindings", () => {
    expect(isTerminalConflict("Ctrl+C", true)).toBe(true);
    expect(isTerminalConflict("Ctrl+R", false)).toBe(true);
    expect(isTerminalConflict("Mod+W", false)).toBe(true);
    expect(isTerminalConflict("Mod+W", true)).toBe(false);
    expect(isTerminalConflict("Mod+Shift+W", false)).toBe(false);
    expect(isTerminalConflict("Escape", false)).toBe(true);

    const resolved = resolveShortcuts({ newTerminal: "Mod+Shift+B" });
    const dupes = findDuplicateShortcuts(resolved);
    expect(dupes.newTerminal).toContain("toggleSidebar");
    expect(dupes.toggleSidebar).toContain("newTerminal");
  });

  it("persists overrides and falls back safely on corrupt storage", () => {
    localStorage.setItem(storageKeys.shortcuts, "{not valid json");
    expect(loadShortcutOverrides()).toEqual({});

    localStorage.setItem(storageKeys.shortcuts, JSON.stringify({ unknownAction: "Mod+K", newTerminal: 123, closeTerminal: "" }));
    expect(loadShortcutOverrides()).toEqual({ closeTerminal: "" });

    saveShortcutOverrides({ openSettings: "Mod+Shift+," });
    expect(loadShortcutOverrides()).toEqual({ openSettings: "Mod+Shift+," });
    expect(resolveShortcuts(loadShortcutOverrides()).openSettings).toBe("Mod+Shift+,");
  });
});
