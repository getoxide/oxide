import { expect, it } from "vitest";
import bindings from "./bindings.ts?raw";

// ADR-0015: every command the backend exports is called by the frontend, so a command is never
// left behind when its feature goes, and a feature never ships without its caller.

const production = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/*.d.ts", "!./bindings.ts"],
  { query: "?raw", import: "default", eager: true },
);

it("calls every exported command from production frontend code", () => {
  const block = bindings.slice(bindings.indexOf("export const commands = {"));
  const commands = [...block.matchAll(/^\t([a-zA-Z]+): \(/gm)].map((match) => match[1]);
  expect(commands.length).toBeGreaterThan(0);

  const code = Object.values(production).join("\n");
  expect(Object.keys(production).length).toBeGreaterThan(0);
  const unused = commands.filter((name) => !new RegExp(`\\b${name}\\b`).test(code));
  expect(unused).toEqual([]);
});
