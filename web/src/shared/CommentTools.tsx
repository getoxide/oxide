import { PencilIcon, SyncIcon, TrashIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { commands } from "../bindings";
import { MarkdownEditor } from "./MarkdownEditor";

type Step = "idle" | "confirm" | "deleting";

/** Edit and Delete for a comment you wrote, as GitHub offers them in the comment's header. */
export function CommentTools({ projectId, id, onEdit, onDeleted, onError }: {
  projectId: number;
  id: string;
  onEdit: () => void;
  /** The comment is gone on GitHub: reload the conversation. */
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>("idle");
  const trigger = useRef<HTMLButtonElement>(null);

  function cancel() {
    setStep("idle");
    trigger.current?.focus();
  }

  async function remove() {
    setStep("deleting");
    const result = await commands.deleteComment(projectId, id);
    if (result.status === "error") {
      onError(result.error.message);
      setStep("idle");
    } else {
      onDeleted();
    }
  }

  return (
    <span className="comment-tools" role="group" aria-label="Comment actions">
      <button type="button" className="icon-btn sm" title="Edit comment" aria-label="Edit comment" onClick={onEdit}>
        <PencilIcon size={14} />
      </button>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        title="Delete comment"
        aria-label="Delete comment"
        aria-haspopup="dialog"
        onClick={() => setStep("confirm")}
      >
        <TrashIcon size={14} />
      </button>
      {step !== "idle" && (
        <DeleteCommentDialog deleting={step === "deleting"} onCancel={cancel} onConfirm={() => void remove()} />
      )}
    </span>
  );
}

/** Keeps Tab and Shift+Tab among the enabled buttons of a modal: focus wraps around instead of
 *  leaving it for the page behind. */
function trapTab(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled)")];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const at = document.activeElement;
  if (!first) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey ? at === first || !event.currentTarget.contains(at) : at === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/** Asks before deleting, in a modal over the window so the comment's card cannot clip it. */
function DeleteCommentDialog({ deleting, onCancel, onConfirm }: {
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (deleting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [deleting, onCancel]);

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !deleting) onCancel();
      }}
    >
      <div
        className="modal comment-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="comment-delete-title"
        aria-describedby="comment-delete-text"
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <h2 id="comment-delete-title">Delete this comment?</h2>
        <p id="comment-delete-text">It is removed from GitHub for everyone. This cannot be undone.</p>
        <div className="modal-actions">
          <button type="button" autoFocus disabled={deleting} onClick={onCancel}>Cancel</button>
          <button type="button" className={`danger${deleting ? " pending" : ""}`} disabled={deleting} onClick={onConfirm}>
            {deleting ? <><SyncIcon size={14} className="spin" /> Deleting…</> : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The comment's text as an editor with Save and Cancel, in place of its rendered body. */
export function CommentEditForm({ projectId, id, initial, onSaved, onCancel, onError, mentions, onMentionOpen }: {
  projectId: number;
  id: string;
  initial: string;
  /** Logins offered after `@`, and the hook to fetch more of them. */
  mentions?: readonly string[];
  onMentionOpen?: () => void;
  onSaved: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!text.trim() || saving) return;
    setSaving(true);
    const result = await commands.editComment(projectId, id, text);
    setSaving(false);
    if (result.status === "error") onError(result.error.message);
    else onSaved();
  }

  return (
    <form
      className="comment-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <MarkdownEditor
        label="Edit comment"
        rows={4}
        value={text}
        onChange={setText}
        mentions={mentions}
        onMentionOpen={onMentionOpen}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="comment-edit-actions">
        <button type="button" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={saving || !text.trim() || text.trim() === initial.trim()}>
          {saving ? <><SyncIcon size={14} className="spin" /> Saving…</> : "Save"}
        </button>
      </div>
    </form>
  );
}
