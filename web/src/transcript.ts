import type {
  ApprovalDecision,
  ApprovalSnapshot,
  CommandRecord,
  ItemSnapshot,
  PermissionMode,
  SequencedThreadEvent,
  Thread,
  ThreadCapabilities,
  ThreadSnapshot,
  ThreadStatus,
  TurnSnapshot,
} from "./bindings";

/** A Turn as shown: the stored snapshot plus the live Provider retry notice, if any. */
export type TranscriptTurn = TurnSnapshot & { retryNotice?: string | null };

/**
 * The live tail of a Thread: `turns` are the Turns at positions
 * `turnOffset..turnOffset + turns.length`, which always runs to the newest
 * Turn. Older Turns are paged in separately (see `transcriptPages.ts`).
 */
export interface TranscriptState {
  thread: Thread | null;
  status: ThreadStatus;
  turns: TranscriptTurn[];
  turnOffset: number;
  capabilities: ThreadCapabilities;
  lastSeq: number;
  supportedPermissionModes: PermissionMode[];
}

/** The error Core reports when a Thread's Provider session can no longer be resumed. */
export const SESSION_LOST_MESSAGE = "Provider session no longer available";

/** A Turn is running (working, or waiting on an Approval), so Stop applies. */
export function turnIsRunning(status: ThreadStatus): boolean {
  return status === "working" || status === "needs-input";
}

const NO_CAPABILITIES: ThreadCapabilities = { reasoningText: false };

/** No command was reported for an Item; its outcome is unknown, never guessed. */
const NO_COMMAND: CommandRecord = { line: null, outcome: "unknown", exitCode: null };

export function initialTranscriptState(snapshot: ThreadSnapshot | null): TranscriptState {
  if (!snapshot) {
    return {
      thread: null,
      status: "completed",
      turns: [],
      turnOffset: 0,
      capabilities: NO_CAPABILITIES,
      lastSeq: 0,
      supportedPermissionModes: ["ask", "auto-edit", "full-access"],
    };
  }
  return {
    thread: snapshot.thread,
    status: snapshot.thread.status,
    turns: snapshot.turns.map((t) => ({ ...t, approvals: t.approvals || [] })),
    turnOffset: snapshot.turnOffset,
    capabilities: snapshot.capabilities,
    lastSeq: snapshot.lastSeq,
    supportedPermissionModes: snapshot.supportedPermissionModes || ["ask", "auto-edit", "full-access"],
  };
}

function updateLastTurnItem(
  turns: TranscriptTurn[],
  itemIndex: number,
  updater: (existing: ItemSnapshot | undefined) => ItemSnapshot
): void {
  if (turns.length === 0) return;
  const lastTurnIndex = turns.length - 1;
  const turn = { ...turns[lastTurnIndex] };
  const items = [...turn.items];
  const idx = items.findIndex((i) => i.itemIndex === itemIndex);
  const existing = idx >= 0 ? items[idx] : undefined;
  const updated = updater(existing);
  if (idx >= 0) {
    items[idx] = updated;
  } else {
    items.push(updated);
  }
  turn.items = items;
  turns[lastTurnIndex] = turn;
}

export function applyThreadEvent(
  state: TranscriptState,
  sequenced: SequencedThreadEvent
): TranscriptState {
  if (sequenced.seq <= state.lastSeq) {
    return state;
  }

  const { event } = sequenced;
  const turns = [...state.turns];
  let status = state.status;
  const thread = state.thread ? { ...state.thread } : null;
  let sessionLost = state.thread?.sessionLost ?? false;

  switch (event.type) {
    case "TurnStarted": {
      // Always a new Turn: Providers may repeat turn indexes across sessions,
      // and replays are already dropped by `seq`.
      status = "working";
      turns.push({
        id: 0,
        turnIndex: event.payload.turn_index,
        prompt: event.payload.prompt,
        model: event.payload.model ?? null,
        effort: event.payload.effort ?? null,
        permissionMode: event.payload.permission_mode ?? null,
        segments: event.payload.segments,
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        items: [],
        error: null,
        retryNotice: null,
        approvals: [],
        unknownEvents: [],
      });
      break;
    }

    case "ItemStarted": {
      updateLastTurnItem(turns, event.payload.item_index, (existing) => ({
        id: existing ? existing.id : 0,
        itemIndex: event.payload.item_index,
        kind: event.payload.kind,
        content: existing ? existing.content : "",
        parentItemIndex: event.payload.parent_item_index ?? null,
        category: event.payload.category ?? null,
        command: existing ? existing.command : NO_COMMAND,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }));
      break;
    }

    case "ItemDeltaBatch": {
      updateLastTurnItem(turns, event.payload.item_index, (existing) => ({
        id: existing ? existing.id : 0,
        itemIndex: event.payload.item_index,
        kind: existing ? existing.kind : "agent_message",
        content: (existing ? existing.content : "") + event.payload.delta,
        parentItemIndex: existing ? existing.parentItemIndex : null,
        category: existing ? (existing.category ?? null) : null,
        command: existing ? existing.command : NO_COMMAND,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }));
      break;
    }

    case "ItemCompleted": {
      updateLastTurnItem(turns, event.payload.item_index, (existing) => ({
        id: existing ? existing.id : 0,
        itemIndex: event.payload.item_index,
        kind: event.payload.kind,
        content: event.payload.content,
        parentItemIndex: event.payload.parent_item_index ?? null,
        category: event.payload.category ?? null,
        command: event.payload.command ?? NO_COMMAND,
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      }));
      break;
    }

    case "TurnCompleted": {
      // Only the newest Turn can be running.
      const idx = turns.length - 1;
      if (idx >= 0) {
        const turn = { ...turns[idx] };
        const approvals = (turn.approvals || []).map((app) =>
          app.decision ? app : { ...app, decision: "deny" as ApprovalDecision, decidedAt: new Date().toISOString() }
        );
        turns[idx] = {
          ...turn,
          status: event.payload.status,
          completedAt: new Date().toISOString(),
          error: event.payload.error ?? null,
          retryNotice: null,
          approvals,
        };
      }
      break;
    }

    case "ProviderRetrying": {
      const last = turns.length - 1;
      if (last >= 0) {
        turns[last] = { ...turns[last], retryNotice: event.payload.message };
      }
      break;
    }

    case "ThreadStatusChanged": {
      status = event.payload.status;
      break;
    }

    case "ThreadRenamed": {
      if (thread) {
        thread.title = event.payload.title;
      }
      break;
    }

    case "ApprovalRequested": {
      status = "needs-input";
      if (turns.length > 0) {
        const lastTurnIndex = turns.length - 1;
        const turn = { ...turns[lastTurnIndex] };
        const approvals = [...(turn.approvals || [])];
        const newApproval: ApprovalSnapshot = {
          id: 0,
          turnId: turn.id,
          approvalId: event.payload.id,
          kind: event.payload.kind,
          summary: event.payload.summary,
          options: event.payload.options || [],
          decision: null,
          createdAt: new Date().toISOString(),
          decidedAt: null,
        };
        approvals.push(newApproval);
        turn.approvals = approvals;
        turns[lastTurnIndex] = turn;
      }
      break;
    }

    case "ApprovalResponded": {
      let hasPending = false;
      for (let tIdx = turns.length - 1; tIdx >= 0; tIdx--) {
        const turn = { ...turns[tIdx] };
        let modified = false;
        const approvals = (turn.approvals || []).map((app) => {
          if (app.approvalId === event.payload.id) {
            modified = true;
            return {
              ...app,
              decision: event.payload.decision,
              decidedAt: event.payload.decided_at,
            };
          }
          if (!app.decision) {
            hasPending = true;
          }
          return app;
        });
        if (modified) {
          turn.approvals = approvals;
          turns[tIdx] = turn;
        }
      }
      if (!hasPending && status === "needs-input") {
        status = "working";
      }
      break;
    }

    case "Error": {
      status = "error";
      sessionLost ||= event.payload.message === SESSION_LOST_MESSAGE;
      break;
    }

    case "SlashCommandsChanged":
    case "Unknown": {
      break;
    }
  }

  if (thread) {
    thread.status = status;
    thread.sessionLost = sessionLost;
  }

  return {
    thread,
    status,
    turns,
    turnOffset: state.turnOffset,
    capabilities: state.capabilities,
    lastSeq: sequenced.seq,
    supportedPermissionModes: state.supportedPermissionModes,
  };
}

function estimateTurnBytes(turn: TranscriptTurn): number {
  let bytes = 256 + (turn.prompt?.length ?? 0) * 2 + (turn.retryNotice?.length ?? 0) * 2;
  if (turn.segments) {
    for (const seg of turn.segments) {
      bytes += seg.kind === "text"
        ? (seg.text?.length ?? 0) * 2
        : 128 + ((seg.name?.length ?? 0) + (seg.path?.length ?? 0)) * 2;
    }
  }
  if (turn.items) {
    for (const item of turn.items) {
      bytes += 128 + (item.content?.length ?? 0) * 2 + (item.command?.line?.length ?? 0) * 2;
    }
  }
  if (turn.error) {
    bytes += 64 + (turn.error.message?.length ?? 0) * 2 + (turn.error.stderrTail?.length ?? 0) * 2;
  }
  if (turn.approvals) {
    for (const approval of turn.approvals) {
      bytes += 128 + (approval.summary?.length ?? 0) * 2;
    }
  }
  if (turn.unknownEvents) {
    bytes += turn.unknownEvents.length * 128;
  }
  return bytes;
}

/** Arithmetic UTF-16 memory estimate for a cached Thread transcript and its paged turns. */
export function estimateTranscriptViewBytes(
  transcript: TranscriptState,
  pages: ReadonlyMap<number, TurnSnapshot[]>,
): number {
  let bytes = 512 + (transcript.thread?.title?.length ?? 0) * 2;
  for (const turn of transcript.turns) {
    bytes += estimateTurnBytes(turn);
  }
  for (const page of pages.values()) {
    for (const turn of page) {
      bytes += estimateTurnBytes(turn);
    }
  }
  return bytes;
}
