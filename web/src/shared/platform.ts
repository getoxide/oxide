export type DesktopPlatform = "macos" | "windows" | "linux";

/** Detects the current desktop platform from navigator. */
export function currentPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") return "linux";
  const agent = navigator.userAgent || navigator.platform;
  if (/Mac|iP(hone|od|ad)/i.test(agent)) return "macos";
  if (/Windows/i.test(agent)) return "windows";
  return "linux";
}

/** Returns the OS-conventional label for revealing a file or folder. */
export function revealInFileManagerLabel(platform: DesktopPlatform = currentPlatform()): string {
  if (platform === "macos") return "Reveal in Finder";
  if (platform === "windows") return "Reveal in File Explorer";
  return "Open in File Manager";
}

/** Joins a project root path and a relative file path using the root's separator. */
export function joinProjectPath(rootPath: string, relativePath: string): string {
  if (!rootPath) return relativePath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const trimmedRoot = rootPath.replace(/[\\/]+$/, "");
  const normalizedRelative = separator === "\\" ? relativePath.replace(/\//g, "\\") : relativePath;
  return `${trimmedRoot}${separator}${normalizedRelative}`;
}

/** Copies plain text to the system clipboard, ignoring permission/environment rejections. */
export function copyTextToClipboard(text: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(text).catch(() => {});
}

/** The modifier shown in hints for form keys such as ⌘↵: ⌘ on macOS, Ctrl+ elsewhere. */
export const shortcutLabel =
  currentPlatform() === "macos" ? "⌘" : "Ctrl+";
