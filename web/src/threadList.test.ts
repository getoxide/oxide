import { describe, expect, it } from "vitest";
import type { Project, Thread } from "./bindings";
import { filterThreads, sidebarProjects } from "./threadList";

const thread = (id: number) => ({ id }) as Thread;

describe("filterThreads", () => {
  const threads = [thread(1), thread(12), thread(3), thread(21)];

  it("keeps every Thread without a query", () => {
    expect(filterThreads(threads, "").map((t) => t.id)).toEqual([1, 12, 3, 21]);
  });

  it("filters by title", () => {
    expect(filterThreads(threads, " #1").map((t) => t.id)).toEqual([1, 12]);
  });
});

describe("sidebarProjects", () => {
  const project = (id: number, open: boolean, hidden = false) => ({ id, open, hidden }) as Project;

  it("lists only the Projects the user opened, never hidden ones", () => {
    const listed = sidebarProjects([project(1, true), project(2, false), project(3, true, true)]);
    expect(listed.map((p) => p.id)).toEqual([1]);
  });
});
