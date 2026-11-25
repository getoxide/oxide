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

it("sets the command line apart from its output: a raised header band and a heavier command", () => {
  const header = declarations(".terminal-command-block > header");
  // Translucent over the block, so it raises the plain and the red-tinted block alike.
  expect(header.background).toBe("color-mix(in srgb, var(--fg-bright) 4%, transparent)");
  expect(declarations(".terminal-command-block > header > code")["font-weight"]).toBe(
    "calc(var(--font-terminal-weight, 400) + 200)",
  );
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
