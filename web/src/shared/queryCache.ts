import { useEffect, useReducer, useRef } from "react";
import { LruCache } from "./lru";

/** The shape every `commands.*` read returns. */
export type QueryResult<T> = { status: "ok"; data: T } | { status: "error"; error: { message: string } };

export type QueryState<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  /** `refreshing` while a background fetch runs; `refreshError` when the last refresh failed. */
  | { state: "ready"; data: T; refreshing: boolean; refreshError?: string };

interface Entry {
  data?: unknown;
  error?: string;
  /** When the last fetch settled, or when the data was written directly. */
  updatedAt?: number;
  /** The sequence number of the last direct write (`setQueryData`, `updateQuery`): a fetch
   *  started before it may not know of that change, so its result is not applied over it. */
  written?: number;
  /** Marked by `invalidateQueries` so even an unmounted entry revalidates on its next mount. */
  stale?: boolean;
  /** Fetches that failed in a row; soft polls back off while it is above zero. */
  failures?: number;
  /** The last fetch was a background one (a preload) that failed: nobody saw it fail, so a mount
   *  with nothing to show asks again and shows loading meanwhile, not that error. */
  backgroundError?: boolean;
}

/** How long cached data is trusted before a mount revalidates it in the background. */
export const QUERY_STALE_MS = 30_000;

/** The first wait before a soft poll asks again after a failure; it doubles per failure in a row. */
export const POLL_BACKOFF_BASE_MS = 5_000;
/** The longest a soft poll waits after repeated failures (a rate limit, a network outage). */
export const POLL_BACKOFF_MAX_MS = 300_000;

/** How long soft polls of an entry wait after its last failure. */
function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(POLL_BACKOFF_BASE_MS * 2 ** (failures - 1), POLL_BACKOFF_MAX_MS);
}

/** Entries kept per window session, least recently used first out. */
const ENTRY_BUDGET = 200;

let entries = new LruCache<string, Entry>(ENTRY_BUDGET, () => 1);
const inflight = new Map<string, { id: number; settled: Promise<QueryResult<unknown>> }>();
const listeners = new Map<string, Set<(invalidated: boolean) => void>>();
let sequence = 0;

function notify(key: string, invalidated = false) {
  listeners.get(key)?.forEach((l) => l(invalidated));
}

/** Whether a mount should ask again: nothing cached, invalidated, or older than the caller's
 *  threshold. A threshold of `0` (the default) always asks. */
function isStale(key: string, staleMs: number): boolean {
  const entry = entries.get(key);
  if (entry === undefined || entry.updatedAt === undefined || entry.stale === true) return true;
  if (staleMs <= 0) return true;
  return Date.now() - entry.updatedAt >= staleMs;
}

function subscribe(key: string, listener: (invalidated: boolean) => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Fetches `key`, joining a fetch already in flight unless `force`. A result is only applied if no
 *  newer fetch for the same key started meanwhile. Resolves with the outcome of the fetch it ran
 *  or joined. */
function run<T>(
  key: string,
  fetch: () => Promise<QueryResult<T>>,
  force: boolean,
  options: { background?: boolean; trust?: (data: T) => boolean } = {},
): Promise<QueryResult<T>> {
  const running = inflight.get(key);
  if (!force && running) return running.settled as Promise<QueryResult<T>>;
  const id = ++sequence;
  const settle = (result: QueryResult<T>): QueryResult<T> => {
    if (inflight.get(key)?.id !== id) return result;
    inflight.delete(key);
    const previous = entries.get(key);
    if (result.status === "ok" && previous?.written !== undefined && previous.written > id) {
      // Written meanwhile (a mutation GitHub just accepted): keep that, and ask again.
      entries.set(key, { ...previous, stale: true });
      notify(key, true);
      return result;
    }
    entries.set(
      key,
      result.status === "ok"
        ? { data: result.data, updatedAt: Date.now(), stale: options.trust && !options.trust(result.data) }
        : // Nobody asked for a background fetch, so its failure is not trusted for the staleness
          // window: the next mount asks again (e.g. once the user has logged in to `gh`).
          {
            data: previous?.data,
            error: result.error.message,
            updatedAt: Date.now(),
            stale: options.background,
            backgroundError: options.background,
            failures: (previous?.failures ?? 0) + 1,
          },
    );
    notify(key);
    return result;
  };
  const settled = fetch().then(settle, (e: unknown) => settle({ status: "error", error: { message: String(e) } }));
  inflight.set(key, { id, settled });
  notify(key);
  return settled;
}

/** How a `useQuery` fetch was asked: `poll` for a timer or focus tick, which may read less (e.g.
 *  only the first page of a GitHub timeline), false for a load, a refresh or an invalidation. */
export interface FetchAsk {
  poll: boolean;
}

/** A timer or focus tick: never overlaps a fetch already running for the key, and waits longer
 *  after each failure in a row so a rate limit or an outage is not hammered. */
function softRefresh<T>(key: string, fetch: () => Promise<QueryResult<T>>): void {
  if (inflight.has(key)) return;
  const entry = entries.get(key);
  if (entry?.failures && entry.updatedAt !== undefined && Date.now() - entry.updatedAt < backoffMs(entry.failures)) return;
  run(key, fetch, false);
}

const FULL: FetchAsk = { poll: false };
const POLL: FetchAsk = { poll: true };

/** Shows the last known result for `key` at once. By default a mount revalidates in the
 *  background; pass `staleMs` to trust cached data for that long (the GitHub surfaces do, since
 *  every fetch is a `gh` call). A changed `refresh` token is a hard ask (the user just acted), so
 *  it bypasses the threshold and any fetch in flight, and an invalidation always wins. A changed
 *  `poll` token is a soft one (a timer or focus tick): it fetches unless a fetch for the key is
 *  already running, and is the only fetch asked as a `poll`. The caller owns the refresh policy;
 *  this owns what to show meanwhile. */
export function useQuery<T>(
  key: string,
  fetch: (ask: FetchAsk) => Promise<QueryResult<T>>,
  refresh: string | number = 0,
  options: { staleMs?: number; poll?: string | number } = {},
): QueryState<T> {
  const staleMs = options.staleMs ?? 0;
  const poll = options.poll ?? 0;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const fetchRef = useRef(fetch);
  const seen = useRef<{ key: string; refresh: string | number; poll: string | number } | null>(null);
  useEffect(() => {
    fetchRef.current = fetch;
  });

  useEffect(
    () =>
      subscribe(key, (invalidated) => {
        if (invalidated) run(key, () => fetchRef.current(FULL), true);
        // A preload failed under this mounted query, which has nothing to show: ask in the
        // foreground rather than wait for a fetch nobody runs.
        else if (awaitsRetry(key) && !inflight.has(key)) run(key, () => fetchRef.current(FULL), false);
        rerender();
      }),
    [key],
  );
  useEffect(() => {
    const previous = seen.current;
    seen.current = { key, refresh, poll };
    const same = previous !== null && previous.key === key;
    // A refresh bump on the same key is the user's own change: ask again whatever the cache's age
    // or a fetch in flight. A poll bump asks again unless a fetch is running. A first mount (or a
    // new key) reuses the cache unless it has gone stale.
    const forced = same && previous.refresh !== refresh;
    const polled = same && previous.poll !== poll;
    if (forced) run(key, () => fetchRef.current(FULL), true);
    else if (polled) softRefresh(key, () => fetchRef.current(POLL));
    else if (isStale(key, staleMs)) run(key, () => fetchRef.current(FULL), false);
  }, [key, refresh, staleMs, poll]);

  const entry = entries.get(key);
  if (entry?.data !== undefined) {
    return { state: "ready", data: entry.data as T, refreshing: inflight.has(key), refreshError: entry.error };
  }
  // A failed preload is always fetched again on mount, so it shows as loading until then.
  if (entry?.error !== undefined && !awaitsRetry(key)) return { state: "error", message: entry.error };
  return { state: "loading" };
}

/** Whether `key` holds only the error of a background fetch, which a mounted query asks again. */
function awaitsRetry(key: string): boolean {
  const entry = entries.get(key);
  return entry?.backgroundError === true && entry.data === undefined;
}

/** Warms `key` in the background, under the same key and in-flight deduplication as `useQuery`:
 *  a Surface mounted meanwhile joins this fetch instead of starting its own. Fetches only when the
 *  entry is missing or older than `staleMs` and no fetch for it is running. Resolves with the
 *  outcome: the cached data when it was fresh enough, else the fetch it ran or joined. */
export function prefetchQuery<T>(
  key: string,
  fetch: () => Promise<QueryResult<T>>,
  options: {
    staleMs?: number;
    /** Whether fetched data may be reused for the staleness window. Untrusted data is still shown,
     *  but the next mount asks again: e.g. a logged-out `gh`, which the user may fix meanwhile. */
    trust?: (data: T) => boolean;
  } = {},
): Promise<QueryResult<T>> {
  const running = inflight.get(key);
  if (running) return running.settled as Promise<QueryResult<T>>;
  const entry = entries.get(key);
  if (!isStale(key, options.staleMs ?? 0) && entry?.error === undefined && entry?.data !== undefined) {
    return Promise.resolve({ status: "ok", data: entry.data as T });
  }
  return run(key, fetch, false, { background: true, trust: options.trust });
}

/** Marks every entry under `prefix` stale: mounted queries refetch now, unmounted ones on their next
 *  mount. With `drop`, the old data is discarded instead of shown meanwhile. */
export function invalidateQueries(prefix: string, options: { drop?: boolean } = {}): void {
  for (const key of entries.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (options.drop) entries.delete(key);
    else entries.set(key, { ...entries.get(key), stale: true });
  }
  for (const key of [...listeners.keys()]) if (key.startsWith(prefix)) notify(key, true);
}

/** The last known data for `key`, if any. */
export function getQueryData<T>(key: string): T | undefined {
  return entries.get(key)?.data as T | undefined;
}

/** Replaces a key's data directly, e.g. after a mutation returned the new value or a list seeded a
 *  detail view's preview. Written data counts as fresh. */
export function setQueryData<T>(key: string, data: T): void {
  entries.set(key, { data, updatedAt: Date.now(), written: ++sequence });
  notify(key);
}

/** Rewrites the data of the entry `key`, if it has any, keeping its age. */
export function updateQuery<T>(key: string, update: (data: T) => T): void {
  const entry = entries.get(key);
  if (entry?.data === undefined) return;
  entries.set(key, { ...entry, data: update(entry.data as T), written: ++sequence });
  notify(key);
}

/** Rewrites the data of every entry under `prefix`, e.g. to take a merged pull request off cached lists. */
export function updateQueries<T>(prefix: string, update: (data: T) => T): void {
  for (const key of entries.keys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = entries.get(key);
    if (entry?.data === undefined) continue;
    entries.set(key, { ...entry, data: update(entry.data as T), written: ++sequence });
    notify(key);
  }
}

/** Forgets everything (tests). */
export function clearQueryCache(): void {
  entries = new LruCache<string, Entry>(ENTRY_BUDGET, () => 1);
  inflight.clear();
}
