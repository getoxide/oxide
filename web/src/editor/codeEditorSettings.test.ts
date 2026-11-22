// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODE_EDITOR_SETTINGS_EVENT,
  DEFAULT_CODE_EDITOR_SETTINGS,
  getCodeEditorSettings,
  resetCodeEditorSettings,
  saveCodeEditorSettings,
  toMonacoEditorOptions,
  type CodeEditorSettings,
} from "./codeEditorSettings";
import { storageKeys } from "../shared/storage";

describe("codeEditorSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when storage is empty or contains corrupt JSON", () => {
    expect(getCodeEditorSettings()).toEqual(DEFAULT_CODE_EDITOR_SETTINGS);

    localStorage.setItem(storageKeys.codeEditor, "{not-valid-json");
    expect(getCodeEditorSettings()).toEqual(DEFAULT_CODE_EDITOR_SETTINGS);

    localStorage.setItem(storageKeys.codeEditor, JSON.stringify(["array-not-object"]));
    expect(getCodeEditorSettings()).toEqual(DEFAULT_CODE_EDITOR_SETTINGS);
  });

  it("falls back per-field to defaults when stored values are invalid", () => {
    localStorage.setItem(
      storageKeys.codeEditor,
      JSON.stringify({
        tabSize: 3,
        insertSpaces: "yes",
        wordWrap: "diagonal",
        lineNumbers: "roman",
        minimap: 1,
        stickyScroll: null,
        renderWhitespace: "spaces",
        bracketPairColorization: "true",
        fontLigatures: 0,
        autoIndent: "magic",
        formatOnPaste: "no",
        smoothScrolling: [],
        scrollBeyondLastLine: {},
        cursorStyle: "circle",
        cursorBlinking: "pulse",
        lineHeight: -5,
      }),
    );

    expect(getCodeEditorSettings()).toEqual(DEFAULT_CODE_EDITOR_SETTINGS);
  });

  it("persists valid settings, preserves partial valid fields, and broadcasts changes", () => {
    const listener = vi.fn();
    window.addEventListener(CODE_EDITOR_SETTINGS_EVENT, listener);

    const custom: CodeEditorSettings = {
      ...DEFAULT_CODE_EDITOR_SETTINGS,
      tabSize: 2,
      insertSpaces: false,
      wordWrap: "on",
      lineNumbers: "relative",
      minimap: true,
      stickyScroll: false,
      renderWhitespace: "all",
      bracketPairColorization: false,
      fontLigatures: true,
      autoIndent: "brackets",
      formatOnPaste: false,
      smoothScrolling: false,
      scrollBeyondLastLine: true,
      cursorStyle: "block",
      cursorBlinking: "phase",
      lineHeight: 1.6,
    };

    saveCodeEditorSettings(custom);
    expect(getCodeEditorSettings()).toEqual(custom);
    expect(listener).toHaveBeenCalledTimes(1);

    resetCodeEditorSettings();
    expect(getCodeEditorSettings()).toEqual(DEFAULT_CODE_EDITOR_SETTINGS);
    expect(listener).toHaveBeenCalledTimes(2);

    window.removeEventListener(CODE_EDITOR_SETTINGS_EVENT, listener);
  });

  it("maps settings to Monaco editor options", () => {
    const custom: CodeEditorSettings = {
      ...DEFAULT_CODE_EDITOR_SETTINGS,
      tabSize: 2,
      insertSpaces: false,
      wordWrap: "on",
      lineNumbers: "relative",
      minimap: true,
      stickyScroll: false,
      renderWhitespace: "trailing",
      bracketPairColorization: false,
      fontLigatures: true,
      autoIndent: "keep",
      formatOnPaste: false,
      smoothScrolling: true,
      scrollBeyondLastLine: true,
      cursorStyle: "underline",
      cursorBlinking: "smooth",
      lineHeight: 1.5,
    };

    expect(toMonacoEditorOptions(custom, false)).toEqual({
      tabSize: 2,
      insertSpaces: false,
      wordWrap: "on",
      lineNumbers: "relative",
      minimap: { enabled: true },
      stickyScroll: { enabled: false },
      renderWhitespace: "trailing",
      bracketPairColorization: { enabled: false },
      fontLigatures: true,
      autoIndent: "keep",
      formatOnPaste: false,
      smoothScrolling: true,
      scrollBeyondLastLine: true,
      cursorStyle: "underline",
      cursorBlinking: "smooth",
      lineHeight: 1.5,
    });

    expect(toMonacoEditorOptions(custom, true).smoothScrolling).toBe(false);
  });

  it("defaults smoothScrolling to false when prefers-reduced-motion: reduce matches", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      vi.resetModules();
      const fresh = await import("./codeEditorSettings");
      expect(fresh.DEFAULT_CODE_EDITOR_SETTINGS.smoothScrolling).toBe(false);
      expect(fresh.getCodeEditorSettings().smoothScrolling).toBe(false);
    } finally {
      window.matchMedia = originalMatchMedia;
      vi.resetModules();
    }
  });
});
