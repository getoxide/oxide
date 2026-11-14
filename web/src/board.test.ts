import { describe, expect, it } from "vitest";
import type { BoardCard, Thread } from "./bindings";
import { applyBoardEvent, mergeCard } from "./board";

const card = (id: number, over: Partial<Thread> = {}): BoardCard =>
  ({
    thread: { id, status: "completed", title: `T${id}`, updatedAt: `2026-01-01T00:00:0${id}Z`, ...over },
    pendingApprovals: [],
  }) as BoardCard;

describe("mergeCard", () => {
  it("adds a new card and replaces an older one", () => {
    const start = [card(1)];
    const added = mergeCard(start, card(2));
    expect(added.map((c) => c.thread.id)).toEqual([1, 2]);
    const updated = mergeCard(added, card(1, { status: "working", updatedAt: "2026-01-02T00:00:00Z" }));
    expect(updated[0].thread.status).toBe("working");
  });
});

describe("applyBoardEvent", () => {
  it("drops the card of a deleted Thread", () => {
    const next = applyBoardEvent([card(1), card(2)], { type: "ThreadDeleted", payload: 1 });
    expect(next.map((c) => c.thread.id)).toEqual([2]);
  });

  it("replaces a changed card and adds a new one", () => {
    const start = [card(1), card(2)];
    const changed = applyBoardEvent(start, { type: "ThreadChanged", payload: card(1, { status: "working" }) });
    expect(changed.map((c) => c.thread.status)).toEqual(["working", "completed"]);
    const added = applyBoardEvent(changed, { type: "ThreadChanged", payload: card(3) });
    expect(added.map((c) => c.thread.id)).toEqual([1, 2, 3]);
  });

  it("ignores a card older than the one held", () => {
    const start = [card(1, { status: "working", updatedAt: "2026-01-02T00:00:00Z" })];
    const next = applyBoardEvent(start, { type: "ThreadChanged", payload: card(1, { updatedAt: "2026-01-01T00:00:00Z" }) });
    expect(next[0].thread.status).toBe("working");
  });
});
