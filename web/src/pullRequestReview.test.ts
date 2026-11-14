import { describe, expect, it } from "vitest";
import type { PullRequestCheck } from "./bindings";
import {
  avatarUrl,
  countChecks,
  dedupeChecks,
  defaultMergeMethod,
  mergeLabel,
  mergeRequirements,
  readiness,
} from "./pullRequestReview";

const check = (name: string, state: PullRequestCheck["state"]): PullRequestCheck => ({
  name,
  state,
  url: null,
  required: false,
});
const open = { phase: "open", mergeState: "clean", reviewDecision: null } as const;

describe("defaultMergeMethod", () => {
  it("keeps the current choice while the repository still allows it", () => {
    expect(defaultMergeMethod(["merge", "squash"], "squash")).toBe("squash");
  });

  it("falls back to the first allowed method", () => {
    expect(defaultMergeMethod(["merge", "squash"], "rebase")).toBe("merge");
    expect(defaultMergeMethod(["rebase"], null)).toBe("rebase");
  });

  it("prefers the method GitHub's merge box would offer over the first allowed", () => {
    expect(defaultMergeMethod(["merge", "squash"], null, "squash")).toBe("squash");
    expect(defaultMergeMethod(["merge"], null, "squash")).toBe("merge");
    expect(defaultMergeMethod(["merge", "squash"], "merge", "squash")).toBe("merge");
  });

  it("is null when the repository allows no merge", () => {
    expect(defaultMergeMethod([], "merge")).toBeNull();
  });
});

describe("mergeLabel", () => {
  it("names each method the way GitHub does", () => {
    expect(mergeLabel("merge")).toBe("Create a merge commit");
    expect(mergeLabel("squash")).toBe("Squash and merge");
    expect(mergeLabel("rebase")).toBe("Rebase and merge");
  });
});

describe("dedupeChecks", () => {
  it("keeps the worst state per name and lists failures first", () => {
    const out = dedupeChecks([
      check("rust", "success"),
      check("web", "success"),
      check("rust", "pending"),
      check("lint", "failure"),
    ]);
    expect(out).toEqual([check("lint", "failure"), check("rust", "pending"), check("web", "success")]);
  });
});

describe("readiness", () => {
  it("blocks on draft, then conflicts, then failures, then running checks", () => {
    expect(readiness({ ...open, phase: "draft", checks: [] }).tone).toBe("neutral");
    expect(readiness({ ...open, checks: [check("a", "failure")] }).label).toBe("1 check failing");
    expect(readiness({ ...open, checks: [check("a", "pending"), check("a", "success")] }).tone).toBe("warn");
    expect(readiness({ ...open, mergeState: "conflicting", checks: [check("a", "failure")] }).tone).toBe("bad");
    expect(readiness({ ...open, checks: [check("a", "success")] })).toEqual({ tone: "ok", label: "Ready to merge" });
  });

  it("puts a request for changes ahead of passing checks", () => {
    const r = readiness({ ...open, reviewDecision: "changesRequested", checks: [check("a", "success")] });
    expect(r).toEqual({ tone: "bad", label: "Changes requested" });
  });
});

describe("mergeRequirements", () => {
  it("lists conflicts, review and checks, worst first", () => {
    const rows = mergeRequirements({
      phase: "open",
      mergeState: "conflicting",
      reviewDecision: "approved",
      checks: [check("a", "pending")],
    });
    expect(rows.map((r) => [r.kind, r.tone])).toEqual([
      ["conflicts", "bad"],
      ["review", "ok"],
    ]);
  });

  it("says when the branch is behind or the conflicts are still being computed", () => {
    expect(mergeRequirements({ ...open, mergeState: "behind", checks: [] })[0]).toMatchObject({ kind: "behind", tone: "warn" });
    expect(mergeRequirements({ ...open, mergeState: "unknown", checks: [] })[0].title).toBe("Checking for conflicts…");
    expect(mergeRequirements({ ...open, phase: "merged", mergeState: "unknown", checks: [] })).toEqual([]);
  });
});

describe("avatarUrl", () => {
  it("points at the user's GitHub avatar, and at the bot's for `app/` logins", () => {
    expect(avatarUrl("octocat")).toBe("https://github.com/octocat.png?size=40");
    expect(avatarUrl("app/dependabot", 64)).toBe("https://github.com/dependabot.png?size=64");
  });
});

describe("countChecks", () => {
  const required = (name: string, state: PullRequestCheck["state"]): PullRequestCheck => ({ ...check(name, state), required: true });

  it("counts only the required checks once branch protection names some, as GitHub's merge box does", () => {
    const checks = [required("rust", "pending"), required("web", "success"), check("rust (macos-latest)", "pending"), check("supply-chain", "pending")];
    expect(countChecks(checks)).toEqual({ failing: 0, pending: 1, passing: 1 });
  });

  it("counts every check when none is marked required", () => {
    expect(countChecks([check("a", "pending"), check("b", "success")])).toEqual({ failing: 0, pending: 1, passing: 1 });
  });

  it("does not hold the merge up for an optional check that is running", () => {
    const checks = [required("rust", "success"), check("supply-chain", "pending")];
    expect(readiness({ ...open, checks })).toEqual({ tone: "ok", label: "Ready to merge" });
  });
});
