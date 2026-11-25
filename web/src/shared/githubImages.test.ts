import { afterEach, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { githubAssetId, isGithubImageUrl, loadGithubImage, MAX_IMAGE_FETCHES } from "./githubImages";

afterEach(() => vi.restoreAllMocks());

const PNG = "data:image/png;base64,iVBORw0KGgo=";

it("reads at most a few images from Core at once and starts the next as one settles", async () => {
  const settle: (() => void)[] = [];
  const fetch = vi.spyOn(commands, "fetchGithubImage").mockImplementation(
    () => new Promise((resolve) => settle.push(() => resolve({ status: "ok", data: PNG }))),
  );
  const urls = Array.from({ length: MAX_IMAGE_FETCHES + 2 }, (_, i) => `https://user-images.githubusercontent.com/1/queue-${i}.png`);
  const loads = urls.map((url) => loadGithubImage(1, url));
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(MAX_IMAGE_FETCHES);

  settle[0]();
  await loads[0];
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(MAX_IMAGE_FETCHES + 1));

  for (let i = 1; i < urls.length; i++) {
    await vi.waitFor(() => expect(settle.length).toBeGreaterThan(i));
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(i + MAX_IMAGE_FETCHES);
    settle[i]();
  }
  expect(await Promise.all(loads)).toEqual(urls.map(() => PNG));
});

it("frees its slot when Core refuses an image", async () => {
  const fetch = vi.spyOn(commands, "fetchGithubImage").mockResolvedValue({ status: "error", error: { message: "no" } });
  const urls = Array.from({ length: MAX_IMAGE_FETCHES + 1 }, (_, i) => `https://user-images.githubusercontent.com/1/refused-${i}.png`);
  const results = await Promise.allSettled(urls.map((url) => loadGithubImage(1, url)));
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(urls.length);
});

it("drops a queued image whose every viewer has gone before it started, keeping the cap", async () => {
  const settle: (() => void)[] = [];
  const fetch = vi.spyOn(commands, "fetchGithubImage").mockImplementation(
    () => new Promise((resolve) => settle.push(() => resolve({ status: "ok", data: PNG }))),
  );
  const url = (name: string) => `https://user-images.githubusercontent.com/1/abort-${name}.png`;
  const busy = Array.from({ length: MAX_IMAGE_FETCHES }, (_, i) => loadGithubImage(1, url(`busy-${i}`)));
  const gone = new AbortController();
  const stays = new AbortController();
  const dropped = loadGithubImage(1, url("gone"), url("gone"), gone.signal);
  const shared = [loadGithubImage(1, url("shared"), url("shared"), gone.signal), loadGithubImage(1, url("shared"), url("shared"), stays.signal)];
  const later = loadGithubImage(1, url("later"));
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(MAX_IMAGE_FETCHES);

  gone.abort();
  await expect(dropped).rejects.toThrow();
  settle[0]();
  settle[1]();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(MAX_IMAGE_FETCHES + 2));
  // The image nobody waits for anymore never reached Core; one still watched did.
  const asked = fetch.mock.calls.map((c) => c[1]);
  expect(asked).not.toContain(url("gone"));
  expect(asked.slice(MAX_IMAGE_FETCHES)).toEqual([url("shared"), url("later")]);
  settle.slice(2).forEach((s) => s());
  expect(await Promise.all([...busy, ...shared, later])).toHaveLength(MAX_IMAGE_FETCHES + 3);
});

it("names an uploaded asset by its uuid in both of GitHub's URL forms", () => {
  const id = "84ccda0a-5c4a-4fe4-b897-ed3f90e852b2";
  expect(githubAssetId(`https://github.com/user-attachments/assets/${id}`)).toBe(id);
  expect(githubAssetId(`https://github.com/fake/repo/assets/12/${id}`)).toBe(id);
  expect(githubAssetId(`https://github.com/fake/repo/assets/12/not-a-uuid`)).toBeUndefined();
  expect(githubAssetId(`https://evil.example/user-attachments/assets/${id}`)).toBeUndefined();
  expect(isGithubImageUrl(`https://github.com/fake/repo/assets/12/${id}`)).toBe(true);
});
