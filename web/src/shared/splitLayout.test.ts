import { describe, expect, it } from "vitest";
import { centreSplit, layoutOf, maximizeHalf, parseLayouts, restoreSplit, setDivider, splitMode, visibleMode } from "./splitLayout";

describe("per-Project layout", () => {
  it("starts every Project with the 50/50 split and nothing maximized", () => {
    expect(layoutOf({}, 7)).toEqual({ divider: null, maximized: null });
  });

  it("maximizes a half for one Project only", () => {
    const next = maximizeHalf({}, 1, "code");
    expect(layoutOf(next, 1).maximized).toBe("code");
    expect(layoutOf(next, 2).maximized).toBeNull();
  });

  it("restores the split and keeps the divider", () => {
    const layouts = restoreSplit(setDivider(maximizeHalf({}, 1, "terminal"), 1, 420), 1);
    expect(layoutOf(layouts, 1)).toEqual({ divider: 420, maximized: null });
  });

  it("forgets the divider when reset to the default", () => {
    expect(layoutOf(setDivider(setDivider({}, 1, 420), 1, null), 1).divider).toBeNull();
  });

  it("shows only the maximized half of a split, and ignores it otherwise", () => {
    expect(visibleMode("split", "code")).toBe("code");
    expect(visibleMode("split", "terminal")).toBe("terminal");
    expect(visibleMode("split", null)).toBe("split");
    expect(visibleMode("terminal", "code")).toBe("terminal");
    expect(visibleMode("code", "terminal")).toBe("code");
  });

  it("reads stored layouts and drops malformed entries", () => {
    expect(parseLayouts({ "1": { divider: 420, maximized: "code" }, "2": { divider: -3, maximized: "x" }, "z": {}, "3": 5 }))
      .toEqual({ 1: { divider: 420, maximized: "code" }, 2: { divider: null, maximized: null } });
    expect(parseLayouts("nope")).toEqual({});
    expect(parseLayouts(null)).toEqual({});
  });
});

it("picks the centre mode from what the Project has open", () => {
  expect(splitMode({ terminals: true, code: false })).toBe("terminal");
  expect(splitMode({ terminals: false, code: false })).toBe("terminal");
  expect(splitMode({ terminals: true, code: true })).toBe("split");
  expect(splitMode({ terminals: false, code: true })).toBe("code");
});

it("splits 50/50 by default", () => {
  expect(centreSplit(1000, null)).toEqual({ value: 500, min: 360, max: 640 });
});

it("keeps the preferred width within 360 px per half", () => {
  expect(centreSplit(1000, 100).value).toBe(360);
  expect(centreSplit(1000, 900).value).toBe(640);
  expect(centreSplit(1000, 420).value).toBe(420);
});

it("cannot be dragged when the centre is too narrow for two halves", () => {
  const narrow = centreSplit(600, null);
  expect(narrow.max).toBeLessThanOrEqual(narrow.min);
});
