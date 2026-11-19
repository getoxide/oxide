import { describe, expect, it } from "vitest";
import { relativeAge, relativeTime } from "./relativeTime";

describe("relativeTime", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");

  it("picks the largest fitting compact unit", () => {
    expect(relativeTime("2026-10-26T11:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-10-26T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-10-26T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-10-24T12:00:00Z", now)).toBe("2d");
    expect(relativeTime("2026-10-12T12:00:00Z", now)).toBe("2w");
    expect(relativeTime("2026-08-26T12:00:00Z", now)).toBe("2mo");
    expect(relativeTime("2024-10-26T12:00:00Z", now)).toBe("2y");
    expect(relativeTime("garbage", now)).toBe("");
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  it("counts minutes, hours, yesterday and days", () => {
    expect(relativeAge(ago(0), now)).toBe("now");
    expect(relativeAge(ago(5), now)).toBe("5m");
    expect(relativeAge(ago(180), now)).toBe("3h");
    expect(relativeAge(ago(26 * 60), now)).toBe("yesterday");
    expect(relativeAge(ago(4 * 24 * 60), now)).toBe("4d");
  });

  it("is empty for an unreadable time", () => {
    expect(relativeAge("not a date", now)).toBe("");
  });
});
