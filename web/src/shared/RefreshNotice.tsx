import { SyncIcon } from "@primer/octicons-react";
import type { QueryState } from "./queryCache";

/**
 * A small spinner while GitHub data is being fetched again (after a change, or a background
 * refresh), and a note under stale data whose refresh failed. `working` adds a change still being
 * sent, so the spinner starts the moment an action does and only stops once the new state is in.
 */
export function RefreshNotice({ query, working = false }: { query: QueryState<unknown>; working?: boolean }) {
  const refreshing = working || (query.state === "ready" && query.refreshing);
  return (
    <>
      {refreshing && (
        <div className="refresh-anchor">
          <span className="refresh-spinner" role="status" aria-label="Updating from GitHub" title="Updating from GitHub…">
            <SyncIcon size={12} className="spin" />
          </span>
        </div>
      )}
      {query.state === "ready" && query.refreshError !== undefined && (
        <p role="status" className="pr-notice">
          Couldn't refresh: {query.refreshError}
        </p>
      )}
    </>
  );
}
