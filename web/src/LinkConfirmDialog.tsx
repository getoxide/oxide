import { useEffect, useSyncExternalStore } from "react";
import { answerLinkConfirmation, currentLinkConfirmation, subscribeLinkConfirmation } from "./externalLink";

/** Asks before a link from repository content opens a host that is not GitHub. */
export function LinkConfirmDialog() {
  const link = useSyncExternalStore(subscribeLinkConfirmation, currentLinkConfirmation);
  useEffect(() => {
    if (!link) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answerLinkConfirmation(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [link]);
  if (!link) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="link-confirm-title">
        <h2 id="link-confirm-title">Open a link outside GitHub?</h2>
        <p>
          This link goes to <strong>{link.host}</strong>. Open it in your browser only if you trust that site.
        </p>
        <p className="muted" style={{ wordBreak: "break-all" }}>{link.url}</p>
        <div className="modal-actions">
          <button autoFocus onClick={() => answerLinkConfirmation(false)}>Cancel</button>
          <button className="primary" onClick={() => answerLinkConfirmation(true)}>Open {link.host}</button>
        </div>
      </div>
    </div>
  );
}
