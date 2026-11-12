import { useEffect, useState } from "react";
import { commands, type PendingRestore, type RestoreChange, type RestorePreview, type TurnPick } from "./bindings";

const CHANGE_LABEL: Record<RestoreChange, string> = {
  rewritten: "goes back to how it was",
  reinstated: "comes back",
  removed: "is deleted",
};

/** How a Turn is named: its position and the start of its prompt. */
function turnLabel(turn: { turnIndex: number; prompt: string }): string {
  const prompt = turn.prompt.replace(/\s+/g, " ").trim();
  return `Turn ${turn.turnIndex + 1} · ${prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt}`;
}

interface Props {
  threadId: number;
  onClose: () => void;
  /** Called after a restore or its undo: the files changed and the Transcript records it. */
  onRestored: () => void;
}

/** Puts a Thread's files back to how they were before a Turn, asking first and naming the files. */
export function RestoreDialog({ threadId, onClose, onRestored }: Props) {
  const [turns, setTurns] = useState<TurnPick[] | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void commands.listTurnPicks(threadId).then((result) => {
      if (!live) return;
      if (result.status === "error") setError(result.error.message);
      else setTurns(result.data.filter((turn) => turn.checkpointed));
    });
    void commands.pendingRestore(threadId).then((result) => {
      if (live && result.status === "ok") setPending(result.data);
    });
    return () => { live = false; };
  }, [threadId]);

  async function ask(turnIndex: number) {
    setError(null);
    const result = await commands.restorePreview(threadId, turnIndex);
    if (result.status === "error") return setError(result.error.message);
    setPreview(result.data);
  }

  async function finish(run: () => Promise<{ status: "ok" } | { status: "error"; error: { message: string } }>) {
    setBusy(true);
    const result = await run();
    setBusy(false);
    if (result.status === "error") return setError(result.error.message);
    onRestored();
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Restore files"
        onKeyDown={(e) => { if (e.key === "Escape" && !busy) onClose(); }}
      >
        <h2>Restore files</h2>
        {preview ? (
          <div className="restore-confirm" role="alertdialog" aria-label="Confirm restore">
            <span>Put the files back to how they were before Turn {preview.turnIndex + 1}?</span>
            {preview.files.length === 0 ? (
              <span>No file stands between the checkout and that Turn.</span>
            ) : (
              <ul>
                {preview.files.map((file) => (
                  <li key={file.path}><span className="mono">{file.path}</span> {CHANGE_LABEL[file.change]}</li>
                ))}
              </ul>
            )}
            <div className="restore-actions">
              <button type="button" className="btn primary" disabled={busy}
                onClick={() => void finish(() => commands.restoreTurn(threadId, preview.turnIndex))}>
                Restore
              </button>
              <button type="button" className="btn" onClick={() => setPreview(null)}>Back</button>
            </div>
          </div>
        ) : (
          <>
            {turns === null && !error && <p>Loading Turns…</p>}
            {turns !== null && turns.length === 0 && <p>No Turn of this Thread has a Checkpoint to restore.</p>}
            {turns !== null && turns.length > 0 && (
              <ul className="restore-turns" aria-label="Turns">
                {turns.map((turn) => (
                  <li key={turn.turnIndex}>
                    <button type="button" className="btn" onClick={() => void ask(turn.turnIndex)}>
                      Restore to before {turnLabel(turn)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pending && (
              <button type="button" className="btn" disabled={busy}
                onClick={() => void finish(() => commands.undoRestore(threadId))}>
                Undo the last restore
              </button>
            )}
          </>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </div>
  );
}
