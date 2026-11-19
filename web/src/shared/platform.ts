/** The modifier shown in hints for form keys such as ⌘↵: ⌘ on macOS, Ctrl+ elsewhere. */
export const shortcutLabel =
  typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform) ? "⌘" : "Ctrl+";
