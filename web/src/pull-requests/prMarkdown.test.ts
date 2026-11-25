import { describe, expect, it } from "vitest";
import { limitBlocks, parseInline, parseMarkdown } from "./prMarkdown";

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
  it("does not let nested tags rebuild a tag after one pass", () => {
    const blocks = parseMarkdown("a <<b>b>x</b> b");
    expect(blocks).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "a x b" }] }]);
  });

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

describe("mentions", () => {
  it("reads @login as a mention", () => {
    expect(parseInline("Thanks @octo-cat, and @dependabot recreate.")).toEqual([
      { kind: "text", text: "Thanks " },
      { kind: "mention", text: "@octo-cat", login: "octo-cat" },
      { kind: "text", text: ", and " },
      { kind: "mention", text: "@dependabot", login: "dependabot" },
      { kind: "text", text: " recreate." },
    ]);
  });

  it("reads a mention at the start of a line and after punctuation", () => {
    expect(parseInline("@a\n(@b)")).toEqual([
      { kind: "mention", text: "@a", login: "a" },
      { kind: "text", text: "\n(" },
      { kind: "mention", text: "@b", login: "b" },
      { kind: "text", text: ")" },
    ]);
  });

  it("leaves @ inside inline code as code", () => {
    expect(parseInline("run `@foo` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "@foo" },
      { kind: "text", text: " now" },
    ]);
  });

  it("leaves email addresses as plain text", () => {
    expect(parseInline("write to a@b.com or user.name@example.org")).toEqual([
      { kind: "text", text: "write to a@b.com or user.name@example.org" },
    ]);
  });

  it("leaves a team mention as text rather than a chip for its organisation", () => {
    expect(parseInline("ping @getoxide/core and @bob")).toEqual([
      { kind: "text", text: "ping @getoxide/core and " },
      { kind: "mention", text: "@bob", login: "bob" },
    ]);
  });

  it("does not read a bare @ or an invalid login as a mention", () => {
    expect(parseInline("@ alone, @-x and @a--b")).toEqual([{ kind: "text", text: "@ alone, @-x and @a--b" }]);
  });
});

describe("images", () => {
  const asset = "https://github.com/user-attachments/assets/84ccda0a-5c4a-4fe4-b897-ed3f90e852b2";

  it("reads a Markdown image into an image node", () => {
    expect(parseInline(`Before ![The panel](${asset}) after`)).toEqual([
      { kind: "text", text: "Before " },
      { kind: "image", alt: "The panel", url: asset },
      { kind: "text", text: " after" },
    ]);
  });

  it("reads GitHub's drag-and-drop <img> tag into an image node", () => {
    const blocks = parseMarkdown(`<img width="1024" alt="Screenshot 2026" src="${asset}" />`);
    expect(blocks).toEqual([{ kind: "paragraph", inline: [{ kind: "image", alt: "Screenshot 2026", url: asset }] }]);
  });

  it("reads an image inside a link as the image", () => {
    expect(parseInline("[![CI](https://img.shields.io/badge/ci-green.png)](https://example.com/ci)")).toEqual([
      { kind: "image", alt: "CI", url: "https://img.shields.io/badge/ci-green.png" },
    ]);
  });

  it("drops images that are not https, and still strips the other tags", () => {
    const blocks = parseMarkdown(
      '![a](http://example.com/a.png) <img src="javascript:alert(1)" alt="b"> <img src=\'data:image/png;base64,AAAA\'> <div>c</div>',
    );
    expect(blocks).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "   c" }] }]);
  });

  it("keeps an attribute from closing the image early", () => {
    const blocks = parseMarkdown(`<img alt="a](x) b" src="${asset}?a=1&amp;b=2">`);
    expect(blocks).toEqual([{ kind: "paragraph", inline: [{ kind: "image", alt: "a(x) b", url: `${asset}?a=1&b=2` }] }]);
  });
});
