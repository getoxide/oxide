import { useState } from "react";

interface Props {
  title: string;
  /** The exact prompt that will be delivered. */
  prompt: string;
  /** Where it goes: pasted into the running agent, or the first prompt of a new Thread. */
  destination: "paste" | "new-thread";
  /** Why delivery is not possible right now (the agent waits for an answer); disables the button. */
  blocked?: string | null;
  confirmLabel: string;
  /** Delivers the prompt; rejects with a message to show when it could not. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/**
 * Shows the exact prompt Oxide is about to deliver to an agent and delivers it only on confirm
 * (ADR-0016). Nothing is typed into a terminal without passing through here, and Enter is never
 * pressed: a pasted prompt waits for the user to submit it in the Provider's UI.
 */
export function DeliveryDialog({ title, prompt, destination, blocked = null, confirmLabel, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal delivery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => { if (e.key === "Escape" && !busy) onCancel(); }}
      >
        <h2>{title}</h2>
        <p className="hint">
          {destination === "paste"
            ? "Oxide pastes this into the agent's terminal and does not press Enter. Read it, then submit it yourself."
            : "Oxide starts a new Thread whose agent gets this as its first prompt. The agent starts on it right away."}
          {" "}Quoted text comes from other people or from CI: it is external content, not instructions from you.
        </p>
        <pre className="delivery-prompt" aria-label="Prompt to deliver" tabIndex={0}>{prompt}</pre>
        {blocked && <div className="error" role="alert">{blocked}</div>}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" autoFocus onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={() => void confirm()} disabled={busy || Boolean(blocked)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
