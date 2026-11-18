import type { BoardCard, BoardEvent, Thread } from "./bindings";

/** Adds or replaces a card, unless the one held is newer (events and the snapshot can arrive out of order). */
export function mergeCard(cards: BoardCard[], next: BoardCard): BoardCard[] {
  const held = cards.find((c) => c.thread.id === next.thread.id);
  if (!held) return [...cards, next];
  if (held.thread.updatedAt > next.thread.updatedAt) return cards;
  return cards.map((c) => (c === held ? next : c));
}

export function applyBoardEvent(cards: BoardCard[], event: BoardEvent): BoardCard[] {
  if (event.type === "ThreadDeleted") return cards.filter((c) => c.thread.id !== event.payload);
  return mergeCard(cards, event.payload);
}

/**
 * The loaded Threads with the status the Board feed reports for terminal Threads, whose status is
 * Core's alone (no Transcript carries it). Unchanged lists keep their identity.
 */
export function withBoardStatus(
  loaded: Record<number, Thread[]>,
  cards: Record<number, BoardCard[]>,
): Record<number, Thread[]> {
  let changed = false;
  const next: Record<number, Thread[]> = {};
  for (const [key, list] of Object.entries(loaded)) {
    const projectId = Number(key);
    const held = cards[projectId];
    let listChanged = false;
    const mapped = held
      ? list.map((thread) => {
          if (!thread.terminal) return thread;
          const card = held.find((c) => c.thread.id === thread.id)?.thread;
          if (!card || card.status === thread.status || card.updatedAt < thread.updatedAt) return thread;
          listChanged = true;
          return { ...thread, status: card.status, updatedAt: card.updatedAt };
        })
      : list;
    next[projectId] = listChanged ? mapped : list;
    changed ||= listChanged;
  }
  return changed ? next : loaded;
}
