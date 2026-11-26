import { expect, it } from "vitest";
import interactionsCss from "./interactions.css?raw";

it("never flashes a description or comment card when it, or a control in it, is pressed", () => {
  const css = interactionsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const pressRules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]).filter((s) => s.includes(":active"));
  expect(pressRules.length).toBeGreaterThan(0);
  for (const selector of pressRules) expect(selector).not.toContain(".pr-entry-card");
});
