import { Skeleton } from "./Skeleton";
import { SurfaceSearch } from "./SurfaceSearch";
import { CommentIcon, IssueOpenedIcon, PlusIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { invalidateQueries, QUERY_STALE_MS, useQuery } from "./queryCache";
import { RefreshNotice } from "./RefreshNotice";
import { commands, type Thread } from "./bindings";
import { Avatar } from "./Avatar";
import { IssueCreate } from "./IssueCreate";
import { IssueDetailView } from "./IssueDetailView";
import { IssueStateIcon } from "./IssueStateIcon";
import { issuePhase } from "./issueView";
import { LabelChip } from "./PullRequestPeople";
import { relativeTime } from "./pullRequestReview";
import { useAutoRefresh } from "./useAutoRefresh";
import { GithubSetup } from "./GithubSetup";

export interface IssuesSurfaceProps {
  projectId: number;
  /** Names the repository whose issues are listed. */
  /** Changes after the user's own actions that should reload the surface. */
  refreshKey?: number;
  /** Called after issue mutations (create/close/comment), so parent views can react if needed. */
  onChanged?: () => void;
  /** A Thread was started from an issue: the new Thread, for the sidebar. */
  onDispatched?: (thread: Thread) => void;
}

/** How long typing pauses before the search runs: every search is a `gh` call. */
const SEARCH_DELAY_MS = 350;

/** The repository's issues on GitHub, through `gh`. Like the Pull request tab it reloads by
 *  itself: when opened, after the user's own changes, when the window regains focus, and
 *  periodically while visible. State belongs to one Project, so a different one remounts it. */
export function IssuesSurface(props: IssuesSurfaceProps) {
  return <IssuesViews key={props.projectId} {...props} />;
}

function IssuesViews({ projectId, refreshKey = 0, onChanged, onDispatched }: IssuesSurfaceProps) {
  const tick = useAutoRefresh();
  const reload = refreshKey + tick;
  const availability = useQuery(`p${projectId}:issues:state`, () => commands.issuesState(projectId), reload, { staleMs: QUERY_STALE_MS });
  const [opened, setOpened] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped after the list changed under it (a new issue, a closed one), beyond the timer.
  const [listRevision, setListRevision] = useState(0);

  const changed = () => {
    invalidateQueries(`p${projectId}:issues:list:`);
    setListRevision((n) => n + 1);
    onChanged?.();
  };

  let content: React.ReactNode;
  // The list starts loading together with the check; only a real setup problem replaces it.
  if (availability.state === "error") {
    content = (
      <GithubSetup projectId={projectId} guidance={availability.message} onReady={() => invalidateQueries(`p${projectId}:issues:`)} />
    );
  } else if (availability.state === "ready" && availability.data.availability !== "ready") {
    content = <GithubSetup projectId={projectId} guidance={availability.data.guidance ?? "The GitHub CLI is not ready."} onReady={() => invalidateQueries(`p${projectId}:issues:`)} />;
  } else if (creating) {
    content = (
      <IssueCreate
        projectId={projectId}
        onBack={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setOpened(created.number);
          changed();
        }}
      />
    );
  } else if (opened !== null) {
    content = (
      <IssueDetailView
        projectId={projectId}
        number={opened}
        refreshKey={reload}
        onBack={() => {
          setOpened(null);
          setListRevision((n) => n + 1);
        }}
        onChanged={changed}
        onDispatched={onDispatched}
      />
    );
  } else {
    content = (
      <IssueList
        projectId={projectId}
        refreshKey={reload + listRevision}
        onOpen={setOpened}
        onCreate={() => setCreating(true)}
      />
    );
  }

  return (
    <div className="pr-views">
      <section className="pr-panel pr-panel-flush" aria-label="Issues">
        {content}
      </section>
    </div>
  );
}

interface IssueListProps {
  projectId: number;
  refreshKey: number;
  onOpen: (number: number) => void;
  onCreate: () => void;
}

function IssueList({ projectId, refreshKey, onOpen, onCreate }: IssueListProps) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const list = useQuery(
    `p${projectId}:issues:list:${search}`,
    () => commands.listIssues(projectId, false, false, search),
    refreshKey,
    { staleMs: QUERY_STALE_MS },
  );

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const filtered = search !== "";
  return (
    <div className="pr-browser">
      <div className="surface-toolbar">
        <SurfaceSearch
          label="Search issues"
          value={query}
          onChange={setQuery}
          onClear={() => {
            setQuery("");
            setSearch("");
          }}
        />
        <button className="btn sm primary" onClick={onCreate}>
          <PlusIcon size={14} /> New issue
        </button>
      </div>
      <div className="pr-scroll">
        <RefreshNotice query={list} />
        {list.state === "loading" && <Skeleton label="Loading issues…" />}
        {list.state === "error" && (
          <p role="alert" className="pr-empty error">
            {list.message}
          </p>
        )}
        {list.state === "ready" && list.data.length === 0 && (
          <div className="pr-empty surface-empty">
            <IssueOpenedIcon size={32} />
            <p className="surface-empty-title">
              {filtered ? "No issues match." : "No open issues."}
            </p>
            <p className="surface-empty-description">
              {filtered
                ? "Nothing in this Project’s repository matches these filters."
                : "Issues opened in this Project’s repository appear here."}
            </p>
            <button className="btn sm primary" onClick={onCreate}><PlusIcon size={14} /> New issue</button>
          </div>
        )}
        {list.state === "ready" && list.data.length > 0 && (
          <ul className="pr-list" aria-label="Open issues">
            {list.data.map((issue) => (
              <li key={issue.number}>
                <button className="pr-row" onClick={() => onOpen(issue.number)}>
                  <IssueStateIcon phase={issuePhase(issue)} />
                  <span className="pr-row-body">
                    <span className="pr-row-title">{issue.title}</span>
                    {issue.labels.length > 0 && (
                      <span className="pr-labels">
                        {issue.labels.map((l) => (
                          <LabelChip key={l.name} label={l} />
                        ))}
                      </span>
                    )}
                    <span className="pr-row-meta">
                      <Avatar login={issue.author} size={16} />
                      <span className="pr-row-author">{issue.author}</span>
                      <span aria-hidden>·</span>
                      <span>#{issue.number}</span>
                      {issue.createdAt && (
                        <>
                          <span aria-hidden>·</span>
                          <time dateTime={issue.createdAt}>{relativeTime(issue.createdAt)}</time>
                        </>
                      )}
                      {issue.commentsCount > 0 && (
                        <span className="issue-comments" title={`${issue.commentsCount} comments`}>
                          <CommentIcon size={12} /> {issue.commentsCount}
                        </span>
                      )}
                    </span>
                  </span>
                  {issue.assignees.length > 0 && (
                    <span className="issue-assignees" title={`Assigned to ${issue.assignees.join(", ")}`}>
                      {issue.assignees.slice(0, 3).map((login) => (
                        <Avatar key={login} login={login} size={18} />
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
