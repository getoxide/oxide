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
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestEdit,
} from "../bindings";
import { openExternalLink } from "../shared/externalLink";
import { CopyLinkButton } from "../shared/CopyLinkButton";
import { Avatar } from "../shared/Avatar";
import { githubKeys } from "../shared/githubQueries";
import { getQueryData, invalidateQueries, QUERY_STALE_MS, setQueryData, updateQueries, useQuery, type QueryResult } from "../shared/queryCache";
import { RefreshNotice } from "../shared/RefreshNotice";
import { Checks } from "./PullRequestChecks";
import { Markdown } from "./PullRequestMarkdown";
import { MergeFooter, MergeStatus, type Pending, Working } from "./PullRequestMerge";
import { NO_EDIT, PullRequestPeople, ReviewStateIcon } from "./PullRequestPeople";
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

/** Where the list's summary of a pull request is cached. The detail query has a different shape
 *  (`PullRequestDetail`), so a summary is never written there:
 *  the review reads this key for an instant hero and lets the detail fetch fill in the rest. */
export function pullRequestPreviewKey(projectId: number, number: number): string {
  return `p${projectId}:prs:preview:${number}`;
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
    setQueryData(pullRequestPreviewKey(projectId, pr.number), pr);
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
        <button className="btn sm primary" onClick={() => setCreating(true)} title="Open a pull request from the Project's current branch"><GitPullRequestIcon size={14} /> New pull request</button>
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
          <GithubSetup projectId={projectId} guidance={list.message} onReady={() => { invalidateQueries(`p${projectId}:`); setManual((v) => v + 1); }} />
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
            <button className="btn sm primary" onClick={() => setCreating(true)} title="Open a pull request from the Project's current branch"><GitPullRequestIcon size={14} /> New pull request</button>
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
                    setQueryData(pullRequestPreviewKey(projectId, pr.number), pr);
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
  // Checks start and finish within minutes, so follow them closer than the general refresh does,
  // only while the pull request is shown. Soft polls: never two `gh` calls at once, and backed off
  // after failures.
  const [settling, setSettling] = useState(false);
  const fastPoll = useAutoRefresh({ enabled: active && settling, intervalMs: CHECKS_REFRESH_MS });
  const query = useQuery(
    `p${projectId}:prs:detail:${number}`,
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

  const nowSettling =
    loaded.state === "ready" &&
    (loaded.detail.phase === "open" || loaded.detail.phase === "draft") &&
    (loaded.detail.checks.some((c) => c.state === "pending") || loaded.detail.mergeState === "unknown");
  useEffect(() => setSettling(nowSettling), [nowSettling]);

  async function openLink(url: string) {
    const message = await openExternalLink(url);
    if (message) setError(message);
  }

  // What the repository list already told us, if this pull request came from there. It only has
  // the summary fields, so it paints the hero while the detail query supplies checks, diff and
  // comments; it is never written into the detail query's own key.
  const preview = getQueryData<PullRequest>(pullRequestPreviewKey(projectId, number));
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
            className="pr-github"
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
  const inputs = { phase, checks: detail.checks, mergeState: detail.mergeState, reviewDecision: detail.reviewDecision ?? null };
  const status = readiness(inputs);
  const requirements = live ? mergeRequirements(inputs) : [];
  // GitHub reports "blocked" while required checks run or a review is missing, and the merge would be refused.
  const mergeBlocked = ["conflicting", "blocked", "behind"].includes(detail.mergeState);
  const canMerge = phase === "open" && method !== null && !busy && !mergeBlocked;
  // Only a wait (checks, review) can be left to GitHub; conflicts and a stale branch need the user.
  const canAutoMerge = phase === "open" && method !== null && detail.mergeState === "blocked";

  async function act(kind: Pending, run: () => Promise<Result>) {
    setPending(kind);
    setError(null);
    const result = await run();
    setPending(null);
    if (result.status === "error") setError(result.error.message);
    else invalidateQueries(`p${projectId}:prs:list:`);
    return result.status === "ok";
  }

  /** A merged or closed pull request must not linger on the cached lists. */
  const dropFromLists = () =>
    updateQueries<PullRequest[]>(`p${projectId}:prs:list:`, (prs) => prs.filter((p) => p.number !== number));

  async function sendComment() {
    if (await act("comment", () => commands.commentPullRequest(projectId, number, comment))) {
      setComment("");
      setReload((n) => n + 1);
    }
  }

  async function merge() {
    if (method === null) return;
    if (await act("merge", () => commands.mergePullRequest(projectId, number, method, deleteBranch, false))) {
      setMerged(true);
      dropFromLists();
      onChanged();
      if (mergeDoneTimer.current !== null) window.clearTimeout(mergeDoneTimer.current);
      mergeDoneTimer.current = window.setTimeout(() => onBack("merged"), 1050);
    }
  }

  async function mergeWhenReady() {
    if (method === null) return;
    if (await act("auto", () => commands.mergePullRequest(projectId, number, method, deleteBranch, true))) setAutoMerge(true);
  }

  async function closePullRequest() {
    if (await act("close", () => commands.closePullRequest(projectId, number))) {
      dropFromLists();
      onChanged();
      onBack("closed");
    }
  }

  /** Runs a change to the pull request on GitHub, then shows its new state. */
  async function change(kind: Pending, run: () => Promise<Result>) {
    const ok = await act(kind, run);
    if (ok) setReload((n) => n + 1);
    return ok;
  }

  const setDraft = (draft: boolean) => change("ready", () => commands.setPullRequestDraft(projectId, number, draft));
  const edit = (partial: Partial<PullRequestEdit>) =>
    change("edit", () => commands.editPullRequest(projectId, number, { ...NO_EDIT, ...partial }));
  return (
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

        {detail.body.trim() && <Description body={detail.body} />}
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
            {detail.comments.length > 0 && <span className="pr-count">{detail.comments.length}</span>}
          </h4>
          {detail.comments.map((c, i) => (
            <Entry
              key={c.id ?? i}
              entry={c}
              author={pr.author}
              viewer={detail.viewer}
              projectId={projectId}
              onChanged={() => setReload((n) => n + 1)}
              onError={setError}
            />
          ))}
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
          onMerge={() => void merge()}
          onAutoMerge={() => void mergeWhenReady()}
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
function Entry({ entry, author, viewer, projectId, onChanged, onError }: {
  entry: PullRequestComment;
  author: string;
  viewer: string;
  projectId: number;
  /** The conversation changed on GitHub: load it again. */
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Only a plain comment of yours can be rewritten or removed; reviews and others' comments cannot.
  const id = !entry.review && viewer !== "" && entry.author === viewer ? entry.id : null;
  return (
    <article className={`pr-entry${entry.review ? ` pr-entry-${entry.review}` : ""}`}>
      <Avatar login={entry.author} size={24} />
      <div className="pr-entry-card">
        <header>
          <strong>{entry.author}</strong>
          {entry.author === author && <span className="pr-tag">Author</span>}
          <span className="pr-entry-action">
            {entry.review ? (
              <>
                <ReviewStateIcon state={entry.review} size={12} /> {REVIEW_ACTION[entry.review]}
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
          />
        ) : entry.body.trim() && <Markdown source={entry.body} />}
      </div>
    </article>
  );
}

/** The description, folded away until asked for: bot and template boilerplate shouldn't
 *  push the rest off the screen, and when opened it is the whole text. */
function Description({ body }: { body: string }) {
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
    </section>
  );
}
