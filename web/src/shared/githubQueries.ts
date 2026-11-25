import { commands, type IssuesState } from "../bindings";
import { prefetchQuery, QUERY_STALE_MS } from "./queryCache";

/** The cache keys the GitHub Surfaces read through `useQuery`. Background preloading warms the
 *  same keys, so a Surface opened mid-preload joins the fetch already running. */
export const githubKeys = {
  issuesState: (projectId: number) => `p${projectId}:issues:state`,
  issueList: (projectId: number, search: string) => `p${projectId}:issues:list:${search}`,
  pullRequestList: (projectId: number, mine: boolean, search: string) => `p${projectId}:prs:list:${mine}:${search}`,
};

/** Tolerates an empty answer: a background preload must never throw. */
function isReady(state: IssuesState | null | undefined): boolean {
  return state?.availability === "ready";
}

/** Warms a Project's Issues readiness and, only once the GitHub CLI is ready, the default Issues
 *  and Pull requests lists, so the right dock opens on live data. Silent: a missing or logged-out
 *  `gh` or a non-GitHub repository shows nothing until the user opens a Surface. Cached entries
 *  younger than the Surfaces' staleness window are reused, not fetched again. */
export async function preloadGithub(projectId: number): Promise<void> {
  const options = { staleMs: QUERY_STALE_MS };
  const state = await prefetchQuery(githubKeys.issuesState(projectId), () => commands.issuesState(projectId), {
    ...options,
    // Not ready yet: the user may log in before opening a Surface, so it checks again.
    trust: (state) => isReady(state),
  });
  if (state.status !== "ok" || !isReady(state.data)) return;
  await Promise.all([
    prefetchQuery(githubKeys.issueList(projectId, ""), () => commands.listIssues(projectId, false, false, ""), options),
    prefetchQuery(githubKeys.pullRequestList(projectId, false, ""), () => commands.listPullRequests(projectId, false, ""), options),
  ]);
}
