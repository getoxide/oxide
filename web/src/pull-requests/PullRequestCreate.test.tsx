// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { PullRequestCreate } from "./PullRequestCreate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
beforeEach(() => {
  vi.spyOn(commands, "pullRequestDraft").mockResolvedValue({
    status: "ok",
    data: {
      title: "Fix topic",
      body: "Tested locally",
      base: "main",
      head: "fix/topic",
      commitsBeyond: 1,
      protected: false,
      heads: ["fix/topic", "feat/other"],
    },
  });
  vi.spyOn(commands, "pullRequestBaseBranches").mockResolvedValue({
    status: "ok",
    data: ["main", "dev", "fix/topic"],
  });
});
afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
});

it("submits a prefilled draft and keeps the form and diagnostics when the push fails", async () => {
  const created = vi.fn();
  const create = vi.spyOn(commands, "createPullRequest").mockResolvedValue({
    status: "error",
    error: { message: "non-fast-forward [rejected]" },
  });
  await act(async () =>
    root.render(
      <PullRequestCreate
        projectId={1}
        onCancel={() => {}}
        onCreated={created}
      />,
    ),
  );
  expect(
    host.querySelector<HTMLInputElement>(".pr-create-title input")?.value,
  ).toBe("Fix topic");
  await act(async () =>
    host.querySelector<HTMLInputElement>(".pr-create-draft input")!.click(),
  );
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(create).toHaveBeenCalledWith(1, {
    title: "Fix topic",
    body: "Tested locally",
    base: "main",
    head: "fix/topic",
    draft: true,
  });
  expect(created).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "couldn’t be pushed",
  );
  expect(
    host.querySelector<HTMLInputElement>(".pr-create-title input")?.value,
  ).toBe("Fix topic");
  const pr = {
    number: 12,
    title: "Fix topic",
    body: "",
    author: "me",
    url: "",
    head: "fix/topic",
    crossRepository: false,
    base: "main",
    draft: true,
    createdAt: "",
  };
  create.mockResolvedValue({ status: "ok", data: pr });
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(created).toHaveBeenCalledWith(pr);
});

const pullRequest = {
  number: 12,
  title: "Fix topic",
  body: "",
  author: "me",
  url: "",
  head: "fix/topic",
  crossRepository: false,
  base: "main",
  draft: false,
  createdAt: "",
};

async function open() {
  await act(async () =>
    root.render(
      <PullRequestCreate
        projectId={1}
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    ),
  );
}

async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("creates the pull request with the description as written", async () => {
  const create = vi
    .spyOn(commands, "createPullRequest")
    .mockResolvedValue({ status: "ok", data: pullRequest });
  await open();
  await submit();
  expect(create).toHaveBeenCalledWith(1, {
    title: "Fix topic",
    body: "Tested locally",
    base: "main",
    head: "fix/topic",
    draft: false,
  });
});


type Draft = { title: string; body: string; head: string; base: string; commitsBeyond: number | null; protected: boolean; heads: string[] };

function mockDraft(over: Partial<Draft>) {
  return vi.spyOn(commands, "pullRequestDraft").mockResolvedValue({
    status: "ok",
    data: {
      title: "Fix topic",
      body: "",
      base: "main",
      head: "fix/topic",
      commitsBeyond: 1,
      protected: false,
      heads: ["fix/topic", "feat/other"],
      ...over,
    },
  });
}

function createButton() {
  return host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

it("keeps Create disabled and explains why when the branch has no commits beyond the base", async () => {
  mockDraft({ commitsBeyond: 0 });
  const create = vi.spyOn(commands, "createPullRequest");
  await open();
  expect(createButton().disabled).toBe(true);
  expect(host.textContent).toContain(
    "No commits on fix/topic beyond main. Commit changes before creating a pull request.",
  );
  await submit();
  expect(create).not.toHaveBeenCalled();
});

it("keeps Create disabled and asks for a feature branch when there is no branch to open it from", async () => {
  // Core refuses a protected head, and offers it only when no other local branch exists.
  mockDraft({ head: "main", base: "main", commitsBeyond: 0, protected: true, heads: [] });
  const create = vi.spyOn(commands, "createPullRequest");
  await open();
  expect(createButton().disabled).toBe(true);
  expect(host.textContent).toContain(
    "Create a feature branch to open a pull request: main can’t be the head.",
  );
  expect(host.textContent).not.toContain("No commits on");
  expect(trigger("Head branch").disabled).toBe(true);
  await submit();
  expect(create).not.toHaveBeenCalled();
});

it("keeps Create disabled when the head and the base are the same branch", async () => {
  vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 0 });
  const create = vi.spyOn(commands, "createPullRequest");
  await open();
  await chooseBase("fix/topic");
  expect(createButton().disabled).toBe(true);
  expect(host.textContent).toContain("The head and the base are the same branch. Choose another base.");
  expect(host.textContent).not.toContain("No commits on");
  await submit();
  expect(create).not.toHaveBeenCalled();
});

it("opens the pull request from a chosen head that is not checked out", async () => {
  const draft = mockDraft({ head: "fix/topic", heads: ["fix/topic", "feat/other"] });
  const beyond = vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 3 });
  const create = vi.spyOn(commands, "createPullRequest").mockResolvedValue({ status: "ok", data: pullRequest });
  await open();
  expect(trigger("Head branch").textContent).toContain("fix/topic");
  draft.mockResolvedValue({
    status: "ok",
    data: { title: "Other things", body: "- One\n- Two", base: "main", head: "feat/other", commitsBeyond: 3, protected: false, heads: ["fix/topic", "feat/other"] },
  });
  await choose("Head branch", "feat/other");
  expect(beyond).toHaveBeenCalledWith(1, "feat/other", "main");
  expect(draft).toHaveBeenLastCalledWith(1, "feat/other");
  expect(trigger("Head branch").textContent).toContain("feat/other");
  // The title and description follow the head while the user has not written their own.
  expect(titleInput().value).toBe("Other things");
  expect(host.textContent).toContain("feat/other will be pushed before the pull request is created.");
  await submit();
  expect(create).toHaveBeenCalledWith(1, expect.objectContaining({ head: "feat/other", base: "main", title: "Other things", body: "- One\n- Two" }));
});

it("keeps a title the user wrote when another head is chosen", async () => {
  const draft = mockDraft({});
  vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 1 });
  await open();
  await act(async () => {
    const input = titleInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "My own title");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  draft.mockClear();
  await choose("Head branch", "feat/other");
  expect(titleInput().value).toBe("My own title");
});

it("speaks about the chosen head and base when there is nothing to compare", async () => {
  vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 0 });
  await open();
  await choose("Head branch", "feat/other");
  expect(host.textContent).toContain(
    "No commits on feat/other beyond main. Commit changes before creating a pull request.",
  );
  expect(createButton().disabled).toBe(true);
});

it("picks a branch from a filtered list with the keyboard, marking the current one", async () => {
  vi.spyOn(commands, "pullRequestBaseBranches").mockResolvedValue({
    status: "ok",
    data: ["main", "dev", "release/1", "release/2", "release/3", "release/4", "release/5", "release/6", "release/7"],
  });
  vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 2 });
  await open();
  await act(async () => trigger("Base branch").click());
  const listbox = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Base branch"]')!;
  expect(listbox).not.toBeNull();
  const selected = [...listbox.querySelectorAll('[role="option"][aria-selected="true"]')].map((o) => o.textContent);
  expect(selected).toEqual(["main"]);
  const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter branches"]')!;
  expect(document.activeElement).toBe(filter);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(filter, "release/");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(7);
  await act(async () => void filter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await act(async () => void filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(trigger("Base branch").textContent).toContain("release/2");
  expect(document.activeElement).toBe(trigger("Base branch"));
});

it("closes the branch list on Escape without changing the branch", async () => {
  await open();
  await act(async () => trigger("Base branch").click());
  const list = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Base branch"]')!;
  // A short list needs no filter field.
  expect(document.querySelector('input[aria-label="Filter branches"]')).toBeNull();
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(trigger("Base branch").textContent).toContain("main");
  expect(document.activeElement).toBe(trigger("Base branch"));
});

function titleInput() {
  return host.querySelector<HTMLInputElement>(".pr-create-title input")!;
}

function trigger(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
}

async function choose(label: string, name: string) {
  await act(async () => trigger(label).click());
  const option = [...document.querySelectorAll<HTMLElement>(`[role="listbox"][aria-label="${label}"] [role="option"]`)].find(
    (o) => o.textContent === name,
  )!;
  await act(async () => option.click());
}

async function chooseBase(name: string) {
  await choose("Base branch", name);
}

it("re-checks the commits beyond a newly chosen base through local Git", async () => {
  mockDraft({ commitsBeyond: 2 });
  let resolve!: (n: number) => void;
  const beyond = vi.spyOn(commands, "pullRequestCommitsBeyond").mockReturnValue(
    new Promise((r) => {
      resolve = (n) => r({ status: "ok", data: n });
    }),
  );
  await open();
  expect(createButton().disabled).toBe(false);

  await chooseBase("dev");
  expect(beyond).toHaveBeenCalledWith(1, "fix/topic", "dev");
  // Until the count is known, Create waits.
  expect(createButton().disabled).toBe(true);
  await act(async () => resolve(0));
  expect(createButton().disabled).toBe(true);
  expect(host.textContent).toContain(
    "No commits on fix/topic beyond dev. Commit changes before creating a pull request.",
  );

  await chooseBase("main");
  expect(beyond).toHaveBeenCalledTimes(1);
  expect(createButton().disabled).toBe(false);
  expect(host.textContent).not.toContain("No commits on");
});

it("re-checks the count when the window regains focus, so a commit made meanwhile enables Create", async () => {
  mockDraft({ commitsBeyond: 0 });
  const beyond = vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 1 });
  await open();
  expect(createButton().disabled).toBe(true);
  await act(async () => void window.dispatchEvent(new Event("focus")));
  expect(beyond).toHaveBeenCalledWith(1, "fix/topic", "main");
  expect(createButton().disabled).toBe(false);
  expect(host.textContent).not.toContain("No commits on");
});

it("never takes a cached zero as final when coming back to a base", async () => {
  mockDraft({ commitsBeyond: 0 });
  const beyond = vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({ status: "ok", data: 2 });
  await open();
  await chooseBase("dev");
  await chooseBase("main");
  expect(beyond).toHaveBeenLastCalledWith(1, "fix/topic", "main");
  expect(createButton().disabled).toBe(false);
});

it("drops a count that arrives after the form reloaded for another project", async () => {
  mockDraft({ commitsBeyond: 2 });
  const resolvers: ((n: number) => void)[] = [];
  vi.spyOn(commands, "pullRequestCommitsBeyond").mockImplementation(
    () =>
      new Promise((r) => {
        resolvers.push((n) => r({ status: "ok", data: n }));
      }),
  );
  await open();
  await chooseBase("dev");
  await act(async () =>
    root.render(<PullRequestCreate projectId={2} onCancel={() => {}} onCreated={() => {}} />),
  );
  await chooseBase("dev");
  expect(resolvers).toHaveLength(2);
  // The first project's answer comes last and must not count for the second.
  await act(async () => resolvers[0](0));
  expect(host.textContent).not.toContain("No commits on");
  expect(createButton().disabled).toBe(true);
  await act(async () => resolvers[1](4));
  expect(createButton().disabled).toBe(false);
});

it("lets the user try when the count for a base cannot be told", async () => {
  mockDraft({ commitsBeyond: 2 });
  vi.spyOn(commands, "pullRequestCommitsBeyond").mockResolvedValue({
    status: "error",
    error: { message: "unknown" },
  });
  await open();
  await chooseBase("dev");
  expect(createButton().disabled).toBe(false);
  expect(host.textContent).not.toContain("No commits on");
});
