// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalAgentIcon, detectCliAgent } from "./agentIcons";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("detectCliAgent", () => {
  it.each([
    ["agy", "antigravity"],
    ["agy --model gemini", "antigravity"],
    ["/usr/local/bin/agy", "antigravity"],
    ["antigravity", "antigravity"],
    ["claude", "claude"],
    ["claude-code --model opus", "claude"],
    ["/usr/local/bin/claude", "claude"],
    ["sudo -u root env FOO=1 claude", "claude"],
    ["npx -y @anthropic-ai/claude-code@latest", "claude"],
    ["codex", "codex"],
    ["bunx @openai/codex", "codex"],
    ["gemini", "gemini"],
    ["npx @google/gemini-cli", "gemini"],
    ["copilot", "copilot"],
    ["gh copilot suggest", "copilot"],
    ["aider --model sonnet", "aider"],
    ["uvx aider-chat", "aider"],
    ["opencode", "opencode"],
    ["goose session", "goose"],
    ["amp", "amp"],
    ["agent", "cursor"],
    ["cursor-agent", "cursor"],
    ["cline", "cline"],
    ["droid", "droid"],
    ["kiro-cli", "kiro"],
    ["q chat", "kiro"],
    ["qwen", "qwen"],
    ["vibe", "vibe"],
    ["pi", "pi"],
    ["kimi", "kimi"],
    ["crush", "crush"],
    ["kilocode", "kilo"],
    ["auggie", "augment"],
    ["openhands", "openhands"],
    ["C:\\tools\\codex.exe", "codex"],
  ])("detects %s as %s", (command, expectedId) => {
    expect(detectCliAgent(command)?.id).toBe(expectedId);
  });

  it.each([null, "", "ls -la", "git status", "npm run dev", "cargo test", "gh pr list"])(
    "returns null for non-agent command %s",
    (command) => {
      expect(detectCliAgent(command)).toBeNull();
    },
  );
});

describe("TerminalAgentIcon", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  afterEach(async () => { await act(async () => root.render(null)); });

  it.each([
    ["agy", "antigravity"],
    ["claude", "claude"],
    ["codex", "codex"],
    ["gemini", "gemini"],
    ["copilot", "copilot"],
    ["aider", "aider"],
    ["opencode", "opencode"],
    ["goose", "goose"],
    ["amp", "amp"],
    ["cursor", "cursor"],
    ["cline", "cline"],
    ["droid", "droid"],
    ["kiro", "kiro"],
    ["qwen", "qwen"],
    ["vibe", "vibe"],
    ["pi", "pi"],
    ["kimi", "kimi"],
    ["crush", "crush"],
    ["roo", "roo"],
    ["kilo", "kilo"],
    ["augment", "augment"],
    ["openhands", "openhands"],
  ])("renders the official logo asset for %s (%s)", async (command, expectedId) => {
    await act(async () => root.render(<TerminalAgentIcon command={command} size={16} />));
    const img = host.querySelector<HTMLImageElement>(`img.terminal-agent-icon[data-agent="${expectedId}"]`);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBeTruthy();
    expect(img!.draggable).toBe(false);
  });

  it("falls back to TerminalIcon when no agent CLI is running", async () => {
    await act(async () => root.render(<TerminalAgentIcon command="npm test" size={16} />));
    expect(host.querySelector("[data-agent]")).toBeNull();
    expect(host.querySelector("svg")).not.toBeNull();
  });
});
