import type { PanelBounds } from "./panelLayout";

/** Narrowest a centre half can be. */
export const HALF_MIN = 360;

export type SplitMode = "terminal" | "split" | "code";

/** What the centre shows: never an empty half, so a half exists only when it has content. */
export function splitMode(open: { terminals: boolean; code: boolean }): SplitMode {
  if (!open.code) return "terminal";
  return open.terminals ? "split" : "code";
}

/** Bounds of the Terminal half (left); `preferred` is `null` for the 50/50 default. */
export function centreSplit(width: number, preferred: number | null): PanelBounds {
  const max = Math.max(HALF_MIN, Math.floor(width - HALF_MIN));
  const value = Math.round(Math.min(max, Math.max(HALF_MIN, preferred ?? width / 2)));
  return { value, min: HALF_MIN, max };
}

export type Half = "terminal" | "code";

/** What one Project remembers about its centre: the divider and the maximized half. */
export interface ProjectLayout {
  /** Width of the Terminal half; `null` is the 50/50 default. */
  divider: number | null;
  maximized: Half | null;
}

export type ProjectLayouts = Record<number, ProjectLayout>;

const DEFAULT_LAYOUT: ProjectLayout = { divider: null, maximized: null };

export function layoutOf(layouts: ProjectLayouts, projectId: number): ProjectLayout {
  return layouts[projectId] ?? DEFAULT_LAYOUT;
}

function update(layouts: ProjectLayouts, projectId: number, change: Partial<ProjectLayout>): ProjectLayouts {
  const current = layoutOf(layouts, projectId);
  const next = { ...current, ...change };
  if (next.divider === current.divider && next.maximized === current.maximized && projectId in layouts) return layouts;
  return { ...layouts, [projectId]: next };
}

export function maximizeHalf(layouts: ProjectLayouts, projectId: number, half: Half): ProjectLayouts {
  return update(layouts, projectId, { maximized: half });
}

export function restoreSplit(layouts: ProjectLayouts, projectId: number): ProjectLayouts {
  return layoutOf(layouts, projectId).maximized === null ? layouts : update(layouts, projectId, { maximized: null });
}

/** Drops a Project's remembered layout, e.g. when the Project is closed. */
export function forgetLayout(layouts: ProjectLayouts, projectId: number): ProjectLayouts {
  if (!(projectId in layouts)) return layouts;
  const rest = { ...layouts };
  delete rest[projectId];
  return rest;
}

export function setDivider(layouts: ProjectLayouts, projectId: number, divider: number | null): ProjectLayouts {
  return update(layouts, projectId, { divider });
}

/** The half or halves actually shown: a maximization only matters while both halves exist. */
export function visibleMode(mode: SplitMode, maximized: Half | null): SplitMode {
  return mode === "split" && maximized !== null ? maximized : mode;
}

/** Below this centre width two halves of `HALF_MIN` no longer fit. */
export const NARROW_CENTRE = 2 * HALF_MIN;

/**
 * The half to force to full width: the maximized one, else (in a narrow centre) the one chosen last.
 * Narrowing reuses the maximize mechanism, so `null` means both halves may show.
 */
export function shownHalf(width: number, maximized: Half | null, last: Half): Half | null {
  return maximized ?? (width < NARROW_CENTRE ? last : null);
}

/** Layouts read back from storage (`unknown`): malformed entries are dropped or defaulted. */
export function parseLayouts(value: unknown): ProjectLayouts {
  const layouts: ProjectLayouts = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return layouts;
  for (const [key, entry] of Object.entries(value)) {
    const id = Number(key);
    if (!/^\d+$/.test(key) || !Number.isSafeInteger(id) || id <= 0 || typeof entry !== "object" || entry === null) continue;
    const { divider, maximized } = entry as Record<string, unknown>;
    layouts[id] = {
      divider: typeof divider === "number" && Number.isFinite(divider) && divider > 0 ? divider : null,
      maximized: maximized === "terminal" || maximized === "code" ? maximized : null,
    };
  }
  return layouts;
}
