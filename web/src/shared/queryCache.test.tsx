// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueryCache, invalidateQueries, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_MAX_MS, prefetchQuery, QUERY_STALE_MS, setQueryData, updateQuery, useQuery, type QueryResult, type QueryState } from "./queryCache";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ok = <T,>(data: T): QueryResult<T> => ({ status: "ok", data });
const fail = (message: string): QueryResult<never> => ({ status: "error", error: { message } });
const never = <T,>() => new Promise<QueryResult<T>>(() => {});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;
let seen: QueryState<unknown>;
/** Every state a Probe committed, to catch one that flashed by. */
let history: QueryState<unknown>[] = [];

function Probe({ k, fetch, refresh = 0, staleMs, poll }: { k: string; fetch: () => Promise<QueryResult<unknown>>; refresh?: number; staleMs?: number; poll?: number }) {
  const state = useQuery(k, fetch, refresh, staleMs === undefined && poll === undefined ? undefined : { staleMs, poll });
  useEffect(() => {
    seen = state;
    history.push(state);
  });
  return null;
}
const mount = (k: string, fetch: () => Promise<QueryResult<unknown>>, refresh = 0, staleMs?: number) =>
  act(async () => root.render(<Probe k={k} fetch={fetch} refresh={refresh} staleMs={staleMs} />));
/** Mounts with a soft poll token: what the auto-refresh timer and focus bump. */
const poll = (k: string, fetch: () => Promise<QueryResult<unknown>>, token: number) =>
  act(async () => root.render(<Probe k={k} fetch={fetch} staleMs={QUERY_STALE_MS} poll={token} />));

beforeEach(() => {
  clearQueryCache();
  history = [];
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
});

describe("query cache", () => {
  it("revalidates on remount by default, while showing the cached data at once", async () => {
    await mount("k", async () => ok("one"));
    expect(seen).toMatchObject({ state: "ready", data: "one" });
    await act(() => root.unmount());

    root = createRoot(host);
    const next = deferred<QueryResult<string>>();
    const fetcher = vi.fn(() => next.promise);
    await mount("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "one", refreshing: true });
    await act(async () => next.resolve(ok("two")));
    expect(seen).toMatchObject({ state: "ready", data: "two" });
  });

  it("shows cached data on remount without asking again while inside the opt-in staleness window", async () => {
    await mount("k", async () => ok("one"));
    await act(() => root.unmount());

    root = createRoot(host);
    const fetcher = vi.fn(() => never<string>());
    await mount("k", fetcher, 0, QUERY_STALE_MS);
    expect(seen).toMatchObject({ state: "ready", data: "one", refreshing: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates silently in the background once the cached entry is older than the opt-in threshold", async () => {
    vi.useFakeTimers();
    try {
      await mount("k", async () => ok("one"), 0, QUERY_STALE_MS);
      await act(() => root.unmount());
      await act(async () => void vi.advanceTimersByTime(QUERY_STALE_MS + 1));

      root = createRoot(host);
      const next = deferred<QueryResult<string>>();
      const fetcher = vi.fn(() => next.promise);
      await mount("k", fetcher, 0, QUERY_STALE_MS);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The old data stays on screen while the refresh runs.
      expect(seen).toMatchObject({ state: "ready", data: "one", refreshing: true });
      await act(async () => next.resolve(ok("two")));
      expect(seen).toMatchObject({ state: "ready", data: "two", refreshing: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revalidate on mount while the entry is younger than the opt-in threshold", async () => {
    vi.useFakeTimers();
    try {
      await mount("k", async () => ok("one"), 0, QUERY_STALE_MS);
      await act(() => root.unmount());
      await act(async () => void vi.advanceTimersByTime(QUERY_STALE_MS - 1));

      root = createRoot(host);
      const fetcher = vi.fn(() => never<string>());
      await mount("k", fetcher, 0, QUERY_STALE_MS);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches when the caller bumps its refresh token, even while the entry is fresh", async () => {
    await mount("k", async () => ok("one"));
    const fetcher = vi.fn(async () => ok("two"));
    await mount("k", fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "two" });
  });

  it("does not let a fetch started before a write overwrite it, and asks again", async () => {
    await mount("k", async () => ok("before"));
    const stale = deferred<QueryResult<string>>();
    const fetcher = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(ok("after"));
    await mount("k", fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A mutation GitHub accepted lands while that fetch is still on its way.
    await act(async () => updateQuery<string>("k", () => "confirmed"));
    const written = history.length;
    await act(async () => stale.resolve(ok("before")));
    expect(history.slice(written).map((s) => (s.state === "ready" ? s.data : s.state))).not.toContain("before");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(seen).toMatchObject({ state: "ready", data: "after" });
  });

  it("joins an identical fetch already in flight", async () => {
    const fetcher = vi.fn(() => never<string>());
    await act(async () =>
      root.render(
        <>
          <Probe k="k" fetch={fetcher} />
          <Probe k="k" fetch={fetcher} />
        </>,
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps data and reports the failure when a refresh fails; errors only without data", async () => {
    await mount("a", async () => fail("boom"));
    expect(seen).toEqual({ state: "error", message: "boom" });

    setQueryData("b", "kept");
    const fetcher = async () => fail("later");
    await mount("b", fetcher);
    // A manual refresh asks again even though the freshly written data is not stale.
    await mount("b", fetcher, 1);
    expect(seen).toMatchObject({ state: "ready", data: "kept", refreshError: "later" });
  });

  it("never applies a result to another key", async () => {
    const slow = deferred<QueryResult<string>>();
    await mount("x", () => slow.promise);
    await mount("y", async () => ok("y"));
    expect(seen).toMatchObject({ data: "y" });
    await act(async () => slow.resolve(ok("x")));
    expect(seen).toMatchObject({ data: "y" });
  });

  it("refetches mounted queries on invalidation by prefix, and can drop data", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ok(`v${++n}`));
    await mount("p:1:list", fetcher);
    expect(seen).toMatchObject({ data: "v1" });
    await act(async () => invalidateQueries("p:1:"));
    expect(seen).toMatchObject({ data: "v2" });
    await act(async () => invalidateQueries("p:2:"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(() => root.unmount());

    invalidateQueries("p:1:", { drop: true });
    root = createRoot(host);
    await mount("p:1:list", () => never<string>());
    expect(seen.state).toBe("loading");
  });

  it("refetches an unmounted entry on its next mount after invalidation, even while fresh", async () => {
    await mount("p:1:list", async () => ok("one"));
    await act(() => root.unmount());
    invalidateQueries("p:1:");

    root = createRoot(host);
    const fetcher = vi.fn(async () => ok("two"));
    await mount("p:1:list", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "two" });
  });

  it("lets a mount join a prefetch still in flight instead of fetching again", async () => {
    const preload = deferred<QueryResult<string>>();
    const prefetched = prefetchQuery("k", () => preload.promise, { staleMs: QUERY_STALE_MS });
    const fetcher = vi.fn(() => never<string>());
    await mount("k", fetcher, 0, QUERY_STALE_MS);
    expect(fetcher).not.toHaveBeenCalled();
    expect(seen.state).toBe("loading");

    await act(async () => preload.resolve(ok("warm")));
    expect(seen).toMatchObject({ state: "ready", data: "warm" });
    await expect(prefetched).resolves.toEqual(ok("warm"));
  });

  it("does not prefetch an entry that is still fresh", async () => {
    await prefetchQuery("k", async () => ok("one"), { staleMs: QUERY_STALE_MS });
    const fetcher = vi.fn(() => never<string>());
    await expect(prefetchQuery("k", fetcher, { staleMs: QUERY_STALE_MS })).resolves.toEqual(ok("one"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not trap a later mount behind a failed background prefetch", async () => {
    await prefetchQuery("k", async () => fail("gh is not logged in"), { staleMs: QUERY_STALE_MS });
    const fetcher = vi.fn(async () => ok("after login"));
    await mount("k", fetcher, 0, QUERY_STALE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "after login" });
  });

  it("shows loading, never the background failure, while a mount asks again after a failed prefetch", async () => {
    await prefetchQuery("k", async () => fail("gh is not logged in"), { staleMs: QUERY_STALE_MS });
    const retry = deferred<QueryResult<string>>();
    await mount("k", () => retry.promise, 0, QUERY_STALE_MS);
    expect(seen.state).toBe("loading");
    await act(async () => retry.resolve(ok("after login")));
    expect(seen).toMatchObject({ state: "ready", data: "after login" });
    expect(history.map((s) => s.state)).not.toContain("error");
  });

  it("asks again when a background prefetch fails under a mounted query with nothing to show", async () => {
    const first = deferred<QueryResult<string>>();
    await mount("k", () => first.promise, 0, QUERY_STALE_MS);
    await act(async () => first.resolve(fail("offline")));
    expect(seen).toMatchObject({ state: "error", message: "offline" });

    const fetcher = vi.fn(async () => fail("still offline"));
    await mount("k", fetcher, 0, QUERY_STALE_MS);
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => void (await prefetchQuery("k", async () => fail("offline"), { staleMs: QUERY_STALE_MS })));
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The mounted query does not wait for a fetch nobody runs: it asked itself, and shows that answer.
    expect(seen).toMatchObject({ state: "error", message: "still offline" });
  });

  it("lets a mount ask again when a prefetch returned data the caller does not trust", async () => {
    await prefetchQuery("k", async () => ok({ availability: "loggedOut" }), {
      staleMs: QUERY_STALE_MS,
      trust: (data) => data.availability === "ready",
    });
    const fetcher = vi.fn(async () => ok({ availability: "ready" }));
    await mount("k", fetcher, 0, QUERY_STALE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: { availability: "ready" } });
  });

  it("skips a soft poll while a fetch for the key is still in flight, and polls once it settled", async () => {
    const slow = deferred<QueryResult<string>>();
    const fetcher = vi.fn(() => slow.promise);
    await poll("k", fetcher, 0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await poll("k", fetcher, 1);
    await poll("k", fetcher, 2);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => slow.resolve(ok("one")));
    const next = vi.fn(async () => ok("two"));
    await poll("k", next, 3);
    expect(next).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "two" });
  });

  it("backs soft polls off exponentially after consecutive failures, capped, until one succeeds", async () => {
    vi.useFakeTimers();
    try {
      let token = 0;
      const failing = vi.fn(async () => fail("API rate limit exceeded"));
      await poll("k", failing, token);
      expect(failing).toHaveBeenCalledTimes(1);

      // One failure: polls wait one base step.
      await poll("k", failing, ++token);
      expect(failing).toHaveBeenCalledTimes(1);
      await act(async () => void vi.advanceTimersByTime(POLL_BACKOFF_BASE_MS));
      await poll("k", failing, ++token);
      expect(failing).toHaveBeenCalledTimes(2);

      // Two failures: the wait doubles.
      await act(async () => void vi.advanceTimersByTime(POLL_BACKOFF_BASE_MS));
      await poll("k", failing, ++token);
      expect(failing).toHaveBeenCalledTimes(2);
      await act(async () => void vi.advanceTimersByTime(POLL_BACKOFF_BASE_MS));
      await poll("k", failing, ++token);
      expect(failing).toHaveBeenCalledTimes(3);

      // Many failures: never longer than the cap.
      for (let i = 0; i < 20; i++) {
        await act(async () => void vi.advanceTimersByTime(POLL_BACKOFF_MAX_MS));
        await poll("k", failing, ++token);
      }
      const calls = failing.mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(POLL_BACKOFF_MAX_MS));
      await poll("k", failing, ++token);
      expect(failing).toHaveBeenCalledTimes(calls + 1);

      // A success resets it: the next poll goes straight through.
      const healthy = vi.fn(async () => ok("back"));
      await act(async () => void vi.advanceTimersByTime(POLL_BACKOFF_MAX_MS));
      await poll("k", healthy, ++token);
      await poll("k", healthy, ++token);
      expect(healthy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold the user's own refresh back while polls back off", async () => {
    await poll("k", async () => fail("offline"), 0);
    const fetcher = vi.fn(async () => ok("fresh"));
    await act(async () => root.render(<Probe k="k" fetch={fetcher} staleMs={QUERY_STALE_MS} poll={0} refresh={1} />));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "fresh" });
  });

  it("stays bounded", async () => {
    for (let i = 0; i < 1000; i++) setQueryData(`k${i}`, i);
    await mount("k0", () => never<number>());
    expect(seen.state).toBe("loading");
  });
});
