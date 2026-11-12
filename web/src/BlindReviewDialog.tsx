import { useEffect, useState } from "react";
import { commands, type BlindReviewProviderOption, type Thread } from "./bindings";

interface Props {
  projectId: number;
  threadId: number;
  /** The provider of the reviewed Thread, used to mark 'same provider'. */
  threadProvider?: string;
  /** Optional issue description or reference. */
  threadIssue?: string | null;
  onClose: () => void;
  onStarted: (thread: Thread) => void;
}

/** Reviews the Thread's changes with a fresh provider, in a separate Thread and detached worktree. */
export function BlindReviewDialog({ projectId, threadId, threadProvider, threadIssue, onClose, onStarted }: Props) {
  const [providers, setProviders] = useState<BlindReviewProviderOption[] | null>(null);
  const [provider, setProvider] = useState("");
  const [scope, setScope] = useState<"uncommitted" | "branch">("branch");
  const [issue, setIssue] = useState(threadIssue ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void commands.blindReviewProviders(threadProvider ?? null).then((result) => {
      if (!live) return;
      if (result.status === "error") return setError(result.error.message);
      setProviders(result.data);
      if (result.data.length > 0) setProvider(result.data[0].provider);
    });
    return () => { live = false; };
  }, [threadProvider]);

  async function run() {
    setStarting(true);
    setError(null);
    const result = await commands.startBlindReview({
      projectId, threadId, provider, scope, turnIndex: null, issue: issue.trim() || null,
    });
    setStarting(false);
    if (result.status === "error") return setError(result.error.message);
    onStarted(result.data);
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Blind review"
        onKeyDown={(e) => { if (e.key === "Escape" && !starting) onClose(); }}
      >
        <h2>Blind review</h2>
        <p className="hint">
          Review changes with a fresh provider in a separate thread and detached worktree. The review prompt only includes the diff, issue, and structured format—no transcript history is shared.
        </p>
        {providers === null && !error ? (
          <p>Loading available providers…</p>
        ) : providers !== null && providers.length === 0 ? (
          <p className="error" role="alert">No provider is available that can honour a non-writing configuration.</p>
        ) : (
          <div className="blind-review-fields">
            <label>
              <span>Provider</span>
              <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={starting}>
                {(providers ?? []).map((p) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
              </select>
            </label>
            <label>
              <span>Changes to review</span>
              <select aria-label="Changes to review" value={scope} onChange={(e) => setScope(e.target.value as "uncommitted" | "branch")} disabled={starting}>
                <option value="branch">The whole branch</option>
                <option value="uncommitted">Uncommitted changes</option>
              </select>
            </label>
            <label>
              <span>Issue reference or description (optional)</span>
              <input type="text" aria-label="Issue" placeholder="e.g. #123 or issue description"
                value={issue} onChange={(e) => setIssue(e.target.value)} disabled={starting} />
            </label>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={starting}>Cancel</button>
          <button type="button" className="btn primary" disabled={starting || !provider} onClick={() => void run()}>
            {starting ? "Starting…" : "Start Blind review"}
          </button>
        </div>
      </div>
    </div>
  );
}
