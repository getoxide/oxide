
/** Remove Windows extended-length syntax for presentation and shell prompts. */
export function readablePath(path: string): string {
  const slash = String.fromCharCode(92);
  const prefix = slash + slash + "?" + slash;
  if (path.startsWith(prefix + "UNC" + slash)) return slash + slash + path.slice(8);
  if (path.startsWith(prefix) && /^[A-Za-z]:/.test(path.slice(4))) return path.slice(4);
  return path;
}

/** The home directory shortened to `~`. */
export const displayPath = (path: string) => readablePath(path).replace(/^\/(Users|home)\/[^/]+/, "~");

/** Cuts a long path in the middle so the start and, above all, the folder name survive. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor((max - 1) / 3);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
