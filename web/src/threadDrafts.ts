/** Key used when no thread has been created yet. */
const DRAFT_KEY = 0;

export function getDraft(drafts: Record<number, string>, threadId: number | null): string {
  const key = threadId ?? DRAFT_KEY;
  return drafts[key] ?? "";
}

export function setDraft(
  drafts: Record<number, string>,
  threadId: number | null,
  text: string
): Record<number, string> {
  const key = threadId ?? DRAFT_KEY;
  if (drafts[key] === text) return drafts;
  return { ...drafts, [key]: text };
}

/**
 * Whether a Thread is still a clean slate that "new Thread" may reopen: no Turn recorded,
 * nothing typed in its composer, and no Turn running. A prompt just sent has no Turn on
 * record until the first output arrives, so the status and the draft count as use too.
 */
export function isUnusedThread(
  thread: { id: number; status: string },
  turnCount: number,
  drafts: Record<number, string>,
): boolean {
  return turnCount === 0 && thread.status !== "working" && getDraft(drafts, thread.id).trim() === "";
}

