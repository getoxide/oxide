import { TerminalIcon } from "@primer/octicons-react";
import aiderIcon from "./agent-icons/aider.png";
import ampIcon from "./agent-icons/amp.svg";
import antigravityIcon from "./agent-icons/antigravity.svg";
import augmentIcon from "./agent-icons/augment.svg";
import claudeIcon from "./agent-icons/claude.svg";
import clineIcon from "./agent-icons/cline.svg";
import codexIcon from "./agent-icons/codex.svg";
import copilotIcon from "./agent-icons/copilot.svg";
import crushIcon from "./agent-icons/crush.svg";
import cursorIcon from "./agent-icons/cursor.svg";
import droidIcon from "./agent-icons/droid.svg";
import geminiIcon from "./agent-icons/gemini.svg";
import gooseIcon from "./agent-icons/goose.svg";
import kiloIcon from "./agent-icons/kilo.svg";
import kimiIcon from "./agent-icons/kimi.svg";
import kiroIcon from "./agent-icons/kiro.svg";
import opencodeIcon from "./agent-icons/opencode.svg";
import openhandsIcon from "./agent-icons/openhands.svg";
import piIcon from "./agent-icons/pi.svg";
import qwenIcon from "./agent-icons/qwen.svg";
import rooIcon from "./agent-icons/roo.svg";
import vibeIcon from "./agent-icons/vibe.svg";

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

const AGENT_ICONS: Record<CliAgentId, string> = {
  antigravity: antigravityIcon,
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  copilot: copilotIcon,
  aider: aiderIcon,
  opencode: opencodeIcon,
  goose: gooseIcon,
  amp: ampIcon,
  cursor: cursorIcon,
  cline: clineIcon,
  droid: droidIcon,
  kiro: kiroIcon,
  qwen: qwenIcon,
  vibe: vibeIcon,
  pi: piIcon,
  kimi: kimiIcon,
  crush: crushIcon,
  roo: rooIcon,
  kilo: kiloIcon,
  augment: augmentIcon,
  openhands: openhandsIcon,
};

const MONOCHROME_AGENTS = new Set<CliAgentId>([
  "copilot",
  "goose",
  "cursor",
  "cline",
  "droid",
  "qwen",
  "roo",
  "kilo",
  "augment",
]);

export function TerminalAgentIcon({ command, size }: { command: string | null; size: number }) {
  const agent = detectCliAgent(command);
  if (!agent) return <TerminalIcon size={size} />;
  return (
    <img
      src={AGENT_ICONS[agent.id]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="terminal-agent-icon"
      data-agent={agent.id}
      data-monochrome={MONOCHROME_AGENTS.has(agent.id) || undefined}
    />
  );
}
