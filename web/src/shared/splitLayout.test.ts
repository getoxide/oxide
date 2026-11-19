import { expect, it } from "vitest";
import { centreSplit, splitMode } from "./splitLayout";

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
