import type { CustomAgent } from "./bindings";

/** The prefix of a Custom agent's id in a Thread's `provider` (matches Core). */
export const CUSTOM_PREFIX = "custom:";

export const isCustomProvider = (provider: string) => provider.startsWith(CUSTOM_PREFIX);

export const customProviderId = (agent: Pick<CustomAgent, "id">) => `${CUSTOM_PREFIX}${agent.id}`;

/** The configured Custom agent a Thread's `provider` names, or undefined once it was removed. */
export function customAgentFor(provider: string, agents: readonly CustomAgent[]): CustomAgent | undefined {
  if (!isCustomProvider(provider)) return undefined;
  const id = provider.slice(CUSTOM_PREFIX.length);
  return agents.find((agent) => agent.id === id);
}

/** What to call a Custom agent's Thread: its name, or a plain label once it was removed. */
export function customAgentName(provider: string, agents: readonly CustomAgent[]): string {
  return customAgentFor(provider, agents)?.name ?? "Custom agent";
}

/** What Oxide cannot know about a Custom agent, shown wherever one is offered or running. */
export const CUSTOM_AGENT_LIMITS =
  "Reports no status or Turns unless it emits OSC 7501 itself, and has no Permission mode, Model list or resume.";

/** A new agent's stable id: lowercase letters and digits, unique among `taken`. */
export function newAgentId(taken: readonly string[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "") || "agent";
    if (!taken.includes(id)) return id;
  }
}
