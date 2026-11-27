// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalAgentIcon, detectCliAgent } from "./agentIcons";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("detectCliAgent", () => {
  it.each([
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
    ["cursor-agent", "cursor"],
    ["cline", "cline"],
    ["droid", "droid"],
    ["kiro-cli", "kiro"],
    ["q chat", "kiro"],
    ["qwen", "qwen"],
    ["vibe", "vibe"],
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

  it("renders the agent SVG when an agent CLI is running and falls back to TerminalIcon otherwise", async () => {
    await act(async () => root.render(<TerminalAgentIcon command="claude" size={16} />));
    expect(host.querySelector('[data-agent="claude"]')).not.toBeNull();

    await act(async () => root.render(<TerminalAgentIcon command="npm test" size={16} />));
    expect(host.querySelector("[data-agent]")).toBeNull();
    expect(host.querySelector("svg")).not.toBeNull();
  });
});
