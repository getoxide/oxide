import { PullRequestBrowser } from "./PullRequestBrowser";
import { REFRESH_INTERVAL_MS, useAutoRefresh } from "../shared/useAutoRefresh";

export { REFRESH_INTERVAL_MS };

export interface PullRequestPanelProps {
  projectId: number;
  /** Changes after the user's own changes (a merge, a new pull request), which refresh the panel. */
  refreshKey: number;
  /** Whether the Surface is shown (the dock is open on it). Hidden, it stops polling GitHub. */
  active?: boolean;
  /** Called after a pull request was created or merged, so other views reload. */
  onChanged: () => void;
}

/** The repository's open pull requests on GitHub, through `gh`. It loads when opened, and reloads
 *  silently after the user's own changes, when the window regains focus or the Surface is shown
 *  again, and periodically while it is shown. State belongs to one Project, so a different one
 *  remounts it. */
export function PullRequestPanel(props: PullRequestPanelProps) {
  return <PullRequestViews key={props.projectId} {...props} />;
}

function PullRequestViews({ active = true, ...props }: PullRequestPanelProps) {
  const poll = useAutoRefresh({ enabled: active });
  return (
    <div className="pr-views">
      <section className="pr-panel pr-panel-flush" aria-label="Pull requests">
        <PullRequestBrowser {...props} active={active} pollKey={poll} />
      </section>
    </div>
  );
}
