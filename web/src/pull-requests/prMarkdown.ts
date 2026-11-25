/** A deliberately small Markdown reader for pull request descriptions and comments.
 *  It shows what matters (headings, lists, checkboxes, code, link text) and drops what is
 *  noise in a narrow panel: HTML comments, bot metadata, raw tags. Output is data, never HTML. */

import { relativeTime } from "../shared/relativeTime";

export type Inline =
  | { kind: "text" | "code" | "link" | "strong"; text: string }
  /** `@login`: `text` is what GitHub shows, `login` a valid GitHub login. */
  | { kind: "mention"; text: string; login: string }
  /** An image, from `![alt](url)` or an `<img>` tag. `url` is always `https`. */
  | { kind: "image"; alt: string; url: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; items: { checked: boolean | null; inline: Inline[] }[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const TAGS =
  "details|summary|p|blockquote|ul|ol|li|code|em|strong|b|i|a|img|div|span|h[1-6]|hr|table|tr|td|th|thead|tbody|sup|sub";

/** Remove every match until none is left: one pass can leave a new match behind (`<<b>b>` becomes `<b>`). */
function replaceUntilStable(src: string, pattern: RegExp, replacement: string): string {
  let out = src;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** `url` when it is a well-formed `https` URL, else null. */
function httpsUrl(url: string): string | null {
  if (/[\s\p{Cc}]/u.test(url)) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return decodeEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? "");
}

/** An `<img>` tag as Markdown image syntax, which `parseInline` reads; nothing when its source
 *  is not `https`. The alt text and URL are escaped so they cannot end the syntax early. */
function imageTagAsMarkdown(attrs: string): string {
  const url = httpsUrl(attribute(attrs, "src"));
  if (!url) return "";
  const alt = attribute(attrs, "alt").replace(/[[\]\n]/g, "");
  return `![${alt}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}

function clean(src: string): string {
  const text = src
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    // GitHub shows a time as "now" or "5m ago", not as the raw tag.
    .replace(/<relative-time[^>]*datetime="([^"]*)"[^>]*>[\s\S]*?<\/relative-time>/gi, (all, iso: string) => relativeTime(iso) || all)
    // A link reference definition (`[vc]: #...`) is invisible on GitHub: bots use it to hide metadata.
    .replace(/^ {0,3}\[[^\]\n]+\]:[ \t]+\S.*$/gm, "")
    // Dependabot's machine-readable trailer.
    .replace(/\n?---\nupdated-dependencies:[\s\S]*?(\n\.\.\.\n?|$)/, "\n")
    .replace(/<img\b([^>]*)>/gi, (_, attrs: string) => imageTagAsMarkdown(attrs))
    .replace(/<br\s*\/?>/gi, "\n");
  return replaceUntilStable(text, new RegExp(`</?(${TAGS})(\\s[^>]*)?/?>`, "gi"), "");
}

/** A GitHub login: letters, digits and single inner hyphens, at most 39 characters. The `@` must
 *  not follow a word character, a dot or another `@`, so `a@b.com` stays an email address. */
const MENTION = /(?<![\w.+\-@/`])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![\w-]|\.\w)/g;

/** Plain text with its `@mentions` read out. */
function textWithMentions(text: string, out: Inline[]) {
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "mention", text: m[0], login: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /`([^`]+)`|\*\*([^*]+)\*\*|\[!\[([^\]\n]*)\]\(([^)\s]*)[^)]*\)\]\([^)]*\)|!\[([^\]\n]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) textWithMentions(text.slice(last, m.index), out);
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", text: m[2] });
    else if (m[3] !== undefined || m[5] !== undefined) {
      const url = httpsUrl(m[4] ?? m[6]);
      if (url) out.push({ kind: "image", alt: m[3] ?? m[5], url });
    } else if (m[7] !== undefined) out.push({ kind: "link", text: m[7].replace(/`/g, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) textWithMentions(text.slice(last), out);
  return out;
}

const COLUMNS = 36;

function textLines(parts: Inline[]): number {
  // An image is shown a few lines tall.
  const length = (p: Inline) => (p.kind === "image" ? 4 * COLUMNS : p.text.length);
  return Math.max(1, Math.ceil(parts.reduce((n, p) => n + length(p), 0) / COLUMNS));
}

function cost(block: Block): number {
  switch (block.kind) {
    case "heading":
      return 1;
    case "paragraph":
      return textLines(block.inline);
    case "list":
      return block.items.reduce((n, item) => n + textLines(item.inline), 0);
    case "code":
      return block.text.split("\n").length;
    case "table":
      return 1 + block.rows.length;
    case "rule":
      return 0;
  }
}

/** The first `budget` visual lines of a document, cut between lines, never through one.
 *  A code block is the only thing cut inside, and keeps whole lines. */
export function limitBlocks(blocks: Block[], budget: number): { blocks: Block[]; truncated: boolean } {
  const out: Block[] = [];
  let left = budget;
  for (const block of blocks) {
    const c = cost(block);
    if (c <= left) {
      out.push(block);
      left -= c;
      continue;
    }
    if (block.kind === "code" && left >= 2) {
      out.push({ kind: "code", text: block.text.split("\n").slice(0, left).join("\n") });
    } else if (out.length === 0) out.push(block);
    // A heading with nothing under it reads as a mistake.
    while (out[out.length - 1]?.kind === "heading" || out[out.length - 1]?.kind === "rule") out.pop();
    return { blocks: out, truncated: true };
  }
  return { blocks, truncated: false };
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = clean(src).split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      flush();
      const header = tableCells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) {
        rows.push(tableCells(lines[i]).map(parseInline));
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) flush();
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
    } else if (item) {
      flush();
      const entry = { checked: item[1] === undefined ? null : item[1] !== " ", inline: parseInline(item[2]) };
      if (last?.kind === "list") last.items.push(entry);
      else blocks.push({ kind: "list", items: [entry] });
    } else if (/^\s+\S/.test(line) && last?.kind === "list" && !para.length) {
      // A wrapped list item: fold it into the previous entry.
      last.items[last.items.length - 1].inline.push(...parseInline(` ${line.trim()}`));
    } else para.push(line.replace(/^>\s?/, ""));
  }
  flush();
  return blocks;
}
