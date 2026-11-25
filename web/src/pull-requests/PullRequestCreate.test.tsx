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
    draft: false,
  });
});


function mockDraft(over: Partial<{ head: string; base: string; commitsBeyond: number | null; protected: boolean }>) {
  vi.spyOn(commands, "pullRequestDraft").mockResolvedValue({
    status: "ok",
    data: {
      title: "Fix topic",
      body: "",
      base: "main",
      head: "fix/topic",
      commitsBeyond: 1,
      protected: false,
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

it("keeps Create disabled and asks for a feature branch when checked out on the protected base", async () => {
  mockDraft({ head: "main", base: "main", commitsBeyond: 0, protected: true });
  const create = vi.spyOn(commands, "createPullRequest");
  await open();
  expect(createButton().disabled).toBe(true);
  expect(host.textContent).toContain(
    "Switch from main to a feature branch to open a pull request.",
  );
  expect(host.textContent).not.toContain("No commits on");
  await submit();
  expect(create).not.toHaveBeenCalled();
});

it("asks for a feature branch on a protected branch even when it has commits beyond the base", async () => {
  mockDraft({ head: "release", base: "main", commitsBeyond: 3, protected: true });
  await open();
  expect(createButton().disabled).toBe(true);
  expect(host.textContent).toContain(
    "Switch from release to a feature branch to open a pull request.",
  );
});
