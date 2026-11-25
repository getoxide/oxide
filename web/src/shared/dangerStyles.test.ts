import { expect, it } from "vitest";
import stylesCss from "../styles/styles.css?raw";
import appearanceCss from "../styles/appearance.css?raw";

// jsdom does not cascade stylesheets, so this reads the declarations each rule gives a selector.
const css = [stylesCss, appearanceCss].join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
function rules(match: (selector: string) => boolean): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].split(",").some((s) => match(s.trim().replace(/\s+/g, " ")))) continue;
    const declarations: Record<string, string> = {};
    for (const line of rule[2].split(";")) {
      const at = line.indexOf(":");
      if (at > 0) declarations[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    found.push(declarations);
  }
  return found;
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

it("paints destructive buttons from theme tokens only, never a hard-coded colour", () => {
  const danger = rules((s) => s.includes("button.danger"));
  expect(danger.length).toBeGreaterThan(0);
  for (const declarations of danger)
    for (const [property, value] of Object.entries(declarations)) {
      if (property.startsWith("--")) throw new Error(`.danger redefines ${property}`);
      expect(value, property).not.toMatch(/#[\da-f]{3,8}\b/i);
    }
});

it("defines the danger tokens for dark and light, each keeping its text above 4.5:1", () => {
  for (const theme of [":root", ':root[data-appearance="light"]']) {
    const tokens = Object.assign({}, ...rules((s) => s === theme));
    for (const fill of ["--danger", "--danger-hover", "--danger-active"]) {
      expect(tokens[fill], `${theme} ${fill}`).toMatch(/^#[\da-f]{6}$/i);
      expect(contrast(tokens[fill], tokens["--on-danger"]), `${theme} ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
