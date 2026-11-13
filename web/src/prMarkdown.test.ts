import { describe, expect, it } from "vitest";
import { limitBlocks, parseMarkdown } from "./prMarkdown";

describe("limitBlocks", () => {
  it("keeps short documents whole", () => {
    const blocks = parseMarkdown("Hello\n\n- a\n- b");
    expect(limitBlocks(blocks, 8)).toEqual({ blocks, truncated: false });
  });

  it("cuts a long code block between lines", () => {
    const code = ["```", "1", "2", "3", "4", "5", "```"].join("\n");
    const out = limitBlocks(parseMarkdown(`## Summary\n\n${code}`), 4);
    expect(out.truncated).toBe(true);
    expect(out.blocks).toEqual([
      { kind: "heading", level: 2, inline: [{ kind: "text", text: "Summary" }] },
      { kind: "code", text: "1\n2\n3" },
    ]);
  });

  it("does not leave a heading dangling at the end", () => {
    const out = limitBlocks(parseMarkdown("one\n\n## Next\n\nlong ".concat("x".repeat(200))), 2);
    expect(out.blocks.at(-1)?.kind).not.toBe("heading");
  });
});

describe("parseMarkdown", () => {
  it("drops HTML comments and bot metadata", () => {
    const blocks = parseMarkdown(
      "<!-- What changes and why. -->\nBumps `a` from 1 to 2.\n\n---\nupdated-dependencies:\n- dependency-name: a\n...\n",
    );
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        inline: [
          { kind: "text", text: "Bumps " },
          { kind: "code", text: "a" },
          { kind: "text", text: " from 1 to 2." },
        ],
      },
    ]);
  });

  it("renders a bot comment like GitHub: no hidden reference, a table, a relative time", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const blocks = parseMarkdown(
      `[vc]: #abc123==:eyJ0\nThe latest updates on your projects.\n\n| Project | Deployment | Updated |\n| :--- | :----- | :------ |\n| [site](https://x.y) | [Ready](https://x.y/z) | <relative-time datetime="${iso}">Nov 13, 2026</relative-time> |`,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", inline: [{ text: "The latest updates on your projects." }] });
    expect(blocks[1]).toMatchObject({
      kind: "table",
      header: [[{ text: "Project" }], [{ text: "Deployment" }], [{ text: "Updated" }]],
      rows: [[[{ kind: "link", text: "site" }], [{ kind: "link", text: "Ready" }], [{ kind: "text", text: "5m" }]]],
    });
  });

  it("reads checklists with their state", () => {
    const [list] = parseMarkdown("- [ ] Tests added\n- [x] Docs");
    expect(list).toMatchObject({ kind: "list", items: [{ checked: false }, { checked: true }] });
  });

  it("keeps only link text and strips raw tags", () => {
    const [p] = parseMarkdown("<details><summary>Notes</summary>See [the docs](https://x.y/z)</details>");
    expect(p).toEqual({
      kind: "paragraph",
      inline: [
        { kind: "text", text: "NotesSee " },
        { kind: "link", text: "the docs" },
      ],
    });
  });

  it("keeps fenced code verbatim", () => {
    expect(parseMarkdown("```\n- not a list\n```")).toEqual([{ kind: "code", text: "- not a list" }]);
  });
});
