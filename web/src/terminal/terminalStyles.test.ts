import { expect, it } from "vitest";
import workbenchCss from "../styles/workbench.css?raw";
import appearanceCss from "../styles/appearance.css?raw";

// jsdom does not lay out or cascade stylesheets, so these read the declarations every rule for a
// selector contributes across both stylesheets, in source order (the later one wins).
const sheets = [workbenchCss, appearanceCss].map((css) => css.replace(/\/\*[\s\S]*?\*\//g, ""));
function declarations(selector: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const css of sheets)
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
      if (!selectors.includes(selector)) continue;
      for (const line of match[2].split(";")) {
        const at = line.indexOf(":");
        if (at > 0) result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    }
  return result;
}
const paints = (value: string | undefined) =>
  value !== undefined && !/^(none|transparent|0)$/.test(value);

it("draws the command line flush with the Terminal: no card border, fill or focus halo", () => {
  expect(paints(declarations(".terminal-command-composer").background)).toBe(false);
  const entry = declarations(".terminal-command-entry");
  expect(paints(entry.background)).toBe(false);
  expect(paints(entry.border)).toBe(false);
  const focused = declarations(".terminal-command-composer:focus-within .terminal-command-entry");
  expect(paints(focused["box-shadow"])).toBe(false);
  expect(paints(focused.background)).toBe(false);
});

it("keeps the ghost suggestion on the same font, padding and line as the typed text", () => {
  const typed = declarations(".terminal-input-editor textarea");
  const ghost = declarations(".terminal-ghost");
  expect(ghost.font).toBe(typed.font);
  expect(ghost.padding).toBe(typed.padding);
  expect(ghost["white-space"]).toBe("pre");
});

const px = (value: string) => {
  expect(value, "a length in px").toMatch(/^-?[\d.]+px$/);
  return parseFloat(value);
};
const lastToken = (shorthand: string) => shorthand.split(" ").at(-1);

it("gives commands, their output and the command line one text edge at the gutter", () => {
  expect(lastToken(declarations(".terminal-command-block > header").padding)).toBe("var(--terminal-gutter)");
  expect(lastToken(declarations(".terminal-output-clip").margin)).toBe("var(--terminal-gutter)");
  expect(lastToken(declarations(".terminal-command-composer").padding)).toBe("var(--terminal-gutter)");
});

it.each([
  [".terminal-block-prompt", ".terminal-command-block > header"],
  [".terminal-prompt-symbol", ".terminal-command-entry"],
])("hangs the %s $ in the gutter, 12px clear of the 2px status rail, ending on the text edge", (prompt, row) => {
  const gutter = px(declarations(".terminal-workbench")["--terminal-gutter"]);
  const rail = px(declarations(".terminal-command-block::before").width);
  const symbol = declarations(prompt);
  const start = gutter + px(symbol["margin-left"]);
  expect(start - rail).toBeGreaterThanOrEqual(12);
  expect(start + px(symbol.width) + px(symbol["margin-right"]) + px(declarations(row).gap)).toBe(gutter);
});

it("keeps the command line of a block flush with the Terminal: no band behind it", () => {
  const header = declarations(".terminal-command-block > header");
  expect(paints(header.background)).toBe(false);
  expect(paints(header["background-color"])).toBe(false);
});

it("sets the command apart from its output by type alone: the bright text, heavier than the output", () => {
  const command = declarations(".terminal-command-block > header > code");
  // The output is drawn in the Terminal foreground, a step under the bright text.
  expect(command.color).toBe("var(--fg-bright)");
  expect(command["font-weight"]).toBe("calc(var(--font-terminal-weight, 400) + 200)");
});

it("leaves no output gap under a block without output", () => {
  expect(declarations(".terminal-output-clip.empty").margin).toBe("0");
});

it("marks the command line as the next command with a hairline above it, close under the last block", () => {
  expect(paints(declarations(".terminal-command-composer")["border-top"])).toBe(true);
  expect(lastToken(declarations(".terminal-block-scroll").padding)).toBe("0");
});

it("paints no tint behind a running block, whose xterm canvas has the plain Terminal background", () => {
  const rule = declarations(".terminal-command-block.running");
  expect(paints(rule.background)).toBe(false);
  expect(paints(rule["background-color"])).toBe(false);
});

it("tints a failed block with the variable its xterm canvas background is set from, so the two always match", () => {
  expect(declarations(".terminal-command-block.failed").background).toBe("var(--terminal-failed-background)");
});

it("draws the red text of a failed block toward the bright text, the tone its contrast test checks", () => {
  const tone = "color-mix(in srgb, var(--red) 85%, var(--fg-bright))";
  expect(declarations(".terminal-command-block.failed .terminal-block-prompt").color).toBe(tone);
  expect(declarations(".terminal-command-block.failed .terminal-block-status.error").color).toBe(tone);
});


// Titanium tokens: --acc2, --faint and the Terminal background, dark (styles.css) and light (appearance.ts).
const hexLuminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: string, b: string, share: number) =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * share + parseInt(b.slice(i, i + 2), 16) * (1 - share)).toString(16).padStart(2, "0")).join("")}`;

it("leaves selecting output to xterm: a native drag never paints the system highlight over its canvas", () => {
  const screen = declarations(".terminal-block-output .xterm-screen");
  expect(screen["user-select"]).toBe("none");
  expect(screen["-webkit-user-select"]).toBe("none");
});

it.each([
  ["dark", "#58A6FF", "#E8E6E1", "#1C1C1E"],
  ["light", "#0860C7", "#2C2C2E", "#FBFBFA"],
])("selects other Terminal text with a soft accent tint under the Terminal text colour on %s", (_, accent, text, background) => {
  const selection = declarations(".terminal-workbench ::selection");
  const match = /^color-mix\(in srgb, var\(--acc2\) (\d+)%, transparent\)$/.exec(selection.background);
  expect(match, selection.background).not.toBeNull();
  expect(selection.color).toBe("var(--fg)");
  const tint = mix(accent, background, Number(match![1]) / 100);
  expect(ratio(text, tint), `${text} on ${tint}`).toBeGreaterThanOrEqual(4.5);
});

it.each([
  ["dark", "#58A6FF", "#9A9892", "#1C1C1E"],
  ["light", "#0860C7", "#62615C", "#FBFBFA"],
])("tints the $ of a block with a muted accent, set apart from the live prompt's full accent, on %s", (_, accent, faint, background) => {
  const color = declarations(".terminal-block-prompt").color;
  const match = /^color-mix\(in srgb, var\(--acc2\) (\d+)%, var\(--faint\)\)$/.exec(color);
  expect(match, color).not.toBeNull();
  const tint = mix(accent, faint, Number(match![1]) / 100);
  expect(ratio(tint, background), `${tint} on ${background}`).toBeGreaterThanOrEqual(4.5);
  expect(declarations(".terminal-command-composer:focus-within .terminal-prompt-symbol").color).toBe("var(--acc2)");
});
