import { expect, it } from "vitest";
import interactionsCss from "../styles/interactions.css?raw";
import stylesCss from "../styles/styles.css?raw";

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function rules(source: string, match: (selector: string) => boolean): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  for (const rule of stripComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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

it("never scale-shrinks the issue description chevron toggle on :active", () => {
  const activeRules = rules(interactionsCss, (s) => s.includes(".issue-body-toggle") && s.includes(":active"));
  expect(activeRules.length).toBeGreaterThan(0);
  expect(activeRules.some((d) => d.transform === "none")).toBe(true);
});

it("rotates the issue description chevron when expanded", () => {
  const expanded = rules(
    stylesCss,
    (s) => s.includes(".issue-body-toggle") && s.includes('[aria-expanded="true"]') && s.includes(".pr-chev"),
  );
  expect(expanded.length).toBeGreaterThan(0);
  expect(expanded.some((d) => d.transform === "rotate(180deg)")).toBe(true);
});

it("preserves .md padding inside a collapsible issue description card", () => {
  const padded = rules(
    stylesCss,
    (s) => s === ".pr-views .pr-entry-card > .collapsible > .collapsible-inner > .md",
  );
  expect(padded.length).toBeGreaterThan(0);
  expect(padded.some((d) => d.padding === "8px 10px")).toBe(true);
});

it("constrains linked issue sections and items so long titles truncate without overflowing", () => {
  const section = rules(stylesCss, (s) => s === ".pr-views .issue-linked-section");
  const list = rules(stylesCss, (s) => s === ".pr-views .issue-linked-list");
  const item = rules(stylesCss, (s) => s === ".pr-views .issue-linked-item");
  expect(section.some((d) => d["grid-template-columns"] === "minmax(0, 1fr)" && d["min-width"] === "0")).toBe(true);
  expect(list.some((d) => d["grid-template-columns"] === "minmax(0, 1fr)" && d["min-width"] === "0")).toBe(true);
  expect(item.some((d) => d["min-width"] === "0" && d.overflow === "hidden")).toBe(true);
});
