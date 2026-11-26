import { expect, it } from "vitest";
import interactionsCss from "../styles/interactions.css?raw";
import stylesCss from "../styles/styles.css?raw";

const css = [stylesCss, interactionsCss].join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

function matchingRules(match: (selector: string) => boolean): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, " ");
    if (!match(selector)) continue;
    const declarations: Record<string, string> = {};
    for (const line of rule[2].split(";")) {
      const at = line.indexOf(":");
      if (at > 0) declarations[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    found.push(declarations);
  }
  return found;
}

it("never flashes .pr-entry-card with an :active background rule", () => {
  const activeCardRules = matchingRules(
    (selector) => selector.includes(".pr-entry-card") && selector.includes(":active"),
  );
  expect(activeCardRules).toEqual([]);
});

it("rotates the Issue description chevron when expanded without scale-shrinking on press", () => {
  const activeToggleRules = matchingRules(
    (selector) => selector.includes(".issue-description-toggle") && selector.includes(":active"),
  );
  expect(activeToggleRules.some((r) => r.transform === "none")).toBe(true);

  const expandedChevronRules = matchingRules(
    (selector) => selector.includes('.issue-description-toggle[aria-expanded="true"]') && selector.includes(".pr-chev"),
  );
  expect(expandedChevronRules.some((r) => r.transform === "rotate(180deg)")).toBe(true);
});

it("keeps .md padding inside .pr-entry-card when wrapped in Collapsible", () => {
  const mdPaddingRules = matchingRules(
    (selector) => selector.includes(".pr-entry-card") && selector.includes(".collapsible-inner") && selector.includes(".md"),
  );
  expect(mdPaddingRules.some((r) => r.padding === "8px 10px")).toBe(true);
});
