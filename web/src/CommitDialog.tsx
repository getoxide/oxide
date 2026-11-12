import { useEffect, useState } from "react";
import { GitCommitIcon, RepoPushIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type DiffFile } from "./bindings";
import { commitPaths } from "./gitAction";
import { shortcutLabel } from "./shortcuts";
import type { usePushFlow } from "./usePushFlow";

interface Props {
  projectId: number;
  threadId: number;
  push: ReturnType<typeof usePushFlow>;
  onClose: () => void;
  /** Called after a commit, so Git views reload. */
  onCommitted: () => void;
}

/** Commits the checkout's uncommitted files, optionally pushing right after. */
export function CommitDialog({ projectId, threadId, push, onClose, onCommitted }: Props) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let live = true;
    void commands.gitDiff(projectId, threadId, "uncommitted").then((result) => {
      if (!live) return;
      if (result.status === "error") setError(result.error.message);
      else setFiles(result.data.files);
    });
    return () => { live = false; };
  }, [projectId, threadId]);

  const selected = commitPaths(files ?? [], unchecked);
  const ready = selected.length > 0 && message.trim() !== "" && !committing && !push.busy;
  const commit = () => commands.commit(projectId, threadId, selected, message);

  async function run(andPush: boolean) {
    setError(null);
    if (andPush) {
      // The message is kept if the commit or push fails.
      await push.start(commit);
      onCommitted();
      onClose();
      return;
    }
    setCommitting(true);
    const result = await commit();
    setCommitting(false);
    if (result.status === "error") return setError(result.error.message);
    onCommitted();
    onClose();
  }

  const toggle = (path: string, checked: boolean) =>
    setUnchecked((previous) => {
      const next = new Set(previous);
      if (checked) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="modal-backdrop">
      <form
        className="modal commit-form"
        role="dialog"
        aria-modal="true"
        aria-label="Commit"
        onKeyDown={(e) => { if (e.key === "Escape" && !committing && !push.busy) onClose(); }}
        onSubmit={(e) => { e.preventDefault(); if (ready) void run(false); }}
      >
        <h2>Commit</h2>
        {files === null && !error && <p>Loading changes…</p>}
        {files !== null && files.length === 0 && <p>No changes to commit.</p>}
        {files !== null && files.length > 0 && (
          <ul className="diff-files" aria-label="Changed files">
            {files.map((file) => (
              <li key={file.path} className="diff-file-row">
                <input
                  type="checkbox"
                  aria-label={`Include ${file.path} in the commit`}
                  checked={!unchecked.has(file.path)}
                  onChange={(e) => toggle(file.path, e.target.checked)}
                />
                <span className="diff-file-name">{file.path}</span>
                <span className="diff-counts">
                  <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          autoFocus
          aria-label="Commit message"
          placeholder="Commit message"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && ready) {
              e.preventDefault();
              void run(true);
            }
          }}
        />
        {(error ?? push.error) && <div className="error" role="alert">{error ?? push.error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={committing || push.busy}>Cancel</button>
          <button type="submit" className={`btn${committing ? " pending" : ""}`} disabled={!ready}>
            {committing ? <SyncIcon size={14} className="spin" /> : <GitCommitIcon size={14} />} Commit
          </button>
          <button
            type="button"
            className={`btn primary${push.busy ? " pending" : ""}`}
            disabled={!ready}
            onClick={() => void run(true)}
            title={`Commit & Push (${shortcutLabel}${shortcutLabel === "⌘" ? "↩" : "Enter"})`}
          >
            {push.busy ? <SyncIcon size={14} className="spin" /> : <RepoPushIcon size={14} />} Commit &amp; Push
          </button>
        </div>
      </form>
    </div>
  );
}
