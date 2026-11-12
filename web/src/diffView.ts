import type { DiffHunk, DiffKind } from "./bindings";

export interface NumberedLine {
  kind: DiffKind;
  text: string;
  /** Line number on the old side; absent for added lines. */
  old: number | null;
  /** Line number on the new side; absent for removed lines. */
  new: number | null;
}

/** The hunk's lines with their old and new line numbers, counted from its `@@ -a,b +c,d @@` header. */
export function numberHunk(hunk: DiffHunk): NumberedLine[] {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
  let oldNo = match ? Number(match[1]) : null;
  let newNo = match ? Number(match[2]) : null;
  return hunk.lines.map((line) => {
    const numbered: NumberedLine = {
      kind: line.kind,
      text: line.text,
      old: line.kind === "added" ? null : oldNo,
      new: line.kind === "removed" ? null : newNo,
    };
    if (oldNo !== null && line.kind !== "added") oldNo += 1;
    if (newNo !== null && line.kind !== "removed") newNo += 1;
    return numbered;
  });
}
