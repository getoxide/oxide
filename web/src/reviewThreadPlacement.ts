import type { PullRequestReviewThread } from "./bindings";

/** The line the thread sits on now, or the one it was written on when GitHub dropped it. */
export function threadLine(thread: PullRequestReviewThread): number | null {
  return thread.line ?? thread.originalLine ?? null;
}
