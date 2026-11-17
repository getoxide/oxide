import { describe, expect, it } from "vitest";
import type { Settings } from "./bindings";
import { defaultDispatchForm, dispatchRequest, isBoardThread, issueDispatchForm, startsAsTerminal, terminalIssue, withProvider } from "./dispatch";

const settings = {
  defaultProvider: "claude",
  providers: {
    claude: { model: "opus", effort: "high", permissionMode: "ask" },
    codex: { model: null, effort: null, permissionMode: "full-access" },
    antigravity: { model: null, effort: null, permissionMode: "auto-edit" },
  },
} as unknown as Settings;

describe("dispatch form", () => {
  it("is prefilled with the default Provider's settings and the checked-out branch", () => {
    expect(defaultDispatchForm(settings, "main")).toEqual({
      prompt: "",
      provider: "claude",
      model: "opus",
      effort: "high",
      permissionMode: "ask",
      baseBranch: "main",
    });
  });

  it("takes the other Provider's defaults when the Provider changes, keeping prompt and branch", () => {
    const form = { ...defaultDispatchForm(settings, "dev"), prompt: "Fix it" };
    expect(withProvider(form, settings, "codex")).toEqual({
      prompt: "Fix it",
      provider: "codex",
      model: "",
      effort: "",
      permissionMode: "full-access",
      baseBranch: "dev",
    });
  });

  it("sends blank optional fields as null and trims the prompt", () => {
    const form = { ...defaultDispatchForm(settings, ""), prompt: "  Fix it \n", model: " ", effort: "low" };
    expect(dispatchRequest(7, form)).toEqual({
      projectId: 7,
      prompt: "Fix it",
      provider: "claude",
      model: null,
      effort: "low",
      permissionMode: "ask",
      baseBranch: null,
      issueNumber: null,
      issueTitle: null,
      issueUrl: null,
      issueLabels: [],
    });
  });

  it("starts from an issue: the prompt carries its number, title, body and URL, and the request links it", () => {
    const issue = { number: 51, title: "Start a Thread", body: "Do it.", url: "https://github.com/o/r/issues/51", labels: ["bug", "backend"] };
    const form = issueDispatchForm(defaultDispatchForm(settings, "dev"), issue);
    expect(form.prompt).toBe("Issue #51: Start a Thread\nhttps://github.com/o/r/issues/51\n\nDo it.");
    expect(form.provider).toBe("claude");
    const edited = { ...form, prompt: `${form.prompt} Be quick.` };
    expect(dispatchRequest(7, edited, issue)).toMatchObject({
      issueNumber: 51,
      issueTitle: "Start a Thread",
      issueUrl: "https://github.com/o/r/issues/51",
      issueLabels: ["bug", "backend"],
    });
  });

  it("tells Board Threads from chat Threads by their branch", () => {
    expect(isBoardThread({ branch: "oxide/x" })).toBe(true);
    expect(isBoardThread({ branch: null })).toBe(false);
  });
});

describe("starting from an issue as a terminal Thread", () => {
  const issue = { number: 7, title: "Crash", body: "- it crashes", url: "https://github.com/o/r/issues/7" };

  it("needs the preview, a Provider with a launch recipe and an issue", () => {
    const on = { openThreadsAsTerminals: true };
    expect(startsAsTerminal(on, "claude", issue)).toBe(true);
    expect(startsAsTerminal(on, "codex", issue)).toBe(true);
    expect(startsAsTerminal(on, "antigravity", issue)).toBe(false);
    expect(startsAsTerminal(on, "claude", undefined)).toBe(false);
    expect(startsAsTerminal({ openThreadsAsTerminals: false }, "claude", issue)).toBe(false);
  });

  it("hands Core the issue as it is, leaving the quoting to Core", () => {
    expect(terminalIssue({ ...issue, labels: ["bug"] })).toEqual({ ...issue, labels: ["bug"] });
    expect(terminalIssue(issue).labels).toEqual([]);
  });
});

describe("a Custom agent from an issue", () => {
  it("always starts as a terminal Thread, even with the preview off", () => {
    const issue = { number: 1, title: "t", body: "b", url: "u" };
    expect(startsAsTerminal({ openThreadsAsTerminals: false }, "custom:mine", issue)).toBe(true);
    expect(startsAsTerminal({ openThreadsAsTerminals: false }, "claude", issue)).toBe(false);
    expect(startsAsTerminal({ openThreadsAsTerminals: false }, "custom:mine", undefined)).toBe(false);
  });
});
