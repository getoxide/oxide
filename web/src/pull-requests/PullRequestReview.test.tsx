// @vitest-environment jsdom
import { act } from "react";
import { clearQueryCache } from "../shared/queryCache";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type PullRequestDetail_Serialize } from "../bindings";
import { CHECKS_REFRESH_MS, PullRequestReview } from "./PullRequestBrowser";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const onChanged = vi.fn();
const onBack = vi.fn();

function detail(overrides: Partial<PullRequestDetail_Serialize> = {}): PullRequestDetail_Serialize {
  return {
    pullRequest: {
      number: 174,
      title: "chore(deps): bump react-virtual",
      url: "https://github.com/me/oxide/pull/174",
      draft: false,
      base: "main",
      head: "dependabot/npm/react-virtual",
      crossRepository: false,
      author: "app/dependabot",
      createdAt: "2026-10-27T08:00:00Z",
    },
    phase: "open",
    body: "Bumps react-virtual.\n\nUpdates from 3.14.21 to 3.14.22",
    headSha: "abc123",
    checks: [
      { name: "web", state: "failure", url: "https://github.com/me/oxide/actions/runs/1", required: true },
      { name: "rust", state: "success", url: null, required: false },
    ],
    comments: [
      { id: null, author: "bob", body: "Rename this", createdAt: "2026-10-27T10:00:00Z", review: "changesRequested" },
      { id: "c1", author: "app/dependabot", body: "Rebased", createdAt: "2026-10-27T11:00:00Z", review: null },
    ],
    mergeState: "clean",
    reviewDecision: null,
    reviewers: [{ login: "bob", state: "changesRequested" }],
    assignees: [],
    labels: [{ name: "dependencies", color: "0366d6" }],
    additions: 10,
    deletions: 4,
    viewer: "me",
    mergeMethods: ["merge", "squash", "rebase"],
    defaultMergeMethod: "squash",
    deleteBranchOnMerge: false,
    changedFiles: 3,
    ...overrides,
  };
}

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "pullRequestDetail").mockResolvedValue({ status: "ok", data: detail() });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  onChanged.mockReset();
  onBack.mockReset();
});

async function render(props: { active?: boolean } = {}) {
  await act(async () =>
    root.render(<PullRequestReview projectId={1} number={174} refreshKey={0} {...props} onBack={onBack} onChanged={onChanged} />),
  );
}
const button = (name: string | RegExp) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    typeof name === "string" ? b.textContent?.trim() === name || b.getAttribute("aria-label") === name : name.test(`${b.textContent} ${b.getAttribute("aria-label")}`),
  )!;
const click = (el: HTMLElement) => act(async () => el.click());

it("renders a cached pull request at once on remount without asking GitHub again while fresh", async () => {
  await render();
  expect(host.textContent).toContain("chore(deps): bump react-virtual");
  await act(() => root.unmount());

  root = createRoot(host);
  await render();
  expect(host.querySelector(".skeleton")).toBeNull();
  expect(host.textContent).toContain("chore(deps): bump react-virtual");
  expect(vi.mocked(commands.pullRequestDetail)).toHaveBeenCalledTimes(1);
});

it("renders the changed file count from changedFiles in singular and plural form", async () => {
  await render();
  expect(host.querySelector(".pr-diffstat-files")?.textContent).toContain("in 3 files");

  await act(() => root.unmount());
  clearQueryCache();
  root = createRoot(host);
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ changedFiles: 1 }),
  });
  await render();
  expect(host.querySelector(".pr-diffstat-files")?.textContent).toContain("in 1 file");
});

it("shows the author's avatar, an Open on GitHub button, and opens the pull request there", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await render();
  const avatar = host.querySelector<HTMLImageElement>(".pr-hero-meta img.avatar")!;
  expect(avatar.src).toBe("https://github.com/dependabot.png?size=40");
  await click(button("Open on GitHub"));
  expect(open).toHaveBeenCalledWith("https://github.com/me/oxide/pull/174");
});

it("copies the pull request URL with confirmation feedback and surfaces clipboard errors", async () => {
  const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await render();

  const copyBtn = host.querySelector<HTMLButtonElement>('.pr-nav button[aria-label="Copy link"]');
  expect(copyBtn).not.toBeNull();

  await click(copyBtn!);
  expect(writeText).toHaveBeenCalledWith("https://github.com/me/oxide/pull/174");
  expect(copyBtn!.getAttribute("data-copied")).toBe("true");
  expect(host.querySelector('.pr-nav [role="status"]')?.textContent).toContain("Copied");

  writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
  await click(copyBtn!);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Clipboard blocked");
});

it("folds the description away and reads all of it when opened", async () => {
  await render();
  expect(host.querySelector(".pr-description .md")).toBeNull();
  await click(button(/Description/));
  expect(host.querySelector(".pr-description .md")!.textContent).toContain("Updates from 3.14.21 to 3.14.22");
});

it("opens a failing check's run on GitHub", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await render();
  await click(button(/web: Failed/));
  expect(open).toHaveBeenCalledWith("https://github.com/me/oxide/actions/runs/1");
});

it("lists conflicts and offers no merge while the branch conflicts", async () => {
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: detail({ mergeState: "conflicting", checks: [] }) });
  await render();
  expect(host.querySelector('[aria-label="Merge status"]')!.textContent).toContain("conflicts that must be resolved");
  expect(button(/Squash and merge/).disabled).toBe(true);
});

it("offers no merge while GitHub's branch policy blocks it, e.g. required checks still running", async () => {
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ mergeState: "blocked", checks: [{ name: "web", state: "pending", url: null, required: false }] }),
  });
  await render();
  expect(button(/Squash and merge/).disabled).toBe(true);
});

it("turns on auto-merge while the checks run, and only then offers it", async () => {
  const merge = vi.spyOn(commands, "mergePullRequest").mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ mergeState: "blocked", checks: [{ name: "web", state: "pending", url: null, required: false }] }),
  });
  await render();
  await click(button(/Merge when ready/));
  expect(merge).toHaveBeenCalledWith(1, 174, "squash", false, true);
  expect(button(/Auto-merge on/).disabled).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
});

it("does not offer auto-merge when nothing is waiting", async () => {
  await render();
  expect([...host.querySelectorAll("button")].some((b) => /Merge when ready/.test(b.textContent ?? ""))).toBe(false);
});

it("preselects the merge method GitHub's own merge box would, not the first allowed", async () => {
  const merge = vi.spyOn(commands, "mergePullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  expect(button(/and merge|merge commit/).textContent).toContain("Squash and merge");
  await click(button(/Squash and merge/));
  expect(merge).toHaveBeenCalledWith(1, 174, "squash", false, false);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("keeps the merge button coloured while merging, shows the PR merged checkmark, then returns to the list", async () => {
  vi.useFakeTimers();
  try {
    let finish!: () => void;
    vi.spyOn(commands, "mergePullRequest").mockReturnValue(
      new Promise((resolve) => (finish = () => resolve({ status: "ok", data: null }))),
    );
    await render();
    await click(button(/Squash and merge/));
    const merging = button(/Merging/);
    expect(merging.disabled).toBe(true);
    expect(merging.classList.contains("pending")).toBe(true);
    await act(async () => finish());
    expect(host.querySelector(".pr-merged-overlay")?.textContent).toContain("PR merged");
    expect(host.querySelector(".pr-merged-check")).not.toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(onBack).toHaveBeenCalledWith("merged");
  } finally {
    vi.useRealTimers();
  }
});

it("closes a pull request without merging it, then returns to the list", async () => {
  const close = vi.spyOn(commands, "closePullRequest").mockResolvedValue({ status: "ok", data: null });
  const merge = vi.spyOn(commands, "mergePullRequest");
  await render();
  await click(button(/^\s*Close /));
  expect(close).toHaveBeenCalledWith(1, 174);
  expect(merge).not.toHaveBeenCalled();
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onBack).toHaveBeenCalledWith("closed");
});

it("stays on the pull request and shows the error when closing fails", async () => {
  vi.spyOn(commands, "closePullRequest").mockResolvedValue({
    status: "error",
    error: { message: "Could not close" } as never,
  });
  await render();
  await click(button(/^\s*Close /));
  expect(host.querySelector(".pr-outcome")).toBeNull();
  expect(host.querySelector(".pr-error")!.textContent).toContain("Could not close");
  expect(onBack).not.toHaveBeenCalled();
});

it("keeps 'delete branch' in the merge options and sends the choice with the merge", async () => {
  const merge = vi.spyOn(commands, "mergePullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await click(button("Merge options"));
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(button(/Squash and merge/));
  expect(merge).toHaveBeenCalledWith(1, 174, "squash", true, false);
});

it("takes a draft out of draft with one button", async () => {
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ phase: "draft", pullRequest: { ...detail().pullRequest, draft: true } }),
  });
  const ready = vi.spyOn(commands, "setPullRequestDraft").mockResolvedValue({ status: "ok", data: null });
  await render();
  expect(host.textContent).toContain("This pull request is still a draft");
  expect(host.querySelector(".pr-merge .primary")!.textContent).toBe("Ready for review");
  await click(host.querySelector<HTMLButtonElement>(".pr-merge .primary")!);
  expect(ready).toHaveBeenCalledWith(1, 174, false);
  expect(commands.pullRequestDetail).toHaveBeenCalledTimes(2);
});

it("shows who reviews, who is assigned and labels, and assigns the viewer in one click", async () => {
  const edit = vi.spyOn(commands, "editPullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  const details = host.querySelector('[aria-label="Details"]')!;
  expect(details.textContent).toContain("bob");
  expect(details.querySelector('[aria-label="Requested changes"]')).not.toBeNull();
  expect(details.textContent).toContain("dependencies");
  await click(button("assign yourself"));
  expect(edit).toHaveBeenCalledWith(1, 174, expect.objectContaining({ addAssignees: ["me"], removeAssignees: [] }));
});

it("picks reviewers from the repository's people, without the author", async () => {
  vi.spyOn(commands, "pullRequestCandidates").mockResolvedValue({
    status: "ok",
    data: { users: ["ana", "app/dependabot", "bob"], labels: [] },
  });
  const edit = vi.spyOn(commands, "editPullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  await click(button("Edit reviewers"));
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  expect(options.map((o) => o.textContent)).toEqual(["ana", "bob"]);
  await click(options[0].querySelector("button")!);
  expect(edit).toHaveBeenCalledWith(1, 174, expect.objectContaining({ addReviewers: ["ana"] }));
});

it("reads the conversation like the web: avatar, name, what they did and when", async () => {
  await render();
  const entries = Array.from(host.querySelectorAll(".pr-entry"));
  expect(entries).toHaveLength(2);
  expect(entries[0].querySelector("img.avatar")).not.toBeNull();
  expect(entries[0].querySelector("header")!.textContent).toContain("bob");
  expect(entries[0].querySelector("header")!.textContent).toContain("requested changes");
  expect(entries[1].querySelector("header")!.textContent).toContain("Author");
});

it("reloads sooner while checks are still running, and stops once they are done", async () => {
  vi.useFakeTimers();
  try {
    const running = detail({ checks: [{ name: "rust", state: "pending", url: null, required: false }] });
    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: running });
    await render();
    const calls = vi.mocked(commands.pullRequestDetail).mock.calls.length;
    await act(async () => void vi.advanceTimersByTime(CHECKS_REFRESH_MS));
    expect(vi.mocked(commands.pullRequestDetail).mock.calls.length).toBeGreaterThan(calls);

    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: detail() });
    await act(async () => void vi.advanceTimersByTime(CHECKS_REFRESH_MS));
    const settled = vi.mocked(commands.pullRequestDetail).mock.calls.length;
    await act(async () => void vi.advanceTimersByTime(CHECKS_REFRESH_MS * 3));
    expect(vi.mocked(commands.pullRequestDetail).mock.calls.length).toBe(settled);
  } finally {
    vi.useRealTimers();
  }
});

const detailCalls = () => vi.mocked(commands.pullRequestDetail).mock.calls.length;
/** One check interval at a time, letting each poll's `gh` call settle before the next tick. */
async function tickChecks(times = 1) {
  for (let i = 0; i < times; i++) await act(async () => void vi.advanceTimersByTime(CHECKS_REFRESH_MS));
}
const running = () => detail({ checks: [{ name: "rust", state: "pending", url: null, required: false }] });

it("follows a pull request closely while GitHub is still settling its merge state", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: detail({ mergeState: "unknown" }) });
    await render();
    const calls = detailCalls();
    await tickChecks();
    expect(detailCalls()).toBe(calls + 1);
  } finally {
    vi.useRealTimers();
  }
});

it("does not follow running checks while the Surface is hidden, and catches up when shown", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: running() });
    await render({ active: false });
    const calls = detailCalls();
    await tickChecks(5);
    expect(detailCalls()).toBe(calls);
    await render({ active: true });
    expect(detailCalls()).toBe(calls + 1);
  } finally {
    vi.useRealTimers();
  }
});

it("never starts a check poll while the previous one is still in flight", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: running() });
    await render();
    const calls = detailCalls();
    vi.mocked(commands.pullRequestDetail).mockImplementation(() => new Promise(() => {}));
    await tickChecks(4);
    expect(detailCalls()).toBe(calls + 1);
    // The pull request stays on screen, with no spinner pill, while the slow call runs.
    expect(host.textContent).toContain("chore(deps): bump react-virtual");
    expect(host.querySelector(".refresh-spinner")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("backs check polls off while GitHub keeps failing, and keeps the pull request with a notice", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: running() });
    await render();
    const calls = detailCalls();
    vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "error", error: { message: "API rate limit exceeded" } });
    await tickChecks(20);
    // 20 ticks, but each failure in a row doubles the wait before the next poll.
    expect(detailCalls() - calls).toBeLessThan(8);
    expect(detailCalls() - calls).toBeGreaterThan(1);
    expect(host.textContent).toContain("chore(deps): bump react-virtual");
    expect(host.textContent).toContain("Couldn't refresh: API rate limit exceeded");
  } finally {
    vi.useRealTimers();
  }
});

it("places the loading preview header inside .pr-scroll so it shares the review padding", async () => {
  vi.spyOn(commands, "pullRequestDetail").mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(
    <PullRequestReview
      projectId={1}
      number={174}
      refreshKey={0}
      onBack={onBack}
      onChanged={onChanged}
    />,
  ));
  const scroll = host.querySelector(".pr-review .pr-scroll");
  expect(scroll).not.toBeNull();
  expect(scroll!.querySelector('.skeleton[role="status"]')).not.toBeNull();
});
