import { SmileyIcon } from "@primer/octicons-react";
import { createContext, useContext, useRef, useState } from "react";
import { commands, type ReactionContent, type ReactionGroup, type TimelineItem } from "../bindings";
import { Popover } from "./Popover";

/** GitHub's eight reactions, in the order its picker shows them. */
export const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] = [
  { content: "thumbsUp", emoji: "👍", label: "Thumbs up" },
  { content: "thumbsDown", emoji: "👎", label: "Thumbs down" },
  { content: "laugh", emoji: "😄", label: "Laugh" },
  { content: "hooray", emoji: "🎉", label: "Hooray" },
  { content: "confused", emoji: "😕", label: "Confused" },
  { content: "heart", emoji: "❤️", label: "Heart" },
  { content: "rocket", emoji: "🚀", label: "Rocket" },
  { content: "eyes", emoji: "👀", label: "Eyes" },
];

const ORDER = new Map(REACTIONS.map((r, i) => [r.content, i]));

/** `groups` with the viewer's `content` reaction added or removed; empty groups are dropped. */
export function toggled(groups: ReactionGroup[], content: ReactionContent, add: boolean): ReactionGroup[] {
  const found = groups.some((g) => g.content === content);
  const next = found ? groups : [...groups, { content, count: 0, viewerHasReacted: false }];
  return next
    .map((g) => (g.content !== content || g.viewerHasReacted === add ? g : { ...g, viewerHasReacted: add, count: g.count + (add ? 1 : -1) }))
    .filter((g) => g.count > 0)
    .sort((a, b) => (ORDER.get(a.content) ?? 0) - (ORDER.get(b.content) ?? 0));
}

/** `detail` with the viewer's `content` reaction added to or removed from `subjectId`: the
 *  description when it is the detail's own node, else the comment or review with that id. */
export function withReaction<T extends { nodeId: string; reactions: ReactionGroup[]; timeline: TimelineItem[] }>(
  detail: T,
  subjectId: string,
  content: ReactionContent,
  add: boolean,
): T {
  return {
    ...detail,
    reactions: detail.nodeId === subjectId ? toggled(detail.reactions, content, add) : detail.reactions,
    timeline: detail.timeline.map((item) =>
      (item.kind === "comment" || item.kind === "review") && item.id === subjectId && item.reactions
        ? { ...item, reactions: toggled(item.reactions, content, add) }
        : item,
    ),
  };
}

/** Where a detail view keeps a reaction GitHub accepted, so its cached detail shows it too. */
export const ReactionsSaved = createContext<((subjectId: string, content: ReactionContent, add: boolean) => void) | null>(null);

/** `groups` with the toggles still on their way to GitHub applied over them. */
function withPending(groups: ReactionGroup[], pending: ReadonlyMap<ReactionContent, boolean>): ReactionGroup[] {
  return [...pending].reduce((current, [content, add]) => toggled(current, content, add), groups);
}

/** The reaction pills under a description, a comment or a review, and the picker to add one.
 *  A click shows the change at once and takes it back when GitHub refuses it. Without a
 *  `subjectId` (GitHub gave no node id) the counts are shown but cannot be changed. */
export function Reactions({ projectId, subjectId, reactions, onError }: {
  projectId: number;
  subjectId: string;
  reactions: ReactionGroup[];
  onError: (message: string) => void;
}) {
  const [groups, setGroups] = useState(reactions);
  const [pending, setPending] = useState<ReadonlyMap<ReactionContent, boolean>>(new Map());
  const [picking, setPicking] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const saved = useContext(ReactionsSaved);
  // A reload from GitHub is the truth again, except for the toggles it may not know of yet.
  const [loaded, setLoaded] = useState(reactions);
  if (loaded !== reactions) {
    setLoaded(reactions);
    setGroups(withPending(reactions, pending));
  }

  async function toggle(content: ReactionContent) {
    if (pending.has(content)) return;
    const adding = !groups.some((g) => g.content === content && g.viewerHasReacted);
    setGroups((current) => toggled(current, content, adding));
    setPending((p) => new Map(p).set(content, adding));
    const result = await commands.toggleReaction(projectId, subjectId, content, adding);
    setPending((p) => {
      const next = new Map(p);
      next.delete(content);
      return next;
    });
    if (result.status === "error") {
      setGroups((current) => toggled(current, content, !adding));
      onError(result.error.message);
    } else {
      saved?.(subjectId, content, adding);
    }
  }

  const editable = subjectId !== "";
  if (!editable && groups.length === 0) return null;
  return (
    <div className="reactions" role="group" aria-label="Reactions">
      {groups.map((g) => {
        const r = REACTIONS[ORDER.get(g.content) ?? 0];
        return (
          <button
            key={g.content}
            type="button"
            className={`reaction${g.viewerHasReacted ? " active" : ""}`}
            aria-pressed={g.viewerHasReacted}
            aria-label={`${r.label}: ${g.count}`}
            title={r.label}
            disabled={!editable}
            onClick={() => void toggle(g.content)}
          >
            {r.emoji}
            <span className="reaction-count">{g.count}</span>
          </button>
        );
      })}
      {editable && (
        <button
          ref={add}
          type="button"
          className="icon-btn sm reaction-add"
          aria-label="Add reaction"
          title="Add reaction"
          aria-haspopup="dialog"
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
        >
          <SmileyIcon size={14} />
        </button>
      )}
      {picking && (
        <Popover anchor={add} label="Add reaction" width={8 * 34 + 16} onClose={() => setPicking(false)}>
          <div className="reaction-picker">
            {REACTIONS.map((r) => {
              const mine = groups.some((g) => g.content === r.content && g.viewerHasReacted);
              return (
                <button
                  key={r.content}
                  type="button"
                  className={`reaction-option${mine ? " active" : ""}`}
                  aria-label={r.label}
                  aria-pressed={mine}
                  title={r.label}
                  onClick={() => {
                    setPicking(false);
                    void toggle(r.content);
                  }}
                >
                  {r.emoji}
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </div>
  );
}
