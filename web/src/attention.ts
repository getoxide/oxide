import type { BoardCard } from "./bindings";

export type CardsByProject = Record<number, BoardCard[]>;
export type AttentionTarget = { kind: "approval" | "answer" | "recovery"; projectId: number; threadId: number; approvalId: string | null };
type AttentionReason =
  | { kind: "approval"; summary: string; approvalId: string }
  | { kind: "needs-input" }
  | { kind: "error" }
  | { kind: "interrupted" };

/** What one Card asks of the user, or `null` when it is not waiting: its reason and where a jump goes. */
export function attentionTargetOf(card: BoardCard): { reason: AttentionReason; kind: AttentionTarget["kind"] } | null {
  const { thread, pendingApprovals } = card;
  if (thread.status === "needs-input") {
    const approval = pendingApprovals[0];
    return approval
      ? { reason: { kind: "approval", summary: approval.summary, approvalId: approval.approvalId }, kind: "approval" }
      : { reason: { kind: "needs-input" }, kind: "answer" };
  }
  if (thread.status === "error" || thread.status === "interrupted") {
    return { reason: { kind: thread.status }, kind: "recovery" };
  }
  return null;
}

/**
 * Where the primary activation goes: the earliest pending Approval (by Thread activity, then lowest id),
 * else a needs-input Thread, else an error/interrupted one, each in `order` (sidebar) of Projects.
 * Core's pending Approval carries no request time, so Thread activity stands in for it.
 */
export function attentionTarget(cards: CardsByProject, order: number[]): AttentionTarget | null {
  const all = order.flatMap((projectId) => (cards[projectId] ?? []).flatMap((card) => {
    const request = attentionTargetOf(card);
    return request ? [{ projectId, card, request }] : [];
  }));
  const approvals = all.filter(({ request }) => request.kind === "approval")
    .sort((a, b) => a.card.thread.updatedAt.localeCompare(b.card.thread.updatedAt) || a.card.thread.id - b.card.thread.id);
  if (approvals[0]) {
    const { projectId, card, request } = approvals[0];
    return {
      kind: "approval",
      projectId,
      threadId: card.thread.id,
      approvalId: request.reason.kind === "approval" ? request.reason.approvalId : null,
    };
  }
  for (const kind of ["answer", "recovery"] as const) {
    const found = all.find(({ request }) => request.kind === kind);
    if (found) return { kind, projectId: found.projectId, threadId: found.card.thread.id, approvalId: null };
  }
  return null;
}
