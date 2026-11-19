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
