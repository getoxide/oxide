import { Skeleton } from "../shared/Skeleton";
import {
  ArrowLeftIcon,
  BlockedIcon,
  ChecklistIcon,
  ChevronDownIcon,
  CommentIcon,
  IssueTrackedByIcon,
  IssueTracksIcon,
  MarkGithubIcon,
  PencilIcon,
} from "@primer/octicons-react";
import { useState, type ReactNode } from "react";
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
  type LinkedIssue,
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
  backLabel?: string;
  /** Changes when the user's own change should fetch the issue again. */
  refreshKey: number;
  /** Changes on the auto-refresh timer or focus: a soft ask that never overlaps a fetch in flight. */
  pollKey?: number;
  onBack: () => void;
  onOpenIssue?: (number: number) => void;
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
export function IssueDetailView({
  projectId,
  number,
  backLabel = "Issues",
  refreshKey,
  pollKey = 0,
  onBack,
  onOpenIssue,
  onChanged,
}: IssueDetailViewProps) {
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

  function openLinkedIssue(linked: LinkedIssue) {
    if (!linked.crossRepository && linked.number > 0 && onOpenIssue) {
      onOpenIssue(linked.number);
    } else if (linked.url) {
      void openLink(linked.url);
    }
  }

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

  const issue = loaded.state === "ready" ? loaded.issue : null;

  async function saveTitle() {
    if (titleDraft === null) return;
    if (!titleChanged(issue?.title ?? "", titleDraft) || (await edit({ title: titleDraft.trim() }))) setTitleDraft(null);
  }
  const nav = (
    <div className="pr-nav">
      <button className="pr-back" onClick={onBack}>
        <ArrowLeftIcon size={14} /> {backLabel}
      </button>
      <div className="pr-nav-title">
        {issue === null ? (
          <span className="pr-nav-number">#{number}</span>
        ) : titleDraft === null ? (
          <h3 className="pr-title" title={`${issue.title} #${issue.number}`}>
            {issue.title} <span className="pr-number">#{issue.number}</span>
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
              className={`btn sm primary${pending === "edit" ? " pending" : ""}`}
              disabled={busy || titleDraft.trim() === ""}
            >
              <Working on={pending === "edit"} label="Saving…">
                Save
              </Working>
            </button>
            <button type="button" className="btn sm" onClick={() => setTitleDraft(null)} disabled={busy}>
              Cancel
            </button>
          </form>
        )}
      </div>
      {issue && titleDraft === null && (
        <div className="pr-nav-actions">
          <button
            className="icon-btn sm issue-edit"
            aria-label="Edit title"
            title="Edit title"
            disabled={busy}
            onClick={() => setTitleDraft(issue.title)}
          >
            <PencilIcon size={14} />
          </button>
          <CopyLinkButton url={issue.url} onError={setError} />
          <button
            className="icon-btn sm"
            onClick={() => void openLink(issue.url)}
            title="Open this issue on GitHub"
            aria-label="Open on GitHub"
          >
            <MarkGithubIcon size={15} />
          </button>
        </div>
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
          {detail.parent && (
            <button
              type="button"
              className="issue-parent-link"
              onClick={() => openLinkedIssue(detail.parent!)}
            >
              <IssueTrackedByIcon size={12} className="issue-parent-icon" />
              <span className="issue-parent-tag">Parent</span>
              <IssueStateIcon phase={issuePhase(detail.parent)} size={12} />
              <span className="issue-linked-title">{detail.parent.title}</span>
              <span className="issue-linked-number">#{detail.parent.number}</span>
              {detail.parent.crossRepository && (
                <span className="issue-linked-repo">{detail.parent.repository}</span>
              )}
            </button>
          )}
          <div className="pr-hero-meta">
            <span className={`pr-status ${PILL[phase]}`}>
              <IssueStateIcon phase={phase} size={13} />
              {ISSUE_PHASE_LABEL[phase]}
            </span>
            {detail.blockedByCount > 0 && (
              <span className="pr-status blocked">
                <BlockedIcon size={13} />
                {detail.blockedByCount > 1 ? `Blocked · ${detail.blockedByCount}` : "Blocked"}
              </span>
            )}
            <span className="pr-hero-author">
              <Avatar login={detail.author} size={20} />
              <span className="pr-row-author">
                <strong>{detail.author}</strong>
                {detail.createdAt && <> opened {relativeTime(detail.createdAt)} ago</>}
              </span>
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

        {(detail.subIssuesTotal > 0 || detail.subIssues.length > 0) && (
          <CollapsibleLinkedSection
            title="Sub-issues"
            icon={<ChecklistIcon size={14} />}
            countLabel={`${detail.subIssuesCompleted}/${detail.subIssuesTotal}`}
            items={detail.subIssues}
            onOpen={openLinkedIssue}
            headerExtra={
              detail.subIssuesTotal > 0 ? (
                <span
                  className="issue-progress"
                  role="progressbar"
                  aria-label="Sub-issue progress"
                  aria-valuenow={detail.subIssuesCompleted}
                  aria-valuemin={0}
                  aria-valuemax={detail.subIssuesTotal}
                >
                  <span
                    className="issue-progress-fill"
                    style={{
                      width: `${Math.min(100, Math.round((detail.subIssuesCompleted / detail.subIssuesTotal) * 100))}%`,
                    }}
                  />
                </span>
              ) : null
            }
          />
        )}

        {detail.blockedBy.length > 0 && (
          <CollapsibleLinkedSection
            title="Blocked by"
            icon={<BlockedIcon size={14} />}
            countLabel={detail.blockedBy.length}
            items={detail.blockedBy}
            onOpen={openLinkedIssue}
          />
        )}

        {detail.blocking.length > 0 && (
          <CollapsibleLinkedSection
            title="Blocking"
            icon={<IssueTracksIcon size={14} />}
            countLabel={detail.blocking.length}
            items={detail.blocking}
            onOpen={openLinkedIssue}
          />
        )}

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
          {(detail.timeline.length > 0 || detail.timelineTruncated) && (
            <div className="pr-timeline">
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
            </div>
          )}
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

function CollapsibleLinkedSection({
  title,
  icon,
  countLabel,
  items,
  onOpen,
  headerExtra,
}: {
  title: string;
  icon: ReactNode;
  countLabel: string | number;
  items: LinkedIssue[];
  onOpen: (item: LinkedIssue) => void;
  headerExtra?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const expandable = items.length > 0;
  return (
    <section className="pr-section issue-linked-section" aria-label={title}>
      {expandable ? (
        <button
          type="button"
          className="pr-toggle issue-linked-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {icon}
          <h4>{title}</h4>
          <span className="pr-count">{countLabel}</span>
          {headerExtra}
          <ChevronDownIcon size={14} className="pr-chev" />
        </button>
      ) : (
        <div className="pr-toggle issue-linked-toggle is-static">
          {icon}
          <h4>{title}</h4>
          <span className="pr-count">{countLabel}</span>
          {headerExtra}
        </div>
      )}
      {expandable && (
        <Collapsible open={open}>
          <LinkedIssueList items={items} onOpen={onOpen} />
        </Collapsible>
      )}
    </section>
  );
}

function LinkedIssueRow({
  item,
  onOpen,
}: {
  item: LinkedIssue;
  onOpen: (item: LinkedIssue) => void;
}) {
  const phase = issuePhase(item);
  const closed = phase !== "open";
  const blockedByCount = item.blockedByCount ?? 0;
  const assignees = item.assignees ?? [];
  const blocked = !closed && blockedByCount > 0;
  return (
    <button
      type="button"
      className={`issue-linked-item${closed ? " is-closed" : ""}`}
      title={`${item.title} (#${item.number})`}
      onClick={() => onOpen(item)}
    >
      <IssueStateIcon phase={phase} size={14} />
      <span className="issue-linked-title">{item.title}</span>
      <span className="issue-linked-meta">
        {closed && (
          <span className={`issue-linked-state ${phase}`}>{ISSUE_PHASE_LABEL[phase]}</span>
        )}
        {blocked && (
          <span
            className="issue-linked-blocked"
            title={`Blocked by ${blockedByCount} open ${blockedByCount === 1 ? "issue" : "issues"}`}
          >
            <BlockedIcon size={11} />
            {blockedByCount > 1 ? `Blocked · ${blockedByCount}` : "Blocked"}
          </span>
        )}
        {assignees.length > 0 && (
          <span className="issue-linked-assignees" title={`Assigned to ${assignees.join(", ")}`}>
            {assignees.slice(0, 3).map((login) => (
              <Avatar key={login} login={login} size={16} />
            ))}
          </span>
        )}
        {item.crossRepository && (
          <span className="issue-linked-repo">{item.repository}</span>
        )}
        <span className="issue-linked-number">#{item.number}</span>
      </span>
    </button>
  );
}

function LinkedIssueList({
  items,
  onOpen,
}: {
  items: LinkedIssue[];
  onOpen: (item: LinkedIssue) => void;
}) {
  return (
    <ul className="issue-linked-list">
      {items.map((item) => (
        <li key={`${item.repository}#${item.number}`}>
          <LinkedIssueRow item={item} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}
