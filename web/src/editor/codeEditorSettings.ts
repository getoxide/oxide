import type { editor } from "monaco-editor";
import { readJson, storageKeys, writeJson } from "../shared/storage";

export const CODE_EDITOR_SETTINGS_EVENT = "oxide-code-editor-settings-changed";

export const TAB_SIZE_OPTIONS = [2, 4, 8] as const;
export const WORD_WRAP_OPTIONS = ["off", "on", "wordWrapColumn", "bounded"] as const;
export const LINE_NUMBERS_OPTIONS = ["on", "off", "relative"] as const;
export const RENDER_WHITESPACE_OPTIONS = ["none", "boundary", "selection", "trailing", "all"] as const;
export const AUTO_INDENT_OPTIONS = ["none", "keep", "brackets", "advanced", "full"] as const;
export const CURSOR_STYLE_OPTIONS = [
  "line",
  "block",
  "underline",
  "line-thin",
  "block-outline",
  "underline-thin",
] as const;
export const CURSOR_BLINKING_OPTIONS = ["blink", "smooth", "phase", "expand", "solid"] as const;
export const LINE_HEIGHT_OPTIONS = [0, 1.2, 1.4, 1.5, 1.6, 1.8, 2] as const;

export type TabSizeOption = (typeof TAB_SIZE_OPTIONS)[number];
export type WordWrapOption = (typeof WORD_WRAP_OPTIONS)[number];
export type LineNumbersOption = (typeof LINE_NUMBERS_OPTIONS)[number];
export type RenderWhitespaceOption = (typeof RENDER_WHITESPACE_OPTIONS)[number];
export type AutoIndentOption = (typeof AUTO_INDENT_OPTIONS)[number];
export type CursorStyleOption = (typeof CURSOR_STYLE_OPTIONS)[number];
export type CursorBlinkingOption = (typeof CURSOR_BLINKING_OPTIONS)[number];

export interface CodeEditorSettings {
  tabSize: TabSizeOption;
  insertSpaces: boolean;
  wordWrap: WordWrapOption;
  lineNumbers: LineNumbersOption;
  minimap: boolean;
  stickyScroll: boolean;
  renderWhitespace: RenderWhitespaceOption;
  bracketPairColorization: boolean;
  fontLigatures: boolean;
  autoIndent: AutoIndentOption;
  formatOnPaste: boolean;
  smoothScrolling: boolean;
  scrollBeyondLastLine: boolean;
  cursorStyle: CursorStyleOption;
  cursorBlinking: CursorBlinkingOption;
  lineHeight: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettings = {
  tabSize: 4,
  insertSpaces: true,
  wordWrap: "off",
  lineNumbers: "on",
  minimap: false,
  stickyScroll: true,
  renderWhitespace: "selection",
  bracketPairColorization: true,
  fontLigatures: false,
  autoIndent: "full",
  formatOnPaste: true,
  smoothScrolling: !prefersReducedMotion(),
  scrollBeyondLastLine: false,
  cursorStyle: "line",
  cursorBlinking: "blink",
  lineHeight: 0,
};

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function validLineHeight(value: unknown, fallback: number): number {
  if (value === 0) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 4) return value;
  return fallback;
}

/** Validates and normalizes an untrusted JSON value into `CodeEditorSettings`, falling back per-field. */
export function normalizeCodeEditorSettings(raw: unknown): CodeEditorSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CODE_EDITOR_SETTINGS };
  }
  const input = raw as Record<string, unknown>;
  return {
    tabSize: oneOf(input.tabSize, TAB_SIZE_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.tabSize),
    insertSpaces: bool(input.insertSpaces, DEFAULT_CODE_EDITOR_SETTINGS.insertSpaces),
    wordWrap: oneOf(input.wordWrap, WORD_WRAP_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.wordWrap),
    lineNumbers: oneOf(input.lineNumbers, LINE_NUMBERS_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.lineNumbers),
    minimap: bool(input.minimap, DEFAULT_CODE_EDITOR_SETTINGS.minimap),
    stickyScroll: bool(input.stickyScroll, DEFAULT_CODE_EDITOR_SETTINGS.stickyScroll),
    renderWhitespace: oneOf(input.renderWhitespace, RENDER_WHITESPACE_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.renderWhitespace),
    bracketPairColorization: bool(input.bracketPairColorization, DEFAULT_CODE_EDITOR_SETTINGS.bracketPairColorization),
    fontLigatures: bool(input.fontLigatures, DEFAULT_CODE_EDITOR_SETTINGS.fontLigatures),
    autoIndent: oneOf(input.autoIndent, AUTO_INDENT_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.autoIndent),
    formatOnPaste: bool(input.formatOnPaste, DEFAULT_CODE_EDITOR_SETTINGS.formatOnPaste),
    smoothScrolling: bool(input.smoothScrolling, DEFAULT_CODE_EDITOR_SETTINGS.smoothScrolling),
    scrollBeyondLastLine: bool(input.scrollBeyondLastLine, DEFAULT_CODE_EDITOR_SETTINGS.scrollBeyondLastLine),
    cursorStyle: oneOf(input.cursorStyle, CURSOR_STYLE_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.cursorStyle),
    cursorBlinking: oneOf(input.cursorBlinking, CURSOR_BLINKING_OPTIONS, DEFAULT_CODE_EDITOR_SETTINGS.cursorBlinking),
    lineHeight: validLineHeight(input.lineHeight, DEFAULT_CODE_EDITOR_SETTINGS.lineHeight),
  };
}

/** Reads the persisted Code editor settings, falling back to defaults when missing or corrupt. */
export function getCodeEditorSettings(): CodeEditorSettings {
  return normalizeCodeEditorSettings(readJson(storageKeys.codeEditor));
}

/** Persists `next` (after normalizing) and broadcasts the change to all mounted Code workspaces. */
export function saveCodeEditorSettings(next: CodeEditorSettings): CodeEditorSettings {
  const normalized = normalizeCodeEditorSettings(next);
  writeJson(storageKeys.codeEditor, normalized);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CODE_EDITOR_SETTINGS_EVENT));
  }
  return normalized;
}

/** Resets Code editor settings to defaults, persists them, and broadcasts the change. */
export function resetCodeEditorSettings(): CodeEditorSettings {
  return saveCodeEditorSettings(DEFAULT_CODE_EDITOR_SETTINGS);
}

/** Maps `CodeEditorSettings` to Monaco editor options, respecting `prefers-reduced-motion`. */
export function toMonacoEditorOptions(
  settings: CodeEditorSettings,
  reducedMotion = prefersReducedMotion(),
): editor.IStandaloneEditorConstructionOptions & editor.IEditorOptions {
  return {
    tabSize: settings.tabSize,
    insertSpaces: settings.insertSpaces,
    wordWrap: settings.wordWrap,
    lineNumbers: settings.lineNumbers,
    minimap: { enabled: settings.minimap },
    stickyScroll: { enabled: settings.stickyScroll },
    renderWhitespace: settings.renderWhitespace,
    bracketPairColorization: { enabled: settings.bracketPairColorization },
    fontLigatures: settings.fontLigatures,
    autoIndent: settings.autoIndent,
    formatOnPaste: settings.formatOnPaste,
    smoothScrolling: settings.smoothScrolling && !reducedMotion,
    scrollBeyondLastLine: settings.scrollBeyondLastLine,
    cursorStyle: settings.cursorStyle,
    cursorBlinking: settings.cursorBlinking,
    lineHeight: settings.lineHeight,
  };
}
