import { TerminalIcon } from "@primer/octicons-react";

export type CliAgentId =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "aider"
  | "opencode"
  | "goose"
  | "amp"
  | "cursor"
  | "cline"
  | "droid"
  | "kiro"
  | "qwen"
  | "vibe";

export interface CliAgent {
  id: CliAgentId;
  name: string;
}

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice"]);
const VALUE_FLAGS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-S"],
  nice: ["-n"],
};
const RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx", "dlx"]);
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "--from", "-c", "--call"]);

const AGENT_NAMES: Record<string, CliAgent> = {
  claude: { id: "claude", name: "Claude Code" },
  "claude-code": { id: "claude", name: "Claude Code" },
  "@anthropic-ai/claude-code": { id: "claude", name: "Claude Code" },
  codex: { id: "codex", name: "OpenAI Codex" },
  "@openai/codex": { id: "codex", name: "OpenAI Codex" },
  gemini: { id: "gemini", name: "Gemini CLI" },
  "gemini-cli": { id: "gemini", name: "Gemini CLI" },
  "@google/gemini-cli": { id: "gemini", name: "Gemini CLI" },
  copilot: { id: "copilot", name: "GitHub Copilot" },
  "@github/copilot": { id: "copilot", name: "GitHub Copilot" },
  "@githubnext/github-copilot-cli": { id: "copilot", name: "GitHub Copilot" },
  aider: { id: "aider", name: "Aider" },
  "aider-chat": { id: "aider", name: "Aider" },
  opencode: { id: "opencode", name: "OpenCode" },
  "opencode-ai": { id: "opencode", name: "OpenCode" },
  goose: { id: "goose", name: "Goose" },
  amp: { id: "amp", name: "Amp" },
  "@sourcegraph/amp": { id: "amp", name: "Amp" },
  "cursor-agent": { id: "cursor", name: "Cursor" },
  cursor: { id: "cursor", name: "Cursor" },
  cline: { id: "cline", name: "Cline" },
  droid: { id: "droid", name: "Factory Droid" },
  "kiro-cli": { id: "kiro", name: "Kiro" },
  kiro: { id: "kiro", name: "Kiro" },
  qwen: { id: "qwen", name: "Qwen Code" },
  "qwen-code": { id: "qwen", name: "Qwen Code" },
  "@qwen-code/qwen-code": { id: "qwen", name: "Qwen Code" },
  vibe: { id: "vibe", name: "Mistral Vibe" },
  "mistral-vibe": { id: "vibe", name: "Mistral Vibe" },
};

function normalizeToken(raw: string): string {
  const unquoted = raw.replace(/^["']|["']$/g, "");
  // Keep scoped npm package names intact (`@scope/pkg@latest` -> `@scope/pkg`).
  if (unquoted.startsWith("@")) {
    const slash = unquoted.indexOf("/");
    if (slash > 0) {
      const atVersion = unquoted.indexOf("@", slash + 1);
      return (atVersion > 0 ? unquoted.slice(0, atVersion) : unquoted).toLowerCase();
    }
  }
  const base = unquoted.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * Pure cosmetic detection of common CLI coding agents from a running command line.
 * Never alters execution or spawns processes (ADR-0018).
 */
export function detectCliAgent(command: string | null): CliAgent | null {
  if (!command) return null;
  const line = command.split(/\r?\n/).find((part) => part.trim()) ?? "";
  const segment = (line.split(/\|\||&&|[|;&]/)[0] ?? "")
    .replace(/=("[^"]*"|'[^']*')/g, "=_")
    .replace(/^[\s({]+/, "");
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;

  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index++;
      continue;
    }
    const base = normalizeToken(word);
    if (WRAPPERS.has(base)) {
      index++;
      while (index < words.length && words[index].startsWith("-")) {
        index += VALUE_FLAGS[base]?.includes(words[index]) ? 2 : 1;
      }
      continue;
    }
    break;
  }

  const head = words[index];
  if (!head) return null;
  const normalized = normalizeToken(head);

  if (RUNNERS.has(normalized)) {
    let next = index + 1;
    while (next < words.length && words[next].startsWith("-")) {
      next += RUNNER_VALUE_FLAGS.has(words[next]) ? 2 : 1;
    }
    const pkg = words[next] ? normalizeToken(words[next]) : "";
    return AGENT_NAMES[pkg] ?? null;
  }

  if (normalized === "gh" && words[index + 1]?.toLowerCase() === "copilot") {
    return { id: "copilot", name: "GitHub Copilot" };
  }

  if (normalized === "q" && words[index + 1]?.toLowerCase() === "chat") {
    return { id: "kiro", name: "Kiro" };
  }

  return AGENT_NAMES[normalized] ?? null;
}

const AGENT_COLORS: Record<CliAgentId, string> = {
  claude: "#D97757",
  codex: "#10A37F",
  gemini: "#58A6FF",
  copilot: "#A371F7",
  aider: "#5FCB8F",
  opencode: "#E8B84F",
  goose: "#38BDF8",
  amp: "#F34E3F",
  cursor: "var(--fg-bright)",
  cline: "#61AFEF",
  droid: "#F97316",
  kiro: "#9B72F2",
  qwen: "#7C5CFF",
  vibe: "#FF7000",
};

function AgentGlyph({ id }: { id: CliAgentId }) {
  switch (id) {
    case "claude":
      return (
        <path
          d="M8 1.5v13M2.4 4.75l11.2 6.5M13.6 4.75l-11.2 6.5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      );
    case "codex":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <polygon points="8,1.5 13.5,4.7 13.5,11.3 8,14.5 2.5,11.3 2.5,4.7" />
          <circle cx="8" cy="8" r="2.1" />
        </g>
      );
    case "gemini":
      return (
        <path
          fill="currentColor"
          d="M8 1.2C8.4 4.9 11.1 7.6 14.8 8 11.1 8.4 8.4 11.1 8 14.8 7.6 11.1 4.9 8.4 1.2 8 4.9 7.6 7.6 4.9 8 1.2Z"
        />
      );
    case "copilot":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4.2" width="12" height="7.6" rx="3.2" />
          <path d="M5.8 7.5v1.2M10.2 7.5v1.2" strokeWidth="1.6" />
        </g>
      );
    case "aider":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.5 8 2.5l5 11M5.2 9.5h5.6"
        />
      );
    case "opencode":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
          <rect x="5.7" y="5.7" width="4.6" height="4.6" rx="0.8" fill="currentColor" stroke="none" />
        </g>
      );
    case "goose":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 12.5c2-4.5 5-8 10-8.5-1.5 2-2.2 3.8-2.2 5.5 0 2.2-1.8 3.5-4.3 3.5-1.4 0-2.5-.2-3.5-.5Z"
        />
      );
    case "amp":
      return (
        <path
          fill="currentColor"
          d="M9.3 1.5 3.8 8.8h4.1l-1.2 5.7 5.5-7.3H8.1l1.2-5.7Z"
        />
      );
    case "cursor":
      return (
        <path
          fill="currentColor"
          d="M3.2 2.2 13.4 7.6 8.5 9.1 6.9 13.8 3.2 2.2Z"
        />
      );
    case "cline":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <rect x="2.5" y="3.5" width="11" height="9" rx="2.5" />
          <path d="M5.5 8h5" strokeWidth="1.6" />
        </g>
      );
    case "droid":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="10" height="8.5" rx="2" />
          <path d="M6 2.2v2.3M10 2.2v2.3M6 8.5h.1M10 8.5h.1" strokeWidth="1.6" />
        </g>
      );
    case "kiro":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          d="M8 1.8 14.2 8 8 14.2 1.8 8 8 1.8Z"
        />
      );
    case "qwen":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="5" />
          <path d="M8.5 8.5 13 13" />
        </g>
      );
    case "vibe":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.5 12.5V4l5.5 5 5.5-5v8.5"
        />
      );
  }
}

export function TerminalAgentIcon({ command, size }: { command: string | null; size: number }) {
  const agent = detectCliAgent(command);
  if (!agent) return <TerminalIcon size={size} />;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className="terminal-agent-icon"
      data-agent={agent.id}
      style={{ color: AGENT_COLORS[agent.id] }}
      aria-hidden="true"
    >
      <AgentGlyph id={agent.id} />
    </svg>
  );
}
