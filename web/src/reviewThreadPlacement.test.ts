import { expect, it } from "vitest";
import type { PullRequestReviewThread } from "./bindings";
import { threadLine } from "./reviewThreadPlacement";

const thread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
  id: "t1",
  path: "src/app.rs",
  line: 2,
  originalLine: 2,
  side: "new",
  resolved: false,
  outdated: false,
  diffHunk: "@@ -1,2 +1,3 @@\n fn main() {\n+    run();\n",
  comments: [{ author: "alice", body: "This needs a guard.", createdAt: "2026-01-01T00:00:00Z" }],
  ...overrides,
});

it("prefers the current line, then the line the thread was written on", () => {
  expect(threadLine(thread())).toBe(2);
  expect(threadLine(thread({ line: null, originalLine: 7 }))).toBe(7);
  expect(threadLine(thread({ line: null, originalLine: null }))).toBeNull();
});
