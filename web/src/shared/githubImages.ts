/** Images embedded in issues and pull requests, read through Core (`fetchGithubImage`) as
 *  `data:` URLs, so the webview never loads a remote image itself and its CSP stays as it is. */

import { commands } from "../bindings";
import { LruCache } from "./lru";

/** Core's `IMAGE_HOSTS` without `github.com`; a test in `image.rs` keeps the two equal. */
const HOSTS = new Set([
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "camo.githubusercontent.com",
  "avatars.githubusercontent.com",
  "objects.githubusercontent.com",
  "media.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** Whether Core would read `url`: a GitHub image host, and on `github.com` only attachments and
 *  a repository's assets and raw files. Core checks again; this only spares a refused request. */
export function isGithubImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  if (parsed.hostname === "github.com") {
    return /^\/(user-attachments\/[^/]+|[^/]+\/[^/]+\/(assets|raw)\/[^/]+)/.test(parsed.pathname);
  }
  return HOSTS.has(parsed.hostname);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuid of an asset uploaded to GitHub, from `github.com/user-attachments/assets/<uuid>` or a
 *  private repository's `github.com/<owner>/<repo>/assets/<n>/<uuid>`; what Core keys signed URLs by. */
export function githubAssetId(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return undefined;
  const segments = parsed.pathname.split("/").slice(1);
  const id =
    segments.length === 3 && segments[0] === "user-attachments" && segments[1] === "assets"
      ? segments[2]
      : segments.length === 5 && segments[2] === "assets"
        ? segments[4]
        : undefined;
  return id && UUID.test(id) ? id.toLowerCase() : undefined;
}

/** Loaded images, keyed by the URL in the Markdown rather than the short-lived signed URL, so a
 *  refreshed detail view reuses them. Sized by the length of their `data:` URLs. */
const cache = new LruCache<string, string>(48 * 1024 * 1024, (src) => src.length);

/** An image being read, shared by everyone who asked for it. */
interface Load {
  promise: Promise<string>;
  /** Callers still waiting; one without a signal never leaves. */
  consumers: number;
  /** Takes it out of the queue if it has not started; whether it did. */
  cancel: () => boolean;
}
const loading = new Map<string, Load>();

export function cachedGithubImage(url: string): string | undefined {
  return cache.get(url);
}

/** Images read from Core at once: each holds a blocking thread there and a GitHub request. */
export const MAX_IMAGE_FETCHES = 4;
let active = 0;
const waiting: { start: () => void; drop: () => void }[] = [];

/** Frees a slot by handing it to the oldest waiting task, so none can slip in between. */
function release() {
  const next = waiting.shift();
  if (next) next.start();
  else active--;
}

/** Runs `task` once fewer than `MAX_IMAGE_FETCHES` others run, oldest first. `cancel` takes it
 *  out of the queue before it starts (its promise then rejects), and does nothing after. */
function queued<T>(task: () => Promise<T>): { promise: Promise<T>; cancel: () => boolean } {
  const run = async () => {
    try {
      return await task();
    } finally {
      release();
    }
  };
  if (active < MAX_IMAGE_FETCHES) {
    active++;
    return { promise: run(), cancel: () => false };
  }
  let slot!: { start: () => void; drop: () => void };
  const turn = new Promise<void>((start, reject) => {
    slot = { start, drop: () => reject(new DOMException("No one waits for this image anymore", "AbortError")) };
    waiting.push(slot);
  });
  return {
    promise: turn.then(run),
    cancel: () => {
      const at = waiting.indexOf(slot);
      if (at < 0) return false;
      waiting.splice(at, 1);
      slot.drop();
      return true;
    },
  };
}

/** The `data:` URL of the image at `url`, read from `source` (its signed URL, when GitHub gave
 *  one). One request at a time per image, and a few at most overall; a failure is not kept, so a
 *  later view tries again. Once every caller's `signal` aborted, an image still waiting for a
 *  slot is dropped (it rejects); one already being read finishes and is cached. */
export function loadGithubImage(projectId: number, url: string, source = url, signal?: AbortSignal): Promise<string> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  let load = loading.get(url);
  if (!load) {
    const { promise, cancel } = queued(() => commands.fetchGithubImage(projectId, source));
    const created: Load = {
      consumers: 0,
      cancel,
      promise: promise
        .then((result) => {
          if (result.status === "error") throw new Error(result.error.message);
          cache.set(url, result.data);
          return result.data;
        })
        .finally(() => {
          if (loading.get(url) === created) loading.delete(url);
        }),
    };
    load = created;
    loading.set(url, load);
  }
  const shared = load;
  shared.consumers++;
  signal?.addEventListener(
    "abort",
    () => {
      shared.consumers--;
      // Dropped at once, so a viewer arriving next queues afresh rather than share the rejection.
      if (shared.consumers === 0 && shared.cancel() && loading.get(url) === shared) loading.delete(url);
    },
    { once: true },
  );
  return shared.promise;
}
