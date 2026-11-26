import { Skeleton } from "../shared/Skeleton";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CommentIcon,
  MarkGithubIcon,
  PencilIcon,
} from "@primer/octicons-react";
import { useState } from "react";
import { Collapsible } from "../shared/Collapsible";
import { QUERY_STALE_MS, updateQuery, useQuery } from "../shared/queryCache";
import { githubKeys } from "../shared/githubQueries";
import { RefreshNotice } from "../shared/RefreshNotice";
import { CommentEditForm, CommentTools } from "../shared/CommentTools";
import {
  commands,
  type IssueCloseReason,
  type IssueDetail,
  type IssueEdit,
} from "../bindings";
import { openExternalLink } from "../shared/externalLink";
import { CopyLinkButton } from "../shared/CopyLinkButton";
import { Avatar } from "../shared/Avatar";
import { IssueStateIcon } from "./IssueStateIcon";
import { canSubmitComment, ISSUE_PHASE_LABEL, issuePhase, titleChanged } from "./issueView";
import { MarkdownEditor } from "../shared/MarkdownEditor";
import { conversationPeople, mergeMentions } from "../shared/mentions";
import { SplitButton, SplitMenu, SplitMenuItem } from "../shared/SplitButton";
import { Markdown, MarkdownImages } from "../pull-requests/PullRequestMarkdown";
import { Working } from "../pull-requests/PullRequestMerge";
import { ActivityRow, isConversationItem, MoreOnGithub } from "../pull-requests/PullRequestTimeline";
import { Reactions, ReactionsSaved, withReaction } from "../shared/Reactions";
import { AssignYourself, Field, LabelChip, Picker, useCandidates } from "../pull-requests/PullRequestPeople";
import { relativeTime } from "../shared/relativeTime";
import { shortcutLabel } from "../shared/platform";

interface IssueDetailViewProps {
  projectId: number;
  number: number;
  /** Changes when the user's own change should fetch the issue again. */
  refreshKey: number;
  /** Changes on the auto-refresh timer or focus: a soft ask that never overlaps a fetch in flight. */
  pollKey?: number;
  onBack: () => void;
  /** Called after the issue changed on GitHub, so the list reloads. */
  onChanged: () => void;
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; issue: IssueDetail };

/** The action in flight: its button keeps its colour and shows a spinner; the others wait. */
type Pending = "comment" | "close" | "reopen" | "edit";
type Result = { status: "ok" } | { status: "error"; error: { message: string } };

const NO_EDIT: IssueEdit = {
  title: null,
  body: null,
  addAssignees: [],
  removeAssignees: [],
  addLabels: [],
  removeLabels: [],
};

const REASONS: { reason: IssueCloseReason; title: string; help: string }[] = [
  { reason: "completed", title: "Close as completed", help: "Done, closed, fixed, resolved" },
  { reason: "notPlanned", title: "Close as not planned", help: "Won't fix, can't repro, duplicate, stale" },
];

// The pill colours are the pull request ones: completed reads like merged, not planned like draft.
const PILL = { open: "open", completed: "merged", notPlanned: "draft" } as const;

/** One issue, with what the web page lets you do: read and edit it, assign and label it,
 *  discuss it, close it with a reason or reopen it. */
export function IssueDetailView({ projectId, number, refreshKey, pollKey = 0, onBack, onChanged }: IssueDetailViewProps) {
  const [reload, setReload] = useState(0);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const query = useQuery(githubKeys.issueDetail(projectId, number), ({ poll }) => commands.issueDetail(projectId, number, poll), refreshKey + reload, {
    staleMs: QUERY_STALE_MS,
    poll: pollKey,
  });
  const loaded: Loaded = query.state === "ready" ? { state: "ready", issue: query.data } : query;
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState<IssueCloseReason>("completed");
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [bodyOpen, setBodyOpen] = useState(true);
  const { candidates, load } = useCandidates(projectId);
  const busy = pending !== null;

  async function openLink(url: string) {
    const message = await openExternalLink(url);
    if (message) setError(message);
  }

  const issue = loaded.state === "ready" ? loaded.issue : null;
  const nav = (
    <div className="pr-nav">
      <button className="pr-back" onClick={onBack}>
        <ArrowLeftIcon size={14} /> Issues
      </button>
      <span className="grow" />
      {issue && (
        <>
          <CopyLinkButton url={issue.url} onError={setError} />
          <button
            className="icon-btn sm"
            onClick={() => void openLink(issue.url)}
            title="Open this issue on GitHub"
            aria-label="Open on GitHub"
          >
            <MarkGithubIcon size={16} />
          </button>
        </>
      )}
    </div>
  );
  if (loaded.state === "loading") {
    return (
      <div className="pr-review" aria-busy>
        {nav}
        <Skeleton kind="detail" label="Loading issue…" />
      </div>
    );
  }
  if (loaded.state === "error") {
    return (
      <div className="pr-review">
        {nav}
        <p role="alert" className="pr-empty error">
          {loaded.message}
        </p>
      </div>
    );
  }

  const { issue: detail } = loaded;
  const phase = issuePhase(detail);
  const conversationCount = detail.timeline.filter(isConversationItem).length;
  const mentions = mergeMentions(conversationPeople(detail), candidates.state === "ready" ? candidates.data.users : []);
  const open = phase === "open";

  /** Runs a change on GitHub, then shows the issue's new state. A change with no kind holds
   *  nothing else back: the control that asked for it shows its own progress. */
  async function change(kind: Pending | null, run: () => Promise<Result>) {
    if (kind) setPending(kind);
    setError(null);
    const result = await run();
    if (kind) setPending(null);
    if (result.status === "error") {
      setError(result.error.message);
      return false;
    }
    setReload((n) => n + 1);
    onChanged();
    return true;
  }

  const edit = (partial: Partial<IssueEdit>) =>
    change("edit", () => commands.editIssue(projectId, number, { ...NO_EDIT, ...partial }));
  /** People and labels: their picker row or link shows the work. */
  const quietEdit = (partial: Partial<IssueEdit>) =>
    change(null, () => commands.editIssue(projectId, number, { ...NO_EDIT, ...partial }));

  async function saveTitle() {
    if (titleDraft === null) return;
    if (!titleChanged(detail.title, titleDraft) || (await edit({ title: titleDraft.trim() }))) setTitleDraft(null);
  }

  async function saveBody() {
    if (bodyDraft === null) return;
    if (bodyDraft === detail.body || (await edit({ body: bodyDraft }))) setBodyDraft(null);
  }

  async function sendComment() {
    if (await change("comment", () => commands.commentIssue(projectId, number, comment))) setComment("");
  }

  async function close(why: IssueCloseReason) {
    // A comment left in the box goes out with the close, as the web's "Close with comment" does.
    if (await change("close", () => commands.closeIssue(projectId, number, why, comment))) setComment("");
  }

  return (
    <MarkdownImages projectId={projectId} signed={detail.signedImages}>
    <ReactionsSaved.Provider
      value={(subject, content, add) =>
        updateQuery<IssueDetail>(githubKeys.issueDetail(projectId, number), (d) => withReaction(d, subject, content, add))
      }
    >
    <div className="pr-review">
      <RefreshNotice query={query} />
      {nav}
      <div className="pr-scroll">
        <header className="pr-hero">
          {titleDraft === null ? (
            <h3 className="pr-title">
              {detail.title} <span className="pr-number">#{detail.number}</span>
              <button
                className="icon-btn sm issue-edit"
                aria-label="Edit title"
                title="Edit title"
                disabled={busy}
                onClick={() => setTitleDraft(detail.title)}
              >
                <PencilIcon size={14} />
              </button>
            </h3>
          ) : (
            <form
              className="issue-title-edit"
              onSubmit={(e) => {
                e.preventDefault();
                void saveTitle();
              }}
            >
              <input
                aria-label="Title"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setTitleDraft(null)}
              />
              <button
                type="submit"
                className={`primary${pending === "edit" ? " pending" : ""}`}
                disabled={busy || titleDraft.trim() === ""}
              >
                <Working on={pending === "edit"} label="Saving…">
                  Save
                </Working>
              </button>
              <button type="button" onClick={() => setTitleDraft(null)} disabled={busy}>
                Cancel
              </button>
            </form>
          )}
          <div className="pr-hero-meta">
            <span className={`pr-status ${PILL[phase]}`}>
              <IssueStateIcon phase={phase} size={14} />
              {ISSUE_PHASE_LABEL[phase]}
            </span>
            <Avatar login={detail.author} size={20} />
            <span className="pr-row-author">
              <strong>{detail.author}</strong>
              {detail.createdAt && <> opened {relativeTime(detail.createdAt)} ago</>}
            </span>
          </div>
        </header>

        <section className="pr-section" aria-label="Description">
          <article className="pr-entry">
            <Avatar login={detail.author} size={24} />
            <div className="pr-entry-card">
              <header>
                <strong>{detail.author}</strong>
                <span className="pr-tag">Author</span>
                <span className="pr-entry-action">wrote</span>
                <span className="grow" />
                {bodyDraft === null && (
                  <button
                    className="icon-btn sm issue-edit"
                    aria-label="Edit description"
                    title="Edit description"
                    disabled={busy}
                    onClick={() => {
                      setBodyOpen(true);
                      setBodyDraft(detail.body);
                    }}
                  >
                    <PencilIcon size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn sm issue-body-toggle"
                  aria-expanded={bodyOpen}
                  aria-label={bodyOpen ? "Collapse description" : "Expand description"}
                  title={bodyOpen ? "Collapse description" : "Expand description"}
                  onClick={() => setBodyOpen((open) => !open)}
                >
                  <ChevronDownIcon size={14} className="pr-chev" />
                </button>
              </header>
              <Collapsible open={bodyOpen}>
                {bodyDraft === null ? (
                  <>
                    {detail.body.trim() ? (
                      <Markdown source={detail.body} />
                    ) : (
                      <p className="pr-field-empty issue-no-body">No description provided.</p>
                    )}
                    <Reactions projectId={projectId} subjectId={detail.nodeId} reactions={detail.reactions} onError={setError} />
                  </>
                ) : (
                  <div className="issue-body-edit">
                    <MarkdownEditor
                      label="Description"
                      rows={8}
                      value={bodyDraft}
                      autoFocus
                      onChange={setBodyDraft}
                      mentions={mentions}
                      onMentionOpen={load}
                    />
                    <div className="pr-merge-row">
                      <button
                        className={`primary${pending === "edit" ? " pending" : ""}`}
                        disabled={busy}
                        onClick={() => void saveBody()}
                      >
                        <Working on={pending === "edit"} label="Saving…">
                          Save
                        </Working>
                      </button>
                      <button onClick={() => setBodyDraft(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </Collapsible>
            </div>
          </article>
        </section>

        <section className="pr-section pr-details" aria-label="Details">
          <Field
            title="Assignees"
            editable
            picker={(closePicker) => (
              <Picker
                title="Assign up to 10 people"
                candidates={candidates}
                onOpen={load}
                items={(c) => c.users.map((u) => ({ key: u, label: u, login: u }))}
                selected={detail.assignees}
                busy={busy}
                onToggle={(key, on) => quietEdit(on ? { addAssignees: [key] } : { removeAssignees: [key] })}
                onClose={closePicker}
              />
            )}
          >
            {detail.assignees.length === 0 ? (
              <p className="pr-field-empty">
                No one
                {detail.viewer && (
                  <>
                    {" – "}
                    <AssignYourself disabled={busy} onAssign={() => quietEdit({ addAssignees: [detail.viewer] })} />
                  </>
                )}
              </p>
            ) : (
              <ul className="pr-people">
                {detail.assignees.map((login) => (
                  <li key={login}>
                    <Avatar login={login} size={18} />
                    <span className="pr-person">{login}</span>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <Field
            title="Labels"
            editable
            picker={(closePicker) => (
              <Picker
                title="Apply labels"
                candidates={candidates}
                onOpen={load}
                items={(c) => c.labels.map((l) => ({ key: l.name, label: l.name, color: l.color }))}
                selected={detail.labels.map((l) => l.name)}
                busy={busy}
                onToggle={(key, on) => quietEdit(on ? { addLabels: [key] } : { removeLabels: [key] })}
                onClose={closePicker}
              />
            )}
          >
            {detail.labels.length === 0 ? (
              <p className="pr-field-empty">None yet</p>
            ) : (
              <div className="pr-labels">
                {detail.labels.map((l) => (
                  <LabelChip key={l.name} label={l} />
                ))}
              </div>
            )}
          </Field>
        </section>

        <section className="pr-section" aria-label="Conversation">
          <h4>
            <CommentIcon size={14} /> Conversation
            {conversationCount > 0 && <span className="pr-count">{conversationCount}</span>}
          </h4>
          {detail.timeline.map((c, i) => !isConversationItem(c) ? (
            <ActivityRow key={i} item={c} onOpen={(url) => void openLink(url)} />
          ) : (
            <article key={c.id || i} className="pr-entry">
              <Avatar login={c.author} size={24} />
              <div className="pr-entry-card">
                <header>
                  <strong>{c.author}</strong>
                  {c.author === detail.author && <span className="pr-tag">Author</span>}
                  <span className="pr-entry-action">commented</span>
                  <time dateTime={c.createdAt}>{relativeTime(c.createdAt)}</time>
                  {c.kind === "comment" && c.id && detail.viewer !== "" && c.author === detail.viewer && editingComment !== c.id && (
                    <CommentTools projectId={projectId} id={c.id} onEdit={() => setEditingComment(c.id)} onDeleted={() => setReload((n) => n + 1)} onError={setError} />
                  )}
                </header>
                {editingComment === c.id ? (
                  <CommentEditForm
                    projectId={projectId}
                    id={c.id}
                    initial={c.body}
                    onSaved={() => { setEditingComment(null); setReload((n) => n + 1); }}
                    onCancel={() => setEditingComment(null)}
                    onError={setError}
                    mentions={mentions}
                    onMentionOpen={load}
                  />
                ) : (
                  <>
                    {c.body.trim() && <Markdown source={c.body} />}
                    {c.reactions && <Reactions projectId={projectId} subjectId={c.id} reactions={c.reactions} onError={setError} />}
                  </>
                )}
              </div>
            </article>
          ))}
          {detail.timelineTruncated && <MoreOnGithub url={detail.url} onOpen={(url) => void openLink(url)} />}
          <form
            className="pr-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void sendComment();
            }}
          >
            {detail.viewer && <Avatar login={detail.viewer} size={24} />}
            <div className="pr-compose-box">
              <MarkdownEditor
                label="Comment"
                placeholder="Leave a comment"
                rows={3}
                value={comment}
                onChange={setComment}
                mentions={mentions}
                onMentionOpen={load}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="submit"
                className={pending === "comment" ? "pending" : undefined}
                disabled={busy || !canSubmitComment(comment)}
                title={`Send (${shortcutLabel}${shortcutLabel === "⌘" ? "↩" : "Enter"})`}
              >
                <Working on={pending === "comment"} label="Commenting…">
                  Comment
                </Working>
              </button>
            </div>
          </form>
        </section>
        {error && (
          <p role="alert" className="pr-error">
            {error}
          </p>
        )}
      </div>

      <footer className="pr-merge" aria-label="Status">
        {open ? (
          <div className="pr-merge-row">
            <SplitButton
              label={
                <Working on={pending === "close"} label="Closing…">
                  {canSubmitComment(comment) ? "Close with comment" : REASONS.find((r) => r.reason === reason)?.title}
                </Working>
              }
              onClick={() => void close(reason)}
              disabled={busy}
              pending={pending === "close"}
              menuDisabled={busy}
              menuLabel="Close options"
            >
              <SplitMenu label="Close reason">
                {REASONS.map((r) => (
                  <SplitMenuItem
                    key={r.reason}
                    title={r.title}
                    help={r.help}
                    checked={r.reason === reason}
                    onSelect={() => {
                      setReason(r.reason);
                      void close(r.reason);
                    }}
                  />
                ))}
              </SplitMenu>
            </SplitButton>
          </div>
        ) : (
          <>
            <p className="pr-merge-status neutral">
              <IssueStateIcon phase={phase} size={14} />
              {phase === "notPlanned" ? "Closed as not planned" : "Closed as completed"}
            </p>
            <div className="pr-merge-row">
              <button
                className={pending === "reopen" ? "pending" : undefined}
                disabled={busy}
                onClick={() => void change("reopen", () => commands.reopenIssue(projectId, number))}
              >
                <Working on={pending === "reopen"} label="Reopening…">
                  Reopen issue
                </Working>
              </button>
            </div>
          </>
        )}
      </footer>
    </div>
    </ReactionsSaved.Provider>
    </MarkdownImages>
  );
}
