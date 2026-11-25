// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type IssueDetail_Serialize as IssueDetail, type IssueSummary } from "../bindings";
import { IssuesSurface } from "./IssuesSurface";
import { clearQueryCache, QUERY_STALE_MS } from "../shared/queryCache";
import { REFRESH_INTERVAL_MS, REVALIDATE_AFTER_MS } from "../shared/useAutoRefresh";
import { preloadGithub } from "../shared/githubQueries";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Focus after the last tick went stale, which is when focus asks GitHub again. */
async function focusLater() {
  const faked = vi.isFakeTimers();
  if (!faked) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + REVALIDATE_AFTER_MS);
  await act(async () => void window.dispatchEvent(new Event("focus")));
  if (!faked) vi.useRealTimers();
}
let host: HTMLDivElement;
let root: Root;

const summary = (over: Partial<IssueSummary> = {}): IssueSummary => ({
  number: 7,
  title: "Crash on startup",
  state: "OPEN",
  stateReason: "",
  author: "alice",
  url: "https://github.com/fake/repo/issues/7",
  commentsCount: 2,
  createdAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["bob"],
  ...over,
});

const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  ...summary(),
  body: "It **crashes**.",
  comments: [],
  viewer: "me",
  nodeId: "I_7",
  participants: [],
  timeline: [],
  ...over,
});

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "issuesState").mockResolvedValue({
    status: "ok",
    data: { availability: "ready", guidance: null },
  });
  vi.spyOn(commands, "issueTemplates").mockResolvedValue({ status: "ok", data: [] });
  vi.spyOn(commands, "listIssues").mockResolvedValue({ status: "ok", data: [summary()] });
  vi.spyOn(commands, "issueDetail").mockResolvedValue({ status: "ok", data: detail() });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (active = true) => act(async () => root.render(<IssuesSurface projectId={1} active={active} />));
const listCalls = () => vi.mocked(commands.listIssues).mock.calls.length;
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

it("joins the background preload when opened mid-preload instead of asking gh again", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  vi.mocked(commands.listIssues).mockImplementation(async () => {
    await gate;
    return { status: "ok", data: [summary()] };
  });
  const preload = preloadGithub(1);
  await act(async () => { await Promise.resolve(); });
  await render();
  await act(async () => { finish(); await preload; });

  expect(host.textContent).toContain("Crash on startup");
  expect(commands.issuesState).toHaveBeenCalledTimes(1);
  expect(listCalls()).toBe(1);
});

it("lists issues with a full-width search and New issue, and no Refresh or Search button", async () => {
  await render();
  expect(host.querySelector('input[aria-label="Search issues"]')).not.toBeNull();
  expect(button("New issue")).toBeDefined();
  expect(button("Refresh")).toBeUndefined();
  expect(button("Search")).toBeUndefined();
  expect(host.textContent).toContain("Crash on startup");
  expect(host.textContent).toContain("bug");
});

it("puts search in the Surface toolbar and has no state, Mine or scope rows", async () => {
  await render();
  const toolbar = host.querySelector(".surface-toolbar")!;
  expect(toolbar.querySelector('input[aria-label="Search issues"]')).not.toBeNull();
  expect([...toolbar.querySelectorAll("button")].some((b) => b.textContent?.trim() === "New issue")).toBe(true);
  expect(host.querySelector('[role="group"][aria-label="State"]')).toBeNull();
  expect(host.querySelector(".surface-secondary")).toBeNull();
  expect(host.querySelector(".pr-scope-title")).toBeNull();
  expect(button("Mine")).toBeUndefined();
});

it("shows an empty issue list on the shared Surface empty layout, with its primary action", async () => {
  vi.mocked(commands.listIssues).mockResolvedValue({ status: "ok", data: [] });
  await render();

  const empty = host.querySelector<HTMLElement>(".pr-empty")!;
  expect(empty).not.toBeNull();
  expect(empty.classList.contains("surface-empty")).toBe(true);
  // It sits directly in the Surface's scroll region as its only content, so it can fill and centre
  // the available height; the list is not rendered beside it.
  const scroll = empty.parentElement!;
  expect(scroll.classList.contains("pr-scroll")).toBe(true);
  expect(scroll.querySelector(".pr-list")).toBeNull();
  expect(empty.querySelector("svg")?.getAttribute("width")).toBe("32");
  expect(empty.querySelector(".surface-empty-title")?.textContent).toBe("No open issues.");
  expect(empty.querySelector(".surface-empty-description")?.textContent).toBe("Issues opened in this Project’s repository appear here.");

  const create = [...empty.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New issue")!;
  expect(create).toBeDefined();
  expect(create.classList.contains("primary")).toBe(true);
  await act(async () => create.click());
  expect(host.querySelector('section[aria-label="Details"]')).not.toBeNull();
});

it("clears the issue search with Escape and restores the unfiltered list", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(commands.listIssues).mockImplementation(async (_projectId, _closed, _mine, search) => ({
      status: "ok",
      data: search ? [] : [summary()],
    }));
    await render();
    expect(host.textContent).toContain("Crash on startup");
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, "parser");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void vi.advanceTimersByTime(500));
    expect(host.textContent).not.toContain("Crash on startup");

    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(input.value).toBe("");
    expect(host.textContent).toContain("Crash on startup");
  } finally {
    vi.useRealTimers();
  }
});

it("opens the issue form from New issue", async () => {
  await render();
  await act(async () => button("New issue").click());
  await vi.waitFor(() => expect(host.querySelector(".issue-create h3")?.textContent).toBe("New issue"));
});

it("reloads by itself on focus and on a timer while visible", async () => {
  vi.useFakeTimers();
  try {
    await render();
    let calls = listCalls();
    await focusLater();
    expect(listCalls()).toBeGreaterThan(calls);
    calls = listCalls();
    await act(async () => void vi.advanceTimersByTime(REFRESH_INTERVAL_MS));
    expect(listCalls()).toBeGreaterThan(calls);
  } finally {
    vi.useRealTimers();
  }
});

it("searches as you type, after a short pause", async () => {
  vi.useFakeTimers();
  try {
    await render();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, "parser");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(commands.listIssues).not.toHaveBeenLastCalledWith(1, false, false, "parser");
    await act(async () => void vi.advanceTimersByTime(500));
    expect(commands.listIssues).toHaveBeenLastCalledWith(1, false, false, "parser");
  } finally {
    vi.useRealTimers();
  }
});

it("opens an issue and offers to close it, with the comment going along", async () => {
  vi.spyOn(commands, "closeIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  expect(host.textContent).toContain("Crash on startup");
  expect(host.querySelector('[aria-label="Edit title"]')).not.toBeNull();
  await act(async () => button("Close as completed").click());
  expect(commands.closeIssue).toHaveBeenCalledWith(1, 7, "completed", "");
});

it("interleaves activity with comments in the issue Conversation and opens references through the link flow", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.issueDetail).mockResolvedValue({
    status: "ok",
    data: detail({
      timeline: [
        { kind: "labeled", actor: "alice", createdAt: "2026-01-01T01:00:00Z", label: { name: "bug", color: "d73a4a" } },
        { kind: "assigned", actor: "alice", createdAt: "2026-01-01T02:00:00Z", login: "bob" },
        { kind: "comment", id: "IC_1", author: "me", body: "On it", createdAt: "2026-01-01T03:00:00Z" },
        { kind: "renamed", actor: "alice", createdAt: "2026-01-01T04:00:00Z", from: "Crash", to: "Crash on startup" },
        {
          kind: "crossReferenced", actor: "erin", createdAt: "2026-01-01T05:00:00Z", number: 9, title: "Fix the crash",
          url: "https://github.com/other/repo/pull/9", state: "MERGED", pullRequest: true, repository: "other/repo", crossRepository: true,
        },
        { kind: "closed", actor: "bob", createdAt: "2026-01-01T06:00:00Z", stateReason: "NOT_PLANNED" },
        { kind: "reopened", actor: "alice", createdAt: "2026-01-01T07:00:00Z" },
      ],
    }),
  });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());

  const conversation = host.querySelector('section[aria-label="Conversation"]')!;
  const rows = [...conversation.querySelectorAll(".pr-timeline-event, .pr-entry")].map((r) => r.textContent ?? "");
  expect(rows).toHaveLength(7);
  expect(rows[0]).toMatch(/alice added the\s*bug\s*label/);
  expect(conversation.querySelector(".pr-timeline-event .pr-label")?.textContent).toBe("bug");
  expect(rows[1]).toContain("alice assigned bob");
  expect(rows[2]).toContain("On it");
  expect(rows[3]).toContain("changed the title");
  expect(rows[3]).toContain("Crash on startup");
  expect(rows[4]).toContain("other/repo#9");
  expect(rows[5]).toContain("bob closed this as not planned");
  expect(rows[6]).toContain("alice reopened this");
  // The viewer's own comment can still be edited.
  expect(conversation.querySelector('[aria-label="Edit comment"]')).not.toBeNull();

  const reference = [...conversation.querySelectorAll<HTMLButtonElement>(".pr-timeline-event button")].find((b) =>
    b.textContent?.includes("Fix the crash"),
  )!;
  await act(async () => reference.click());
  expect(open).toHaveBeenCalledWith("https://github.com/other/repo/pull/9");
});

it("offers the conversation's people before collaborators in the comment box and the comment editor", async () => {
  const candidates = vi.spyOn(commands, "pullRequestCandidates").mockResolvedValue({ status: "ok", data: { users: ["zed", "Carol", "ann"], labels: [] } });
  vi.mocked(commands.issueDetail).mockResolvedValue({
    status: "ok",
    data: detail({
      participants: ["dave", "me"],
      timeline: [
        { kind: "comment", id: "IC_1", author: "carol", body: "Same here", createdAt: "2026-01-01T03:00:00Z" },
        { kind: "comment", id: "IC_2", author: "me", body: "On it", createdAt: "2026-01-01T04:00:00Z" },
      ],
    }),
  });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  const typeIn = (box: HTMLTextAreaElement, text: string) => act(async () => {
    setter.call(box, text);
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const options = (box: HTMLTextAreaElement) =>
    [...box.closest(".md-editor")!.querySelectorAll('[role="option"]')].map((o) => o.textContent);

  const compose = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
  await typeIn(compose, "@");
  expect(candidates).toHaveBeenCalledTimes(1);
  expect(options(compose)).toEqual(["alice", "bob", "carol", "dave", "zed", "ann"]);

  await act(async () => (host.querySelector('[aria-label="Edit comment"]') as HTMLButtonElement).click());
  const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')!;
  await typeIn(editor, "On it @da");
  expect(options(editor)).toEqual(["dave"]);
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(options(editor)).toEqual([]);
  expect(host.querySelector('textarea[aria-label="Edit comment"]')).not.toBeNull();
});

it("closes as not planned with one click in the close split-button's menu, the comment going along", async () => {
  vi.spyOn(commands, "closeIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());

  const box = host.querySelector<HTMLTextAreaElement>(".pr-compose textarea, textarea")!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(box, "Duplicate of #3");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("Close with comment")).toBeDefined();

  const chevron = host.querySelector<HTMLButtonElement>('.split-btn button[aria-label="Close options"]')!;
  expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
  await act(async () => chevron.click());
  const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"]')];
  expect(items.map((i) => i.querySelector("strong")!.textContent)).toEqual(["Close as completed", "Close as not planned"]);
  expect(items[0].getAttribute("aria-checked")).toBe("true");

  await act(async () => items[1].click());
  expect(commands.closeIssue).toHaveBeenCalledTimes(1);
  expect(commands.closeIssue).toHaveBeenCalledWith(1, 7, "notPlanned", "Duplicate of #3");
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
});

it("dismisses the close menu with Escape without closing the issue", async () => {
  vi.spyOn(commands, "closeIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  const chevron = host.querySelector<HTMLButtonElement>('button[aria-label="Close options"]')!;
  await act(async () => chevron.click());
  const menu = document.body.querySelector('[role="menu"]')!;
  await act(async () => void menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(chevron);
  expect(commands.closeIssue).not.toHaveBeenCalled();
});

it("toggles an assignee with feedback on its own row while the rest of the list stays usable", async () => {
  vi.spyOn(commands, "pullRequestCandidates").mockResolvedValue({ status: "ok", data: { users: ["ana", "bob"], labels: [] } });
  let finish!: () => void;
  const edit = vi.spyOn(commands, "editIssue").mockImplementation(
    () => new Promise((resolve) => (finish = () => resolve({ status: "ok", data: null }))),
  );
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  await act(async () => (host.querySelector('[aria-label="Edit assignees"]') as HTMLButtonElement).click());
  const row = (name: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === name)!;
  expect(row("ana").getAttribute("aria-selected")).toBe("false");

  await act(async () => row("ana").querySelector("button")!.click());
  expect(edit).toHaveBeenCalledWith(1, 7, expect.objectContaining({ addAssignees: ["ana"] }));
  // The clicked row turns on at once and says it is working; the others stay as they were, clickable.
  expect(row("ana").getAttribute("aria-selected")).toBe("true");
  expect(row("ana").getAttribute("aria-busy")).toBe("true");
  expect(row("bob").querySelector("button")!.disabled).toBe(false);
  expect(row("bob").hasAttribute("aria-busy")).toBe(false);

  vi.mocked(commands.issueDetail).mockResolvedValue({ status: "ok", data: detail({ assignees: ["bob", "ana"] }) });
  await act(async () => finish());
  expect(row("ana").getAttribute("aria-selected")).toBe("true");
  expect(row("ana").hasAttribute("aria-busy")).toBe(false);
  expect(row("ana").querySelector("button")!.disabled).toBe(false);
});

it("puts a failed assignee toggle back and says why", async () => {
  vi.spyOn(commands, "pullRequestCandidates").mockResolvedValue({ status: "ok", data: { users: ["ana", "bob"], labels: [] } });
  vi.spyOn(commands, "editIssue").mockResolvedValue({ status: "error", error: { message: "no access" } });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  await act(async () => (host.querySelector('[aria-label="Edit assignees"]') as HTMLButtonElement).click());
  const ana = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === "ana")!;
  await act(async () => ana().querySelector("button")!.click());
  expect(ana().getAttribute("aria-selected")).toBe("false");
  expect(ana().hasAttribute("aria-busy")).toBe(false);
  expect(host.textContent).toContain("no access");
});

it("assigns yourself with the link saying it is working", async () => {
  vi.mocked(commands.issueDetail).mockResolvedValue({ status: "ok", data: detail({ assignees: [] }) });
  let finish!: () => void;
  const edit = vi.spyOn(commands, "editIssue").mockImplementation(
    () => new Promise((resolve) => (finish = () => resolve({ status: "ok", data: null }))),
  );
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  await act(async () => button("assign yourself").click());
  expect(edit).toHaveBeenCalledWith(1, 7, expect.objectContaining({ addAssignees: ["me"] }));
  const link = host.querySelector<HTMLButtonElement>(".pr-field-empty button.link")!;
  expect(link.getAttribute("aria-busy")).toBe("true");
  expect(link.textContent).toContain("Assigning");
  // Only the link waits: the rest of the issue stays editable.
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Edit title"]')!.disabled).toBe(false);
  await act(async () => finish());
});

it("offers to reopen a closed issue", async () => {
  vi.spyOn(commands, "issueDetail").mockResolvedValue({
    status: "ok",
    data: detail({ state: "CLOSED", stateReason: "NOT_PLANNED" }),
  });
  vi.spyOn(commands, "reopenIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  expect(host.textContent).toContain("Closed as not planned");
  await act(async () => button("Reopen issue").click());
  expect(commands.reopenIssue).toHaveBeenCalledWith(1, 7);
});

const remount = async (projectId = 1) => {
  await act(() => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<IssuesSurface projectId={projectId} />));
};

it("renders the previous list at once on remount without asking GitHub again while fresh", async () => {
  await render();
  const calls = listCalls();
  await remount();
  expect(host.textContent).not.toContain("Loading…");
  expect(host.textContent).toContain("Crash on startup");
  expect(listCalls()).toBe(calls);
});

it("revalidates an older cached list in the background while it stays on screen", async () => {
  vi.useFakeTimers();
  try {
    await render();
    await act(() => root.unmount());
    await act(async () => void vi.advanceTimersByTime(QUERY_STALE_MS + 1));
    let resolve!: (r: Awaited<ReturnType<typeof commands.listIssues>>) => void;
    vi.mocked(commands.listIssues).mockImplementation(() => new Promise((r) => (resolve = r)));
    root = createRoot(host);
    await act(async () => root.render(<IssuesSurface projectId={1} />));
    // The cached list is on screen while the background fetch is still pending.
    expect(host.textContent).toContain("Crash on startup");
    expect(host.textContent).not.toContain("Loading…");
    expect(listCalls()).toBe(2);
    await act(async () => resolve({ status: "ok", data: [summary({ number: 8, title: "Fresh one" })] }));
    expect(host.textContent).toContain("Fresh one");
    expect(host.textContent).not.toContain("Crash on startup");
  } finally {
    vi.useRealTimers();
  }
});

it("never shows one Project's issues in another", async () => {
  await render();
  vi.mocked(commands.listIssues).mockImplementation(() => new Promise(() => {}));
  await remount(2);
  expect(host.textContent).not.toContain("Crash on startup");
  expect(host.querySelector('.skeleton[aria-busy="true"]')).not.toBeNull();
});

it("keeps the list and notes the failure when a refresh fails; a first failure shows the error", async () => {
  await render();
  vi.mocked(commands.listIssues).mockResolvedValue({ status: "error", error: { message: "network down" } });
  // Focus once the last tick is stale asks again, even while the cache is fresh.
  await focusLater();
  expect(host.textContent).toContain("Crash on startup");
  expect(host.textContent).toContain("network down");
  expect(host.querySelector('[role="alert"]')).toBeNull();

  clearQueryCache();
  await remount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("network down");
});

it("still shows the guidance when gh is not ready, even with a cached list", async () => {
  await render();
  vi.mocked(commands.issuesState).mockResolvedValue({
    status: "ok",
    data: { availability: "notAuthenticated", guidance: "Run gh auth login." },
  } as never);
  await focusLater();
  expect(host.textContent).toContain("Run gh auth login.");
  expect(host.textContent).not.toContain("Crash on startup");
});

it("lists issues without waiting for the readiness check", async () => {
  vi.mocked(commands.issuesState).mockImplementation(() => new Promise(() => {}));
  await render();
  expect(commands.listIssues).toHaveBeenCalled();
  expect(host.textContent).toContain("Crash on startup");
});

it("lists an issue created or closed here when coming back, without waiting for the timer", async () => {
  vi.spyOn(commands, "closeIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  vi.mocked(commands.listIssues).mockResolvedValue({ status: "ok", data: [] });
  await act(async () => button("Close as completed").click());
  await act(async () => button("Issues").click());
  expect(host.textContent).toContain("No open issues.");
});


it("shows an accessible skeleton until issues arrive, then removes it even for an empty list", async () => {
  let release!: (value: Awaited<ReturnType<typeof commands.listIssues>>) => void;
  vi.mocked(commands.listIssues).mockReturnValue(new Promise((resolve) => { release = resolve; }));
  await render();
  const loading = host.querySelector('.skeleton[role="status"]');
  expect(loading?.getAttribute("aria-busy")).toBe("true");
  expect(loading?.textContent).toContain("Loading issues");
  expect(loading?.querySelector("button, input, [tabindex]")).toBeNull();
  await act(async () => release({ status: "ok", data: [] }));
  expect(host.querySelector(".skeleton")).toBeNull();
  expect(host.textContent).toContain("No open issues.");
});

it("replaces the loading skeleton with an error when GitHub fails", async () => {
  let release!: (value: Awaited<ReturnType<typeof commands.listIssues>>) => void;
  vi.mocked(commands.listIssues).mockReturnValue(new Promise((resolve) => { release = resolve; }));
  await render();
  expect(host.querySelector(".skeleton")).not.toBeNull();
  await act(async () => release({ status: "error", error: { message: "GitHub is offline" } }));
  expect(host.querySelector(".skeleton")).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("GitHub is offline");
});

it("copies the issue URL with confirmation feedback and surfaces clipboard errors", async () => {
  const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());

  const copyBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]');
  expect(copyBtn).not.toBeNull();
  expect(host.querySelector('.pr-nav button[aria-label="Open on GitHub"]')).not.toBeNull();

  await act(async () => copyBtn!.click());
  expect(writeText).toHaveBeenCalledWith("https://github.com/fake/repo/issues/7");
  expect(copyBtn!.getAttribute("data-copied")).toBe("true");
  expect(host.querySelector('.pr-nav [role="status"]')?.textContent).toContain("Copied");

  writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
  await act(async () => copyBtn!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Clipboard denied");
});

it("stops polling while the Surface is hidden, and revalidates silently once shown again", async () => {
  vi.useFakeTimers();
  try {
    await render();
    await render(false);
    const calls = listCalls();
    const checks = vi.mocked(commands.issuesState).mock.calls.length;
    await act(async () => void vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 3));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(listCalls()).toBe(calls);
    expect(vi.mocked(commands.issuesState).mock.calls.length).toBe(checks);

    vi.mocked(commands.listIssues).mockImplementation(() => new Promise(() => {}));
    await render(true);
    expect(listCalls()).toBe(calls + 1);
    expect(host.textContent).toContain("Crash on startup");
    expect(host.querySelector(".refresh-spinner")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
