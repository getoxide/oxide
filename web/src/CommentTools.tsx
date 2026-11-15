import { PencilIcon, SyncIcon, TrashIcon } from "@primer/octicons-react";
import { useState } from "react";
import { commands } from "./bindings";
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

  if (step !== "idle") {
    return (
      <span className="comment-tools" role="group" aria-label="Delete this comment?">
        <span className="comment-tools-ask">Delete?</span>
        <button type="button" className="danger" disabled={step === "deleting"} onClick={() => void remove()}>
          {step === "deleting" ? <><SyncIcon size={12} className="spin" /> Deleting…</> : "Delete"}
        </button>
        <button type="button" disabled={step === "deleting"} onClick={() => setStep("idle")}>Cancel</button>
      </span>
    );
  }
  return (
    <span className="comment-tools" role="group" aria-label="Comment actions">
      <button type="button" className="icon-btn sm" title="Edit comment" aria-label="Edit comment" onClick={onEdit}>
        <PencilIcon size={14} />
      </button>
      <button type="button" className="icon-btn sm" title="Delete comment" aria-label="Delete comment" onClick={() => setStep("confirm")}>
        <TrashIcon size={14} />
      </button>
    </span>
  );
}

/** The comment's text as an editor with Save and Cancel, in place of its rendered body. */
export function CommentEditForm({ projectId, id, initial, onSaved, onCancel, onError }: {
  projectId: number;
  id: string;
  initial: string;
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
