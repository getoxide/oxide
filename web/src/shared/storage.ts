// The only module that touches `localStorage`; ESLint bans the global everywhere else
// (web/eslint.config.js).
//
// What the webview remembers (layout, tabs, history, appearance) is a convenience, never the
// source of truth, so storage is best effort: it can be unavailable (private mode, quota), and
// what it holds can be stale or hand-edited. Every read here returns `null` when the value is
// missing, unreadable or not JSON, and every write is silent on failure. Callers validate the
// shape of what they read (it is `unknown`) and keep working from memory when a write is lost.
//
// Keys live in `storageKeys`, so a new persisted value is one line here and cannot collide
// with another by accident. Existing key strings are kept as they were.

export const storageKeys = {
  appearance: "oxide:appearance:v1",
  panelSize: (panel: string) => `oxide.layout.${panel}`,
  splitLayouts: "oxide:split-layouts:v1",
  codeTabs: (context: string) => `oxide:code-tabs:${context}`,
  terminalHistory: (context: string) => `oxide:terminal-history:${context}`,
  restoreSession: "oxide:restore-session:v1",
  session: "oxide:session:v1",
  terminalSession: (context: string) => `oxide:terminal-session:${context}`,
  languageDismissed: (language: string) => `oxide:language-dismissed:${language}`,
} as const;

/** The stored string, or `null` when absent or storage is unavailable. */
export function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value`; a refusal (quota, private mode) is ignored. */
export function writeText(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Persistence is a convenience; the caller keeps its in-memory value. */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Nothing to forget when storage is unavailable. */
  }
}

/** Forgets every key that starts with `prefix`. */
export function removeKeysWithPrefix(prefix: string): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* Nothing to forget when storage is unavailable. */
  }
}

/** The stored JSON as `unknown` (validate it), or `null` when absent, unavailable or corrupt. */
export function readJson(key: string): unknown {
  const text = readText(key);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeText(key, JSON.stringify(value));
}

/** The same guarded access as a `Storage`-shaped object, for helpers that take one. */
export const guardedStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: readText,
  setItem: writeText,
  removeItem: removeKey,
};
