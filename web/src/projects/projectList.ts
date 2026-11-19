import type { Project } from "../bindings";

/** The sidebar lists only Projects the user opened; a scan just makes them findable in the Project palette. */
export const sidebarProjects = (projects: Project[]) => projects.filter((p) => p.open && !p.hidden);
