import { describe, expect, it } from "vitest";
import { customAgentFor, customAgentName, customProviderId, isCustomProvider, newAgentId } from "./customAgents";

const mine = { id: "mine", name: "My agent", command: "my-agent" };

describe("custom agents", () => {
  it("names a Thread's agent by its provider id", () => {
    expect(customProviderId(mine)).toBe("custom:mine");
    expect(isCustomProvider("custom:mine")).toBe(true);
    expect(isCustomProvider("claude")).toBe(false);
    expect(customAgentFor("custom:mine", [mine])).toBe(mine);
    expect(customAgentName("custom:mine", [mine])).toBe("My agent");
  });

  it("falls back to a plain label once the agent was removed", () => {
    expect(customAgentFor("custom:mine", [])).toBeUndefined();
    expect(customAgentName("custom:mine", [])).toBe("Custom agent");
  });

  it("makes ids Core accepts", () => {
    expect(newAgentId([])).toMatch(/^[a-z0-9]{1,32}$/);
  });
});
