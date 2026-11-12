import { describe, expect, it } from "vitest";
import { numberHunk } from "./diffView";

describe("numberHunk", () => {
  it("numbers each side from the hunk header", () => {
    const lines = numberHunk({
      header: "@@ -10,3 +10,4 @@ fn main() {",
      lines: [
        { kind: "context", text: "a" },
        { kind: "removed", text: "b" },
        { kind: "added", text: "c" },
        { kind: "added", text: "d" },
        { kind: "context", text: "e" },
      ],
    });
    expect(lines.map((l) => [l.old, l.new])).toEqual([
      [10, 10],
      [11, null],
      [null, 11],
      [null, 12],
      [12, 13],
    ]);
  });

  it("leaves numbers out when the header can't be read", () => {
    const [line] = numberHunk({ header: "Binary", lines: [{ kind: "context", text: "x" }] });
    expect([line.old, line.new]).toEqual([null, null]);
  });
});
