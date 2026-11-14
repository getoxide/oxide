import type { BoardCard, BoardEvent } from "./bindings";

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
