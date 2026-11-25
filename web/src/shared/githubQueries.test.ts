import { describe, expect, it } from "vitest";
import { githubKeys } from "./githubQueries";

describe("githubKeys", () => {
  it("puts every list and detail under the prefixes that invalidate them, per Project", () => {
    expect(githubKeys.issueList(3, "bug").startsWith(githubKeys.issueLists(3))).toBe(true);
    expect(githubKeys.issueDetail(3, 7).startsWith(githubKeys.issues(3))).toBe(true);
    expect(githubKeys.issuesState(3).startsWith(githubKeys.issues(3))).toBe(true);
    expect(githubKeys.pullRequestList(3, true, "").startsWith(githubKeys.pullRequestLists(3))).toBe(true);
    for (const key of [githubKeys.issueDetail(3, 7), githubKeys.pullRequestDetail(3, 7), githubKeys.pullRequestPreview(3, 7)]) {
      expect(key.startsWith(githubKeys.project(3))).toBe(true);
      expect(key.startsWith(githubKeys.project(31))).toBe(false);
    }
  });

  it("keeps a pull request's detail and its list preview apart: they hold different shapes", () => {
    expect(githubKeys.pullRequestDetail(3, 7)).not.toBe(githubKeys.pullRequestPreview(3, 7));
    expect(githubKeys.pullRequestDetail(3, 7).startsWith(githubKeys.pullRequestLists(3))).toBe(false);
  });
});
