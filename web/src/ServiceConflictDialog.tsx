import { useEffect, useRef, useState } from "react";
import type { ProjectServiceConflict } from "./bindings";

export interface ServiceConflictDialogProps {
  conflict: ProjectServiceConflict;
  /** Switches to the incumbent Project Service's log tab. */
  onSwitch: (serviceId: number) => void;
  /** Restarts the incumbent; App opens it when it starts or keeps this dialog on a new conflict. */
  onRestart: (serviceId: number) => void | Promise<void>;
  onDismiss: () => void;
}

/** The sentence the dialog and the terminal notice share. */
export function serviceConflictMessage(conflict: ProjectServiceConflict): string {
  return conflict.message;
}

/**
 * A compact, accessible conflict notice. It never starts a second process: the user either
 * switches to the running service, restarts it, or dismisses the message.
 */
export function ServiceConflictDialog({ conflict, onSwitch, onRestart, onDismiss }: ServiceConflictDialogProps) {
  const [busy, setBusy] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const existing = conflict.existing;
  const message = serviceConflictMessage(conflict);

  useEffect(() => {
    primary.current?.focus();
  }, [conflict]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onDismiss]);

  const restart = async () => {
    if (!existing || busy) return;
    setBusy(true);
    try {
      await onRestart(existing.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onDismiss()}>
      <div
        className="modal service-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-conflict-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="service-conflict-title">Port already in use</h2>
        <p className="service-conflict-message">{message}</p>
        {existing ? (
          <p className="hint">
            Oxide is already running this service. Switch to it, or restart it to pick up your
            latest changes.
          </p>
        ) : (
          <p className="hint">Choose another port for this command, then try again.</p>
        )}
        <div className="modal-actions">
          {existing ? (
            <>
              <button ref={primary} className="btn" onClick={() => onSwitch(existing.id)}>
                Switch to active service
              </button>
              <button className="btn" onClick={() => void restart()} disabled={busy} aria-busy={busy}>
                {busy ? "Restarting…" : "Restart service"}
              </button>
              <button className="btn" onClick={onDismiss} disabled={busy}>
                Dismiss
              </button>
            </>
          ) : (
            <button ref={primary} className="btn" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
