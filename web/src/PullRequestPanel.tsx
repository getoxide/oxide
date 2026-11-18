import { PullRequestBrowser } from "./PullRequestBrowser";
import { REFRESH_INTERVAL_MS, useAutoRefresh } from "./useAutoRefresh";

export { REFRESH_INTERVAL_MS };

export interface PullRequestPanelProps {
  projectId: number;
  /** Changes after the user's own changes (a merge, a new pull request), which refresh the panel. */
  refreshKey: number;
  /** Called after a pull request was created or merged, so other views reload. */
  onChanged: () => void;
}

/** The repository's open pull requests on GitHub, through `gh`. It loads when opened, after the
 *  user's own changes, when the window regains focus, and periodically while visible.
 *  State belongs to one Project, so a different one remounts it. */
export function PullRequestPanel(props: PullRequestPanelProps) {
  return <PullRequestViews key={props.projectId} {...props} />;
}

function PullRequestViews(props: PullRequestPanelProps) {
  const tick = useAutoRefresh();
  return (
    <div className="pr-views">
      <section className="pr-panel pr-panel-flush" aria-label="Pull requests">
        <PullRequestBrowser {...props} refreshKey={props.refreshKey + tick} />
      </section>
    </div>
  );
}
