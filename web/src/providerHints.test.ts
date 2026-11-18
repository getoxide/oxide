import { describe, expect, it } from "vitest";
import {
  getClaudeCodeHint,
  CLAUDE_30_DAY_RETENTION_WARNING,
} from "./providerHints";

describe("providerHints", () => {
  it("provides install hint when Claude Code is not installed", () => {
    const hint = getClaudeCodeHint({
      available: false,
      installed: false,
      version: null,
      authenticated: false,
      warning: null,
    });
    expect(hint).not.toBeNull();
    expect(hint?.type).toBe("missing");
    expect(hint?.command).toBe("npm install -g @anthropic-ai/claude-code");
  });

  it("provides login hint when Claude Code is installed but not authenticated", () => {
    const hint = getClaudeCodeHint({
      available: false,
      installed: true,
      version: "1.0.0",
      authenticated: false,
      warning: null,
    });
    expect(hint).not.toBeNull();
    expect(hint?.type).toBe("unauthenticated");
    expect(hint?.command).toBe("claude login");
  });

  it("passes a Provider's own warning through", () => {
    const hint = getClaudeCodeHint({
      available: true,
      installed: true,
      version: "3.0.0",
      authenticated: true,
      warning: "Something the Provider reported",
    });
    expect(hint).not.toBeNull();
    expect(hint?.type).toBe("warning");
    expect(hint?.message).toBe("Something the Provider reported");
  });

  it("exposes the 30-day session retention warning", () => {
    expect(CLAUDE_30_DAY_RETENTION_WARNING).toContain("30 days");
    expect(CLAUDE_30_DAY_RETENTION_WARNING).toContain("retention");
  });
});
