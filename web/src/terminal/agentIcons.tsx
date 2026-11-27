import { useId } from "react";
import { TerminalIcon } from "@primer/octicons-react";

export type CliAgentId =
  | "antigravity"
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
  | "vibe"
  | "pi"
  | "kimi"
  | "crush"
  | "roo"
  | "kilo"
  | "augment"
  | "openhands";

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
  agy: { id: "antigravity", name: "Antigravity" },
  antigravity: { id: "antigravity", name: "Antigravity" },
  "antigravity-cli": { id: "antigravity", name: "Antigravity" },
  "@google/antigravity": { id: "antigravity", name: "Antigravity" },
  claude: { id: "claude", name: "Claude Code" },
  "claude-cli": { id: "claude", name: "Claude Code" },
  "claude-code": { id: "claude", name: "Claude Code" },
  "@anthropic-ai/claude-code": { id: "claude", name: "Claude Code" },
  codex: { id: "codex", name: "OpenAI Codex" },
  "codex-cli": { id: "codex", name: "OpenAI Codex" },
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
  agent: { id: "cursor", name: "Cursor" },
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
  pi: { id: "pi", name: "Pi" },
  "pi-coding-agent": { id: "pi", name: "Pi" },
  "@mariozechner/pi-coding-agent": { id: "pi", name: "Pi" },
  kimi: { id: "kimi", name: "Kimi" },
  "kimi-cli": { id: "kimi", name: "Kimi" },
  crush: { id: "crush", name: "Crush" },
  roo: { id: "roo", name: "Roo Code" },
  "roo-code": { id: "roo", name: "Roo Code" },
  kilo: { id: "kilo", name: "Kilo Code" },
  kilocode: { id: "kilo", name: "Kilo Code" },
  "@kilocode/cli": { id: "kilo", name: "Kilo Code" },
  auggie: { id: "augment", name: "Augment" },
  augment: { id: "augment", name: "Augment" },
  "@augmentcode/auggie": { id: "augment", name: "Augment" },
  openhands: { id: "openhands", name: "OpenHands" },
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
  antigravity: "#60A5FA",
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
  pi: "#F472B6",
  kimi: "#38BDF8",
  crush: "#FB7185",
  roo: "#A78BFA",
  kilo: "#FBBF24",
  augment: "#34D399",
  openhands: "#F59E0B",
};

function AntigravityGlyph() {
  const gradId = useId();
  return (
    <>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F87171" />
          <stop offset="28%" stopColor="#FACC15" />
          <stop offset="56%" stopColor="#4ADE80" />
          <stop offset="80%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#818CF8" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradId})`}
        d="M6.8 2h2.4l4.3 12h-2.4l-.9-2.8H5.8L4.9 14H2.5L6.8 2Zm.2 7.2h2L8 5.6 7 9.2Z"
      />
    </>
  );
}

function AgentGlyph({ id }: { id: CliAgentId }) {
  switch (id) {
    case "antigravity":
      return <AntigravityGlyph />;
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
    case "pi":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          d="M3.2 4.5h9.6M6 4.5v8.5M10.2 4.5v6.8c0 1.1.6 1.7 1.6 1.7"
        />
      );
    case "kimi":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 2.8v10.4M11.5 3.2 5.2 8l6.3 4.8"
        />
      );
    case "crush":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          d="M11.8 4.4A4.8 4.8 0 1 0 11.8 11.6"
        />
      );
    case "roo":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 13.2V3h4.2a2.6 2.6 0 0 1 0 5.2H4m3.8 0 3.7 5"
        />
      );
    case "kilo":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5.5 5v6M10.5 5 6.8 8l3.7 3" strokeLinecap="round" />
        </g>
      );
    case "augment":
      return (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8 2.2 13.5 13H2.5L8 2.2Zm0 4.6-2 4h4l-2-4Z"
        />
      );
    case "openhands":
      return (
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="5.2" />
          <path d="M5.5 8.5h5M6.2 6.2v.1M9.8 6.2v.1" strokeWidth="1.6" />
        </g>
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
