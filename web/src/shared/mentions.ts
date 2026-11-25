import type { TimelineItem } from "../bindings";

/** The `@mention` being typed at the caret: where its `@` sits and the login typed so far. */
export interface MentionQuery {
  start: number;
  query: string;
}

/** A mention starts at the start of a line or after whitespace or punctuation, never inside a
 *  word, so `a@b.com` does not open the list. */
const TYPING = /(?:^|[^\w.+\-@/`])@([A-Za-z0-9-]{0,39})$/;

export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const m = TYPING.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** The candidates whose login contains `query`, case-insensitively, in their given order. */
export function filterMentions(candidates: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  return candidates.filter((login) => login.toLowerCase().includes(q)).slice(0, limit);
}

/** One list from several, in order, without empty entries or case-insensitive duplicates. */
export function mergeMentions(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const login of lists.flat()) {
    const key = login.toLowerCase();
    if (!login || seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

/** The people of an issue or pull request, most involved first: its author, assignees and
 *  reviewers, whoever wrote or acted in its timeline, then GitHub's own participant list. The
 *  viewer is left out: nobody mentions themselves. */
export function conversationPeople(conversation: {
  author: string;
  assignees: readonly string[];
  reviewers?: readonly { login: string }[];
  timeline: readonly TimelineItem[];
  participants: readonly string[];
  viewer: string;
}): string[] {
  const actors = conversation.timeline.flatMap((item) => {
    if ("actor" in item) return "login" in item ? [item.actor, item.login] : [item.actor];
    return [item.author];
  });
  const viewer = conversation.viewer.toLowerCase();
  return mergeMentions(
    [conversation.author],
    conversation.assignees,
    (conversation.reviewers ?? []).map((r) => r.login),
    actors,
    conversation.participants,
  ).filter((login) => login.toLowerCase() !== viewer);
}
