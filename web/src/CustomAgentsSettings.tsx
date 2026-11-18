import { PlusIcon, TrashIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { CustomAgent } from "./bindings";
import { CUSTOM_AGENT_LIMITS, newAgentId } from "./customAgents";
import { ProviderMark } from "./ProviderMark";

interface Props {
  agents: CustomAgent[];
  onChange: (agents: CustomAgent[]) => void;
  /** The validation messages Core reported for a settings path such as `customAgents.0.name`. */
  fieldErrors: (path: string) => ReactNode;
}

/**
 * Settings for Custom agents (ADR-0017): an agent CLI the user adds with a name and the command
 * that launches it. Core validates both; the command runs through the user's shell.
 */
export function CustomAgentsSettings({ agents, onChange, fieldErrors }: Props) {
  const update = (index: number, patch: Partial<CustomAgent>) =>
    onChange(agents.map((agent, i) => (i === index ? { ...agent, ...patch } : agent)));
  return (
    <section className="settings-card" aria-labelledby="settings-custom-agents">
      <h3 className="settings-provider-title" id="settings-custom-agents">
        <span aria-hidden="true">
          <ProviderMark provider="custom:" size={20} />
        </span>
        Custom agents
      </h3>
      <p className="hint">
        Add an agent CLI by name and the command that launches it. The command runs in your shell, in the Thread&apos;s
        worktree. {CUSTOM_AGENT_LIMITS}
      </p>
      {agents.map((agent, index) => (
        <div className="settings-fields" key={agent.id} role="group" aria-label={`Custom agent ${agent.name || index + 1}`}>
          <label className="settings-field">
            <span>Name</span>
            <input
              value={agent.name}
              maxLength={40}
              aria-label={`Custom agent ${index + 1} name`}
              onChange={(e) => update(index, { name: e.target.value })}
            />
            {fieldErrors(`customAgents.${index}.name`)}
          </label>
          <label className="settings-field">
            <span>Command</span>
            <input
              className="mono"
              value={agent.command}
              maxLength={512}
              spellCheck={false}
              aria-label={`Custom agent ${index + 1} command`}
              onChange={(e) => update(index, { command: e.target.value })}
            />
            {fieldErrors(`customAgents.${index}.command`)}
          </label>
          <button
            type="button"
            className="btn sm"
            aria-label={`Remove ${agent.name || `custom agent ${index + 1}`}`}
            onClick={() => onChange(agents.filter((_, i) => i !== index))}
          >
            <TrashIcon size={12} /> Remove
          </button>
        </div>
      ))}
      {agents.length > 0 && (
        <p className="hint">Removing an agent keeps its Threads in the sidebar; they cannot be launched again.</p>
      )}
      <button
        type="button"
        className="btn sm"
        disabled={agents.length >= 16}
        onClick={() =>
          onChange([...agents, { id: newAgentId(agents.map((a) => a.id)), name: "", command: "" }])
        }
      >
        <PlusIcon size={12} /> Add a custom agent
      </button>
    </section>
  );
}
