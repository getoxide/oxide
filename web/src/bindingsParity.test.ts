import { describe, expect, it } from "vitest";
import { commands } from "./bindings";

const productionSources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./bindings.ts", "!./**/*.test.{ts,tsx}", "!./**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
);

describe("IPC bindings parity", () => {
  it("references every generated command in production frontend sources", () => {
    const commandNames = Object.keys(commands);
    const sourceCorpus = Object.values(productionSources).join("\n");

    expect(commandNames.length).toBeGreaterThan(0);
    expect(Object.keys(productionSources).length).toBeGreaterThan(0);

    const unused = commandNames.filter(
      (name) => !new RegExp(`\\bcommands\\s*\\.\\s*${name}\\b`).test(sourceCorpus),
    );
    expect(unused).toEqual([]);
  });
});
