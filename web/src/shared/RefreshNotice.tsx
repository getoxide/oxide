import type { QueryState } from "./queryCache";

/**
 * A quiet note under stale GitHub data whose refresh failed. Refreshes themselves are silent: the
 * cached data stays on screen and is swapped for the new one when it lands, and an action in
 * flight shows its progress on its own button.
 */
export function RefreshNotice({ query }: { query: QueryState<unknown> }) {
  if (query.state !== "ready" || query.refreshError === undefined) return null;
  return (
    <p role="status" className="pr-notice">
      Couldn't refresh: {query.refreshError}
    </p>
  );
}
