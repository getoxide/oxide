import { useState } from "react";
import { CommentIcon, PaperAirplaneIcon } from "@primer/octicons-react";
import { commands, type LineComment } from "./bindings";
import { DeliveryDialog } from "./DeliveryDialog";
import { LineCommentList } from "./LineCommentList";
import { invalidateQueries, useQuery, type QueryResult } from "./queryCache";

/** Cache prefix of a Project's draft lists, so adding a comment elsewhere refreshes this one. */
export const commentsPrefix = (projectId: number) => `p${projectId}:comments:`;

interface Props {
  projectId: number;
  threadId: number;
  /** The Thread is running a Turn: drafts can be written but not sent. */
  working: boolean;
  /** The agent waits for an answer (an Approval): nothing can be pasted until it is answered. */
  needsInput?: boolean;
  /** Changes when the Thread or the checkout does, so outdated flags stay current. */
  refreshKey: string;
}

/** The Thread's draft Line comments, with edit, delete and one Send for all of them. */
export function LineComments({ projectId, threadId, working, needsInput = false, refreshKey }: Props) {
  const query = useQuery(
    `${commentsPrefix(projectId)}${threadId}`,
    async (): Promise<QueryResult<LineComment[]>> => commands.listLineComments(threadId),
    refreshKey,
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** The prompt the user is asked to confirm before it reaches the agent. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const comments = query.state === "ready" ? (query.data ?? []) : [];
  if (comments.length === 0) return null;

  const refresh = () => invalidateQueries(commentsPrefix(projectId));
  async function run(action: () => Promise<{ status: "ok" } | { status: "error"; error: { message: string } }>) {
    setError(null);
    const result = await action();
    if (result.status === "error") setError(result.error.message);
    else refresh();
    return result.status === "ok";
  }
  /** Builds the prompt and shows it; nothing is delivered until the user confirms. */
  async function review() {
    setSending(true);
    setError(null);
    const result = await commands.lineCommentsPrompt(threadId);
    setSending(false);
    if (result.status === "error") setError(result.error.message);
    else setConfirming(result.data);
  }
  async function deliver(prompt: string) {
    const result = await commands.sendLineComments(threadId, prompt);
    if (result.status === "error") throw new Error(result.error.message);
    setConfirming(null);
    refresh();
  }
  const outdated = comments.filter((c) => c.outdated).length;

  return (
    <section className="line-comments" aria-label="Line comments">
      <header className="line-comments-head">
        <CommentIcon size={14} />
        <strong>
          {comments.length} draft comment{comments.length === 1 ? "" : "s"}
        </strong>
        {outdated > 0 && <span className="chip warn">{outdated} outdated</span>}
        <span className="grow" />
        <button
          type="button"
          className={`btn primary sm${sending ? " pending" : ""}`}
          disabled={working || sending}
          title={working ? "Send when the Thread has finished its Turn" : "Send every draft to the Thread in one message"}
          onClick={() => void review()}
        >
          <PaperAirplaneIcon size={14} /> Send to Thread
        </button>
      </header>
      {working && <div className="surface-note">The Thread is working. Drafts are kept; send them when it finishes.</div>}
      <LineCommentList
        comments={comments}
        edit={(id, body) => run(() => commands.editLineComment(id, body))}
        remove={(id) => run(() => commands.deleteLineComment(id))}
      />
      {confirming !== null && (
        <DeliveryDialog
          title="Send comments to the Thread"
          prompt={confirming}
          destination="paste"
          blocked={needsInput ? "The agent is waiting for an answer. Answer it in the terminal first." : null}
          confirmLabel="Send to Thread"
          onConfirm={() => deliver(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
