import { shortcutLabel } from "../shared/platform";
import { Collapsible } from "../shared/Collapsible";
import { Skeleton } from "../shared/Skeleton";
import { SurfaceSearch } from "../shared/SurfaceSearch";
import { MarkdownEditor } from "../shared/MarkdownEditor";
import { CommentEditForm, CommentTools } from "../shared/CommentTools";
import { PullRequestCreate } from "./PullRequestCreate";
import { GithubSetup } from "../settings/GithubSetup";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  CommentIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  MarkGithubIcon,
} from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import {
  commands,
  type MergeMethod,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestEdit,
  type ReactionGroup,
} from "../bindings";
import { openExternalLink } from "../shared/externalLink";
import { CopyLinkButton } from "../shared/CopyLinkButton";
import { Avatar } from "../shared/Avatar";
import { githubKeys } from "../shared/githubQueries";
import { getQueryData, invalidateQueries, QUERY_STALE_MS, setQueryData, updateQueries, useQuery, type QueryResult } from "../shared/queryCache";
import { RefreshNotice } from "../shared/RefreshNotice";
import { Checks } from "./PullRequestChecks";
import { Markdown, MarkdownImages } from "./PullRequestMarkdown";
import { ActivityRow, type ConversationItem, isConversationItem } from "./PullRequestTimeline";
import { Reactions } from "../shared/Reactions";
import { MergeFooter, MergeStatus, type Pending, Working } from "./PullRequestMerge";
import { NO_EDIT, PullRequestPeople, ReviewStateIcon, useCandidates } from "./PullRequestPeople";
import { conversationPeople, mergeMentions } from "../shared/mentions";
import { defaultMergeMethod, mergeRequirements, readiness } from "./pullRequestReview";
import { relativeTime } from "../shared/relativeTime";
import { useAutoRefresh } from "../shared/useAutoRefresh";

interface PullRequestBrowserProps {
  projectId: number;
  /** Changes when the user's own change should reload the list. */
  refreshKey: number;
  /** Changes on the auto-refresh timer or focus: a soft ask that never overlaps a fetch in flight. */
  pollKey?: number;
  /** Whether the Surface is shown; hidden, an open pull request stops following its checks. */
  active?: boolean;
  /** Called after a merge or a new pull request, so other views reload. */
  onChanged: () => void;
}


export function PullRequestStateIcon({ draft, size = 16 }: { draft: boolean; size?: number }) {
  return draft ? (
    <GitPullRequestDraftIcon size={size} className="pr-state-draft" />
  ) : (
    <GitPullRequestIcon size={size} className="pr-state-open" />
  );
}

function Branches({ head, base }: { head: string; base: string }) {
  return (
    <span className="pr-branches" title={`${head} → ${base}`}>
      <span className="pr-branch">{head}</span>
      <ArrowRightIcon size={12} />
      <span className="pr-branch">{base}</span>
    </span>
  );
}

/** Open pull requests of the repository: list, search, and one pull request to review. */
export function PullRequestBrowser({ projectId, refreshKey, pollKey = 0, active = true, onChanged }: PullRequestBrowserProps) {
  const [creating, setCreating] = useState(false);
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState("");
  // Sent on submit, not per keystroke: every search is a `gh` call.
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(0);
  const list = useQuery(
    githubKeys.pullRequestList(projectId, mine, search),
    () => commands.listPullRequests(projectId, mine, search),
    refreshKey + manual,
    { staleMs: QUERY_STALE_MS, poll: pollKey },
  );
  const [opened, setOpened] = useState<number | null>(null);
  // A quiet line on the list after a pull request was merged or closed; it fades on its own.
  const [outcome, setOutcome] = useState<{ kind: "merged" | "closed"; number: number } | null>(null);

  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => setOutcome(null), 4000);
    return () => clearTimeout(timer);
  }, [outcome]);

  if (creating) return <PullRequestCreate projectId={projectId} onCancel={() => setCreating(false)} onCreated={(pr) => {
    setQueryData(githubKeys.pullRequestPreview(projectId, pr.number), pr);
    setCreating(false); setOpened(pr.number); onChanged();
  }} />;

  if (opened !== null) {
    return (
      <PullRequestReview
        projectId={projectId}
        number={opened}
        refreshKey={refreshKey}
        pollKey={pollKey}
        active={active}
        onBack={(done) => {
          if (done) setOutcome({ kind: done, number: opened });
          setOpened(null);
          setManual((n) => n + 1);
        }}
        onChanged={onChanged}
      />
    );
  }

  return (
    <div className="pr-browser">
      <div className="surface-toolbar">
        <SurfaceSearch
          label="Search pull requests"
          value={query}
          onChange={setQuery}
          onClear={() => {
            setQuery("");
            setSearch("");
          }}
          onSubmit={() => setSearch(query.trim())}
        >
          <button
            type="button"
            className="pr-chip"
            aria-pressed={mine}
            title={`Only pull requests you opened`}
            onClick={() => setMine((m) => !m)}
          >
            Mine
          </button>
        </SurfaceSearch>
        <button className="btn sm primary" onClick={() => setCreating(true)} title="Open a pull request from a local branch"><GitPullRequestIcon size={14} /> New pull request</button>
      </div>
      <div className="pr-scroll">
        <RefreshNotice query={list} />
        {outcome && (
          <p className="pr-outcome" role="status">
            #{outcome.number} {outcome.kind}
          </p>
        )}
        {list.state === "loading" && <Skeleton label="Loading pull requests…" />}
        {list.state === "error" && (
          <GithubSetup projectId={projectId} guidance={list.message} onReady={() => { invalidateQueries(githubKeys.project(projectId)); setManual((v) => v + 1); }} />
        )}
        {list.state === "ready" && list.data.length === 0 && (
          <div className="pr-empty surface-empty">
            <GitPullRequestIcon size={32} />
            <p className="surface-empty-title">{search || mine ? "No pull requests match." : "No open pull requests."}</p>
            <p className="surface-empty-description">
              {search || mine
                ? "Nothing in this Project’s repository matches these filters."
                : "Pull requests opened from this Project’s branches appear here."}
            </p>
            <button className="btn sm primary" onClick={() => setCreating(true)} title="Open a pull request from a local branch"><GitPullRequestIcon size={14} /> New pull request</button>
          </div>
        )}
        {list.state === "ready" && list.data.length > 0 && (
          <ul className="pr-list" aria-label="Open pull requests">
            {list.data.map((pr) => (
              <li key={pr.number}>
                <button
                  className="pr-row"
                  onClick={() => {
                    // The list already knows this pull request's summary: hand it to the review
                    // so the hero paints before the much slower detail call returns.
                    setQueryData(githubKeys.pullRequestPreview(projectId, pr.number), pr);
                    setOpened(pr.number);
                  }}
                >
                  <PullRequestStateIcon draft={pr.draft} />
                  <span className="pr-row-body">
                    <span className="pr-row-title">{pr.title}</span>
                    <span className="pr-row-meta">
                      <Avatar login={pr.author} size={16} />
                      <span className="pr-row-author">{pr.author}</span>
                      <span aria-hidden>·</span>
                      <span>#{pr.number}</span>
                      {pr.createdAt && (
                        <>
                          <span aria-hidden>·</span>
                          <time dateTime={pr.createdAt}>{relativeTime(pr.createdAt)}</time>
                        </>
                      )}
                      {pr.draft && <span className="pr-tag">Draft</span>}
                    </span>
                    <Branches head={pr.head} base={pr.base} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; detail: PullRequestDetail };

interface PullRequestReviewProps {
  projectId: number;
  number: number;
  refreshKey: number;
  pollKey?: number;
  active?: boolean;
  onBack: (done?: "merged" | "closed") => void;
  onChanged: () => void;
}

/** How often an open pull request reloads while its checks run or GitHub is still settling its
 *  merge state; once everything settled it follows the Surface's normal interval again. */
export const CHECKS_REFRESH_MS = 6_000;

type Result = { status: "ok" } | { status: "error"; error: { message: string } };

/** How many fast polls an open pull request gets while only its merge state is unknown: GitHub
 *  usually computes it within seconds, and a state it never settles must not poll forever. */
export const UNKNOWN_MERGE_STATE_POLLS = 10;

/** Why an open pull request is still moving: checks that run, or a merge state GitHub has not
 *  computed yet. */
function settling(detail: PullRequestDetail | undefined): "checks" | "mergeState" | null {
  if (detail === undefined || (detail.phase !== "open" && detail.phase !== "draft")) return null;
  if (detail.checks.some((c) => c.state === "pending")) return "checks";
  return detail.mergeState === "unknown" ? "mergeState" : null;
}

export function PullRequestReview({
  projectId,
  number,
  refreshKey,
  pollKey = 0,
  active = true,
  onBack,
  onChanged,
}: PullRequestReviewProps) {
  const [reload, setReload] = useState(0);
  const key = githubKeys.pullRequestDetail(projectId, number);
  // Checks start and finish within minutes, and GitHub takes a moment to settle a fresh merge
  // state, so follow those closer than the general refresh does, only while the pull request is
  // shown. Soft polls: never two `gh` calls at once, and backed off after failures.
  // Only `active` turning on revalidates; settling just changes the cadence, so checks starting
  // to run do not fetch again on top of the fetch that reported them.
  const moving = settling(getQueryData<{ detail: PullRequestDetail }>(key)?.detail);
  const fastPoll = useAutoRefresh({
    enabled: active,
    intervalMs: moving === null ? null : CHECKS_REFRESH_MS,
    maxTicks: moving === "mergeState" ? UNKNOWN_MERGE_STATE_POLLS : undefined,
  });
  const query = useQuery(
    key,
    async (): Promise<QueryResult<{ detail: PullRequestDetail }>> => {
      const detail = await commands.pullRequestDetail(projectId, number);
      if (detail.status === "error") return detail;
      return { status: "ok", data: { detail: detail.data } };
    },
    refreshKey + reload,
    { staleMs: QUERY_STALE_MS, poll: pollKey + fastPoll },
  );
  const loaded: Loaded = query.state === "ready" ? { state: "ready", ...query.data } : query;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const busy = pending !== null;
  const [comment, setComment] = useState("");
  const people = useCandidates(projectId);
  const [methodChoice, setMethod] = useState<MergeMethod | null>(null);
  const [deleteChoice, setDeleteBranch] = useState<boolean | null>(null);
  const mergeDoneTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (mergeDoneTimer.current !== null) window.clearTimeout(mergeDoneTimer.current);
  }, []);
  const [merged, setMerged] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);

  const seed = loaded.state === "ready" ? loaded.detail : null;
  // What the user picked wins; until then the repository's own preference applies.
  const method = seed ? defaultMergeMethod(seed.mergeMethods, methodChoice, seed.defaultMergeMethod) : methodChoice;
  const deleteBranch = deleteChoice ?? seed?.deleteBranchOnMerge ?? false;


  async function openLink(url: string) {
    const message = await openExternalLink(url);
    if (message) setError(message);
  }

  // What the repository list already told us, if this pull request came from there. It only has
  // the summary fields, so it paints the hero while the detail query supplies checks, diff and
  // comments; it is never written into the detail query's own key.
  const preview = getQueryData<PullRequest>(githubKeys.pullRequestPreview(projectId, number));
  const shownPr = loaded.state === "ready" ? loaded.detail.pullRequest : (preview ?? null);
  const nav = (
    <div className="pr-nav">
      <button className="pr-back" onClick={() => onBack()}>
        <ArrowLeftIcon size={14} /> Pull requests
      </button>
      <span className="grow" />
      {shownPr && (
        <>
          <CopyLinkButton url={shownPr.url} onError={setError} />
          <button
            className="icon-btn sm"
            onClick={() => void openLink(shownPr.url)}
            title="Open this pull request on GitHub"
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
        <div className="pr-scroll">
          {preview && <PreviewHeader pr={preview} />}
          <Skeleton kind="detail" label="Loading pull request…" />
        </div>
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

  const { detail } = loaded;
  const pr = detail.pullRequest;
  const phase = merged ? "merged" : detail.phase;
  const live = phase === "open" || phase === "draft";
  const conversationCount = detail.timeline.filter(isConversationItem).length;
  const mentions = mergeMentions(
    conversationPeople({ ...detail, author: pr.author }),
    people.candidates.state === "ready" ? people.candidates.data.users : [],
  );
  const inputs = { phase, checks: detail.checks, mergeState: detail.mergeState, reviewDecision: detail.reviewDecision ?? null };
  const status = readiness(inputs);
  const requirements = live ? mergeRequirements(inputs) : [];
  // GitHub reports "blocked" while required checks run or a review is missing, and the merge would be refused.
  const mergeBlocked = ["conflicting", "blocked", "behind"].includes(detail.mergeState);
  const canMerge = phase === "open" && method !== null && !busy && !mergeBlocked;
  // Only a wait (checks, review) can be left to GitHub; conflicts and a stale branch need the user.
  const canAutoMerge = phase === "open" && method !== null && detail.mergeState === "blocked";

  /** A change with no kind holds nothing else back: the control that asked for it shows its own progress. */
  async function act(kind: Pending | null, run: () => Promise<Result>) {
    if (kind) setPending(kind);
    setError(null);
    const result = await run();
    if (kind) setPending(null);
    if (result.status === "error") setError(result.error.message);
    else invalidateQueries(githubKeys.pullRequestLists(projectId));
    return result.status === "ok";
  }

  /** A merged or closed pull request must not linger on the cached lists. */
  const dropFromLists = () =>
    updateQueries<PullRequest[]>(githubKeys.pullRequestLists(projectId), (prs) => prs.filter((p) => p.number !== number));

  async function sendComment() {
    if (await act("comment", () => commands.commentPullRequest(projectId, number, comment))) {
      setComment("");
      setReload((n) => n + 1);
    }
  }

  async function merge(how: MergeMethod) {
    setMethod(how);
    if (await act("merge", () => commands.mergePullRequest(projectId, number, how, deleteBranch, false))) {
      setMerged(true);
      dropFromLists();
      onChanged();
      if (mergeDoneTimer.current !== null) window.clearTimeout(mergeDoneTimer.current);
      mergeDoneTimer.current = window.setTimeout(() => onBack("merged"), 1050);
    }
  }

  async function mergeWhenReady(how: MergeMethod) {
    setMethod(how);
    if (await act("auto", () => commands.mergePullRequest(projectId, number, how, deleteBranch, true))) setAutoMerge(true);
  }

  async function closePullRequest() {
    if (await act("close", () => commands.closePullRequest(projectId, number))) {
      dropFromLists();
      onChanged();
      onBack("closed");
    }
  }

  /** Runs a change to the pull request on GitHub, then shows its new state. */
  async function change(kind: Pending | null, run: () => Promise<Result>) {
    const ok = await act(kind, run);
    if (ok) setReload((n) => n + 1);
    return ok;
  }

  const setDraft = (draft: boolean) => change("ready", () => commands.setPullRequestDraft(projectId, number, draft));
  // People and labels: their picker row or "assign yourself" link shows the work.
  const edit = (partial: Partial<PullRequestEdit>) =>
    change(null, () => commands.editPullRequest(projectId, number, { ...NO_EDIT, ...partial }));
  return (
    <MarkdownImages projectId={projectId} signed={detail.signedImages}>
    <div className="pr-review">
      {nav}
      <RefreshNotice query={query} />
      <div className="pr-scroll">
        <header className="pr-hero">
          <h3 className="pr-title">
            {pr.title} <span className="pr-number">#{pr.number}</span>
          </h3>
          <div className="pr-hero-meta">
            <span className={`pr-status ${phase}`}>
              {phase === "merged" ? (
                <GitMergeIcon size={14} />
              ) : phase === "closed" ? (
                <GitPullRequestClosedIcon size={14} />
              ) : (
                <PullRequestStateIcon draft={phase === "draft"} size={14} />
              )}
              {{ merged: "Merged", closed: "Closed", draft: "Draft", open: "Open" }[phase]}
            </span>
            <Avatar login={pr.author} size={20} />
            <span className="pr-row-author">
              <strong>{pr.author}</strong>
              {pr.createdAt && <> opened {relativeTime(pr.createdAt)} ago</>}
            </span>
          </div>
          <Branches head={pr.head} base={pr.base} />
          {(detail.additions > 0 || detail.deletions > 0) && (
            <p className="pr-diffstat" aria-label={`${detail.additions} additions, ${detail.deletions} deletions`}>
              <span className="add">+{detail.additions}</span> <span className="del">−{detail.deletions}</span>
              <span className="pr-diffstat-files">
                {" "}
                in {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
              </span>
            </p>
          )}
        </header>

        {(detail.body.trim() || detail.reactions.length > 0) && (
          <Description body={detail.body} projectId={projectId} subjectId={detail.nodeId} reactions={detail.reactions} onError={setError} />
        )}
        {live && <MergeStatus
            requirements={requirements}
            busy={busy}
            updating={pending === "update"}
            onUpdateBranch={() => void change("update", () => commands.updatePullRequestBranch(projectId, number))}
          />}
        <Checks checks={detail.checks} onOpen={(url) => void openLink(url)} />
        <PullRequestPeople
          projectId={projectId}
          detail={detail}
          editable={live}
          busy={busy}
          onEdit={edit}
          onConvertToDraft={() => void setDraft(true)}
        />

        <section className="pr-section" aria-label="Conversation">
          <h4>
            <CommentIcon size={14} /> Conversation
            {conversationCount > 0 && <span className="pr-count">{conversationCount}</span>}
          </h4>
          {detail.timeline.map((item, i) =>
            isConversationItem(item) ? (
              <Entry
                key={item.id || i}
                entry={item}
                author={pr.author}
                viewer={detail.viewer}
                projectId={projectId}
                mentions={mentions}
                onMentionOpen={people.load}
                onChanged={() => setReload((n) => n + 1)}
                onError={setError}
              />
            ) : (
              <ActivityRow key={i} item={item} head={pr.head} onOpen={(url) => void openLink(url)} />
            ),
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
                onMentionOpen={people.load}
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
                disabled={busy || !comment.trim()}
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

      {live || merged ? (
        <MergeFooter
          draft={phase === "draft"}
          merged={merged}
          methods={detail.mergeMethods}
          method={method}
          head={pr.head}
          deleteBranch={deleteBranch}
          busy={busy}
          pending={pending}
          canMerge={canMerge}
          canAutoMerge={canAutoMerge}
          autoMerge={autoMerge}
          tone={status.tone}
          status={status.label}
          onMethod={setMethod}
          onDeleteBranch={setDeleteBranch}
          onMerge={(how) => void merge(how)}
          onAutoMerge={(how) => void mergeWhenReady(how)}
          onReady={() => void setDraft(false)}
          onClose={() => void closePullRequest()}
        />
      ) : (
        <footer className="pr-merge" aria-label="Merge">
          <p className="pr-merge-status">
            {phase === "merged" ? "This pull request was merged." : "This pull request is closed."}
          </p>
        </footer>
      )}
      {merged && (
        <div className="pr-merged-overlay" role="status" aria-live="polite">
          <div className="pr-merged-card">
            <svg className="pr-merged-check" viewBox="0 0 52 52" aria-hidden="true">
              <circle className="pr-merged-circle" cx="26" cy="26" r="22" fill="none" />
              <path className="pr-merged-tick" d="M15.5 26.5l7 7L36.5 19" fill="none" />
            </svg>
            <strong>PR merged</strong>
          </div>
        </div>
      )}
    </div>
    </MarkdownImages>
  );
}

/** The header the list's summary can already paint: title, number, state, author and branches. */
function PreviewHeader({ pr }: { pr: PullRequest }) {
  return (
    <header className="pr-hero">
      <h3 className="pr-title">
        {pr.title} <span className="pr-number">#{pr.number}</span>
      </h3>
      <div className="pr-hero-meta">
        <span className={`pr-status ${pr.draft ? "draft" : "open"}`}>
          <PullRequestStateIcon draft={pr.draft} size={14} />
          {pr.draft ? "Draft" : "Open"}
        </span>
        <Avatar login={pr.author} size={20} />
        <span className="pr-row-author">
          <strong>{pr.author}</strong>
          {pr.createdAt && <> opened {relativeTime(pr.createdAt)} ago</>}
        </span>
      </div>
      <Branches head={pr.head} base={pr.base} />
    </header>
  );
}

const REVIEW_ACTION = {
  approved: "approved these changes",
  changesRequested: "requested changes",
  commented: "reviewed",
  dismissed: "had a review dismissed",
  requested: "was asked to review",
} as const;

/** One conversation entry as the web shows it: who, what they did, when, and what they wrote. */
function Entry({ entry, author, viewer, projectId, mentions, onMentionOpen, onChanged, onError }: {
  entry: ConversationItem;
  author: string;
  viewer: string;
  projectId: number;
  mentions: readonly string[];
  onMentionOpen: () => void;
  /** The conversation changed on GitHub: load it again. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Only a plain comment of yours can be rewritten or removed; reviews and others' comments cannot.
  const review = entry.kind === "review" ? entry.state : null;
  const id = !review && viewer !== "" && entry.author === viewer && entry.id ? entry.id : null;
  return (
    <article className={`pr-entry${review ? ` pr-entry-${review}` : ""}`}>
      <Avatar login={entry.author} size={24} />
      <div className="pr-entry-card">
        <header>
          <strong>{entry.author}</strong>
          {entry.author === author && <span className="pr-tag">Author</span>}
          <span className="pr-entry-action">
            {review ? (
              <>
                <ReviewStateIcon state={review} size={12} /> {REVIEW_ACTION[review]}
              </>
            ) : (
              "commented"
            )}
          </span>
          <time dateTime={entry.createdAt}>{relativeTime(entry.createdAt)}</time>
          {id && !editing && (
            <CommentTools projectId={projectId} id={id} onEdit={() => setEditing(true)} onDeleted={onChanged} onError={onError} />
          )}
        </header>
        {id && editing ? (
          <CommentEditForm
            projectId={projectId}
            id={id}
            initial={entry.body}
            onSaved={() => { setEditing(false); onChanged(); }}
            onCancel={() => setEditing(false)}
            onError={onError}
            mentions={mentions}
            onMentionOpen={onMentionOpen}
          />
        ) : (
          <>
            {entry.body.trim() && <Markdown source={entry.body} />}
            <Reactions projectId={projectId} subjectId={entry.id} reactions={entry.reactions} onError={onError} />
          </>
        )}
      </div>
    </article>
  );
}

/** The description, folded away until asked for: bot and template boilerplate shouldn't
 *  push the rest off the screen, and when opened it is the whole text. */
function Description({ body, projectId, subjectId, reactions, onError }: {
  body: string;
  projectId: number;
  subjectId: string;
  reactions: ReactionGroup[];
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="pr-section pr-description" aria-label="Description">
      <button className="pr-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <h4>Description</h4>
        <ChevronDownIcon size={14} className="pr-chev" />
      </button>
      <Collapsible open={open}>
        <Markdown source={body} />
      </Collapsible>
      <Reactions projectId={projectId} subjectId={subjectId} reactions={reactions} onError={onError} />
    </section>
  );
}
