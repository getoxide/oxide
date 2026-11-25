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

it("hangs both $ prompts in the gutter, so commands, their output and the command line share one text edge", () => {
  const block = declarations(".terminal-block-prompt");
  const line = declarations(".terminal-prompt-symbol");
  expect(block["margin-left"]).toMatch(/^-/);
  expect(line["margin-left"]).toBe(block["margin-left"]);
  expect(line.width).toBe(block.width);
  expect(declarations(".terminal-command-composer").padding.split(" ")[1]).toBe(
    declarations(".terminal-command-block").padding.split(" ")[1],
  );
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
