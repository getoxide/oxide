import { useEffect, useState } from "react";
import { currentPlatform } from "./platform";
import { readJson, storageKeys, writeJson } from "./storage";

export const isMacPlatform = currentPlatform() === "macos";

export type ShortcutCategory = "Navigation" | "Projects & Terminals" | "Surfaces & Panels" | "Code";

export type ShortcutActionId =
  | "openSettings"
  | "openProjectPalette"
  | "toggleSidebar"
  | "toggleTools"
  | "newTerminal"
  | "closeTerminal"
  | "previousTerminal"
  | "nextTerminal"
  | "openFiles"
  | "openIssues"
  | "openPullRequests"
  | "toggleMaximizeHalf"
  | "saveFile"
  | "saveAllFiles";

export interface ShortcutAction {
  id: ShortcutActionId;
  category: ShortcutCategory;
  label: string;
  defaultShortcut: string;
  /** Actions scoped to Code only fire outside Terminal focus unless explicitly rebound. */
  scope?: "global" | "code";
}

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  "Navigation",
  "Projects & Terminals",
  "Surfaces & Panels",
  "Code",
];

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "openSettings", category: "Navigation", label: "Open Settings", defaultShortcut: "Mod+," },
  { id: "openProjectPalette", category: "Navigation", label: "Open Project palette", defaultShortcut: "Mod+Shift+O" },
  { id: "toggleSidebar", category: "Navigation", label: "Toggle sidebar", defaultShortcut: "Mod+Shift+B" },
  { id: "toggleTools", category: "Navigation", label: "Toggle right dock", defaultShortcut: "Mod+\\" },
  { id: "newTerminal", category: "Projects & Terminals", label: "New terminal", defaultShortcut: "Mod+Shift+T" },
  { id: "closeTerminal", category: "Projects & Terminals", label: "Close terminal", defaultShortcut: "Mod+Shift+W" },
  { id: "previousTerminal", category: "Projects & Terminals", label: "Previous terminal", defaultShortcut: "Mod+PageUp" },
  { id: "nextTerminal", category: "Projects & Terminals", label: "Next terminal", defaultShortcut: "Mod+PageDown" },
  { id: "openFiles", category: "Surfaces & Panels", label: "Open Files view", defaultShortcut: "Mod+Shift+E" },
  { id: "openIssues", category: "Surfaces & Panels", label: "Open Issues Surface", defaultShortcut: "Mod+Shift+I" },
  { id: "openPullRequests", category: "Surfaces & Panels", label: "Open Pull request Surface", defaultShortcut: "Mod+Shift+G" },
  { id: "toggleMaximizeHalf", category: "Surfaces & Panels", label: "Maximize / Restore active centre half", defaultShortcut: "Mod+Shift+Enter" },
  { id: "saveFile", category: "Code", label: "Save file", defaultShortcut: "Mod+S", scope: "code" },
  { id: "saveAllFiles", category: "Code", label: "Save all files", defaultShortcut: "Mod+Shift+S", scope: "code" },
];

export const DEFAULT_SHORTCUTS: Record<ShortcutActionId, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultShortcut]),
) as Record<ShortcutActionId, string>;

export type ShortcutOverrides = Partial<Record<ShortcutActionId, string>>;
export type ResolvedShortcuts = Record<ShortcutActionId, string>;

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const KNOWN_ACTION_IDS = new Set<string>(SHORTCUT_ACTIONS.map((action) => action.id));

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  space: " ",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

function normalizeKeyName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  if (trimmed.length === 1) return lower;
  return trimmed;
}

/** Parses a canonical shortcut string (e.g. `Mod+Shift+T`) into modifiers and normalized key. */
export function parseShortcut(binding: string): ParsedShortcut | null {
  const trimmed = binding.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
  // Handle trailing `+` key like `Mod++`
  if (trimmed.endsWith("+") && parts.length >= 1) parts.push("+");
  if (parts.length === 0) return null;

  let mod = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key: string | null = null;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const lower = part.toLowerCase();
    const isLast = index === parts.length - 1;
    if (!isLast && (lower === "mod" || lower === "cmdorctrl")) mod = true;
    else if (!isLast && (lower === "ctrl" || lower === "control")) ctrl = true;
    else if (!isLast && (lower === "alt" || lower === "option")) alt = true;
    else if (!isLast && lower === "shift") shift = true;
    else if (!isLast && (lower === "meta" || lower === "cmd" || lower === "super")) meta = true;
    else if (isLast) key = normalizeKeyName(part);
    else return null;
  }

  if (!key) return null;
  return { mod, ctrl, alt, shift, meta, key };
}

const CODE_TO_KEY: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
};

function keyFromCode(code: string): string | null {
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3).toLowerCase();
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  return CODE_TO_KEY[code] ?? null;
}

function eventKeyName(event: KeyboardEvent): string | null {
  if (event.key === " ") return " ";
  const isComposedAlt =
    event.key === "Dead" ||
    (event.altKey && event.key.length === 1 && !/^[\x20-\x7E]$/.test(event.key));
  if (isComposedAlt) {
    const fromCode = keyFromCode(event.code);
    if (fromCode) return fromCode;
  }
  const named = normalizeKeyName(event.key);
  if (named) return named;
  return keyFromCode(event.code);
}

/** Returns true when `event` matches the parsed shortcut `binding` for the active OS. */
export function matchesShortcut(event: KeyboardEvent, binding: string, mac = isMacPlatform): boolean {
  const parsed = parseShortcut(binding);
  if (!parsed) return false;

  const expectCtrl = parsed.ctrl || (!mac && parsed.mod);
  const expectMeta = parsed.meta || (mac && parsed.mod);

  if (event.ctrlKey !== expectCtrl) return false;
  if (event.metaKey !== expectMeta) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;

  const key = eventKeyName(event);
  return key !== null && key === parsed.key;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function formatCanonicalKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Converts a recorded `KeyboardEvent` into a canonical shortcut string, or `null` if incomplete/bare. */
export function eventToShortcut(event: KeyboardEvent, mac = isMacPlatform): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = eventKeyName(event);
  if (!key) return null;

  const hasFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (!hasModifier && !hasFunctionKey) return null;

  const parts: string[] = [];
  if (mac) {
    if (event.metaKey) parts.push("Mod");
    if (event.ctrlKey) parts.push("Ctrl");
  } else {
    if (event.ctrlKey) parts.push("Mod");
    if (event.metaKey) parts.push("Meta");
  }
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(formatCanonicalKey(key));
  return parts.join("+");
}

const DISPLAY_KEY_MAC: Record<string, string> = {
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

const DISPLAY_KEY_OTHER: Record<string, string> = {
  " ": "Space",
};

/** Returns individual keycap labels for a canonical shortcut string. */
export function formatShortcutParts(binding: string, mac = isMacPlatform): string[] {
  const parsed = parseShortcut(binding);
  if (!parsed) return [];

  const keyLabel = (mac ? DISPLAY_KEY_MAC[parsed.key] : DISPLAY_KEY_OTHER[parsed.key]) ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);

  const parts: string[] = [];
  if (mac) {
    if (parsed.ctrl) parts.push("⌃");
    if (parsed.alt) parts.push("⌥");
    if (parsed.shift) parts.push("⇧");
    if (parsed.mod || parsed.meta) parts.push("⌘");
  } else {
    if (parsed.mod || parsed.ctrl) parts.push("Ctrl");
    if (parsed.meta) parts.push("Meta");
    if (parsed.alt) parts.push("Alt");
    if (parsed.shift) parts.push("Shift");
  }
  parts.push(keyLabel);
  return parts;
}

/** Formats a canonical shortcut string for UI tooltips, menus, and Settings. */
export function formatShortcut(binding: string, mac = isMacPlatform): string {
  const parts = formatShortcutParts(binding, mac);
  if (parts.length === 0) return "";
  return mac ? parts.join("") : parts.join("+");
}

/** Appends a formatted shortcut hint to a tooltip/title when a binding is assigned. */
export function titleWithShortcut(title: string, binding: string, mac = isMacPlatform): string {
  const formatted = formatShortcut(binding, mac);
  return formatted ? `${title} (${formatted})` : title;
}

/** Returns true if `target` (or `document.activeElement`) is inside a Terminal workspace. */
export function isTerminalFocused(target: EventTarget | null): boolean {
  const element =
    target instanceof Element
      ? target
      : typeof document !== "undefined" && document.activeElement instanceof Element
        ? document.activeElement
        : null;
  return element?.closest(".terminal-workbench, .xterm, .terminal-command-block") !== null;
}

/** Returns true if `event` is a bare `Ctrl+<letter>` or `Escape` key used by shells and TUIs. */
export function isTerminalControlEvent(event: KeyboardEvent): boolean {
  if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return true;
  }
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    /^[a-z]$/i.test(event.key)
  );
}

/** Enforces Terminal priority: bare `Ctrl+<letter>` and `Escape` pass to the PTY unless explicitly rebound. */
export function shouldDispatchShortcut(
  event: KeyboardEvent,
  options: { isTerminal: boolean; isExplicitOverride: boolean },
): boolean {
  if (!options.isTerminal) return true;
  if (options.isExplicitOverride) return true;
  return !isTerminalControlEvent(event);
}

/** Returns true if `binding` collides with bare `Ctrl+<letter>` or `Escape` in a Terminal. */
export function isTerminalConflict(binding: string, mac = isMacPlatform): boolean {
  const parsed = parseShortcut(binding);
  if (!parsed) return false;
  if (parsed.key === "Escape" && !parsed.mod && !parsed.ctrl && !parsed.alt && !parsed.shift && !parsed.meta) {
    return true;
  }
  const hasCtrl = parsed.ctrl || (!mac && parsed.mod);
  const hasOther = parsed.alt || parsed.shift || parsed.meta || (mac && parsed.mod);
  return hasCtrl && !hasOther && /^[a-z]$/.test(parsed.key);
}

/** Loads persisted shortcut overrides, ignoring corrupt JSON or unknown/invalid entries. */
export function loadShortcutOverrides(): ShortcutOverrides {
  const raw = readJson(storageKeys.shortcuts);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!KNOWN_ACTION_IDS.has(id) || typeof value !== "string") continue;
    if (value === "" || parseShortcut(value) !== null) {
      overrides[id as ShortcutActionId] = value;
    }
  }
  return overrides;
}

export function saveShortcutOverrides(overrides: ShortcutOverrides): void {
  const clean: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(overrides)) {
    if (!KNOWN_ACTION_IDS.has(id) || typeof value !== "string") continue;
    if (value !== DEFAULT_SHORTCUTS[id as ShortcutActionId]) {
      clean[id as ShortcutActionId] = value;
    }
  }
  writeJson(storageKeys.shortcuts, clean);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("oxide-shortcuts-changed"));
  }
}

export function resolveShortcuts(overrides: ShortcutOverrides = loadShortcutOverrides()): ResolvedShortcuts {
  return { ...DEFAULT_SHORTCUTS, ...overrides };
}

/** Maps each action ID to any other action IDs sharing the exact same non-empty binding. */
export function findDuplicateShortcuts(
  shortcuts: ResolvedShortcuts,
  mac = isMacPlatform,
): Partial<Record<ShortcutActionId, ShortcutActionId[]>> {
  const bySignature = new Map<string, ShortcutActionId[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const binding = shortcuts[action.id];
    const parsed = parseShortcut(binding);
    if (!parsed) continue;
    const ctrl = parsed.ctrl || (!mac && parsed.mod);
    const meta = parsed.meta || (mac && parsed.mod);
    const signature = `${ctrl ? "C" : ""}${meta ? "M" : ""}${parsed.alt ? "A" : ""}${parsed.shift ? "S" : ""}:${parsed.key}`;
    const group = bySignature.get(signature) ?? [];
    group.push(action.id);
    bySignature.set(signature, group);
  }
  const duplicates: Partial<Record<ShortcutActionId, ShortcutActionId[]>> = {};
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    for (const id of group) {
      duplicates[id] = group.filter((other) => other !== id);
    }
  }
  return duplicates;
}

/** React hook returning the live resolved shortcuts and updating when overrides change. */
export function useShortcuts(): ResolvedShortcuts {
  const [shortcuts, setShortcuts] = useState<ResolvedShortcuts>(() => resolveShortcuts());
  useEffect(() => {
    const sync = () => setShortcuts(resolveShortcuts());
    window.addEventListener("oxide-shortcuts-changed", sync);
    return () => window.removeEventListener("oxide-shortcuts-changed", sync);
  }, []);
  return shortcuts;
}
