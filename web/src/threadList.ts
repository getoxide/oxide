import type { Project, Thread } from "./bindings";

export const threadTitle = (thread: Pick<Thread, "id" | "title">) => thread.title || `Thread #${thread.id}`;

/** The sidebar's Threads, filtered by title only. */
export function filterThreads(threads: Thread[], query: string): Thread[] {
  const needle = query.trim().toLowerCase();
  return needle ? threads.filter((t) => threadTitle(t).toLowerCase().includes(needle)) : threads;
}

/** The sidebar lists only Projects the user opened; a scan just makes them findable in ⌘⇧N. */
export const sidebarProjects = (projects: Project[]) => projects.filter((p) => p.open && !p.hidden);
