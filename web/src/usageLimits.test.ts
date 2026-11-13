import { describe, expect, it } from "vitest";
import type { UsageLimitWindow, UsageLimits } from "./bindings";
import { formatCountdown, usageView } from "./usageLimits";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const secs = (ms: number) => Math.floor(ms / 1000);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const win = (over: Partial<UsageLimitWindow> = {}): UsageLimitWindow => ({
  percentUsed: 42,
  resetsAt: secs(NOW + 2 * HOUR + 13 * MIN),
  status: "ok",
  reportedAt: secs(NOW - MIN),
  ...over,
});

const limits = (over: Partial<UsageLimits> = {}): UsageLimits => ({
  fiveHour: win(),
  weekly: win({ percentUsed: 10, resetsAt: secs(NOW + 3 * DAY + 4 * HOUR) }),
  ...over,
});

const ready = (view: ReturnType<typeof usageView>) => {
  if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe("formatCountdown", () => {
  it("counts minutes, hours and days", () => {
    expect(formatCountdown(secs(NOW + 5 * MIN), NOW)).toBe("5 min");
    expect(formatCountdown(secs(NOW + 2 * HOUR + 13 * MIN), NOW)).toBe("2 h 13 min");
    expect(formatCountdown(secs(NOW + 2 * HOUR), NOW)).toBe("2 h");
    expect(formatCountdown(secs(NOW + 3 * DAY + 4 * HOUR), NOW)).toBe("3 d 4 h");
    expect(formatCountdown(secs(NOW + 3 * DAY), NOW)).toBe("3 d");
  });

  it("never shows less than a minute", () => {
    expect(formatCountdown(secs(NOW + 10_000), NOW)).toBe("1 min");
  });
});

describe("usageView", () => {
  it("is hidden for a Provider that reports no Usage limits", () => {
    expect(usageView(limits(), false, NOW).kind).toBe("hidden");
  });

  it("always offers the two labelled windows, empty before anything was reported", () => {
    for (const none of [null, { fiveHour: null, weekly: null }]) {
      const { windows } = ready(usageView(none, true, NOW));
      expect(windows.map((w) => w.label)).toEqual(["5h", "Weekly"]);
      for (const w of windows) {
        expect(w).toMatchObject({ fraction: 0, severity: "normal", countdown: "—", detail: "No usage reported yet" });
      }
    }
  });

  it("gives each window its ring, its time to reset and its exact figure", () => {
    const { windows } = ready(usageView(limits(), true, NOW));
    expect(windows[0]).toEqual({
      key: "five-hour",
      label: "5h",
      title: "5-hour limit",
      fraction: 0.42,
      severity: "normal",
      countdown: "2 h 13 min",
      detail: "42% used · Resets in 2 h 13 min",
      ariaLabel: "5-hour limit 42% used, resets in 2 hours 13 minutes",
    });
    expect(windows[1]).toMatchObject({
      key: "weekly",
      label: "Weekly",
      fraction: 0.1,
      countdown: "3 d 4 h",
      detail: "10% used · Resets in 3 d 4 h",
      ariaLabel: "Weekly limit 10% used, resets in 3 days 4 hours",
    });
  });

  it("keeps a decimal figure exact", () => {
    const { windows } = ready(usageView(limits({ fiveHour: win({ percentUsed: 42.5 }) }), true, NOW));
    expect(windows[0].detail).toBe("42.5% used · Resets in 2 h 13 min");
  });

  it.each([
    [79, "normal"],
    [80, "warning"],
    [94, "warning"],
    [95, "critical"],
    [100, "critical"],
  ])("grades %i%% as %s, in either window", (percentUsed, severity) => {
    const view = ready(
      usageView(limits({ fiveHour: win({ percentUsed }), weekly: win({ percentUsed }) }), true, NOW),
    );
    expect(view.windows.map((w) => w.severity)).toEqual([severity, severity]);
  });

  it("is critical whenever the Provider says the user is limited", () => {
    const view = ready(usageView(limits({ fiveHour: win({ percentUsed: 30, status: "limited" }) }), true, NOW));
    expect(view.windows[0].severity).toBe("critical");
  });

  it("shows a window past its reset time as reset, at 0%", () => {
    const stale = win({ percentUsed: 97, resetsAt: secs(NOW - MIN), status: "limited" });
    const { windows } = ready(usageView(limits({ fiveHour: stale }), true, NOW));
    expect(windows[0]).toMatchObject({ fraction: 0, severity: "normal", countdown: "Reset", detail: "0% used · Reset" });
  });

  it("keeps an unknown figure unknown", () => {
    const unknown = win({ percentUsed: null, status: "warning" });
    const { windows } = ready(usageView(limits({ fiveHour: unknown }), true, NOW));
    expect(windows[0].detail).toBe("Usage not reported · Resets in 2 h 13 min");
    expect(windows[0].fraction).toBe(0);
  });

  it("leaves one window empty when only the other was reported", () => {
    const { windows } = ready(usageView(limits({ weekly: null }), true, NOW));
    expect(windows[1]).toMatchObject({ label: "Weekly", countdown: "—", detail: "No usage reported yet" });
    expect(windows[0].fraction).toBeCloseTo(0.42);
  });

  it("marks data from before this session with how long ago it was reported", () => {
    const earlier = win({ reportedAt: secs(NOW - 3 * HOUR) });
    const old = limits({ fiveHour: earlier, weekly: earlier });
    expect(ready(usageView(old, true, NOW, NOW - HOUR)).updatedLabel).toBe("Updated 3 h ago");
    expect(ready(usageView(limits(), true, NOW, NOW - HOUR)).updatedLabel).toBeNull();
    expect(ready(usageView(null, true, NOW, NOW - HOUR)).updatedLabel).toBeNull();
  });

  it("selects the Gemini Argon pool when using an Argon model with Antigravity", () => {
    const limitsWithPools: UsageLimits = {
      fiveHour: win({ percentUsed: 10 }),
      weekly: win({ percentUsed: 20 }),
      pools: {
        gemini: {
          label: "Gemini",
          fiveHour: win({ percentUsed: 15 }),
          weekly: win({ percentUsed: 25 }),
        },
        "gemini-argon": {
          label: "Gemini Argon",
          fiveHour: null,
          weekly: win({ percentUsed: 75, resetsAt: secs(NOW + HOUR) }),
        },
        "third-party": {
          label: "Third-party (Claude, GPT)",
          fiveHour: win({ percentUsed: 5 }),
          weekly: win({ percentUsed: 5 }),
        },
      },
    };

    const argonView = ready(usageView(limitsWithPools, true, NOW, NOW, "antigravity", "Gemini 4 Argon (High)"));
    expect(argonView.activePoolKey).toBe("gemini-argon");
    expect(argonView.activePoolLabel).toBe("Gemini Argon");
    // Argon has no 5-hour quota — only Weekly is shown.
    expect(argonView.windows.map((w) => w.key)).toEqual(["weekly"]);
    expect(argonView.windows[0].fraction).toBe(0.75);
    const argonPool = argonView.pools.find((p) => p.key === "gemini-argon");
    expect(argonPool?.windows.map((w) => w.key)).toEqual(["weekly"]);

    const normalGeminiView = ready(usageView(limitsWithPools, true, NOW, NOW, "antigravity", "Gemini 3.8 Flash"));
    expect(normalGeminiView.activePoolKey).toBe("gemini");
    expect(normalGeminiView.windows[1].fraction).toBe(0.25);

    const thirdPartyView = ready(usageView(limitsWithPools, true, NOW, NOW, "antigravity", "Claude Sonnet 4.6"));
    expect(thirdPartyView.activePoolKey).toBe("third-party");
    expect(thirdPartyView.windows[1].fraction).toBe(0.05);

    // All pools are available in the pools breakdown
    expect(argonView.pools.map((p) => p.key)).toEqual(["gemini", "gemini-argon", "third-party"]);
    expect(argonView.pools.find((p) => p.key === "gemini-argon")?.isActive).toBe(true);
    expect(argonView.pools.find((p) => p.key === "gemini")?.isActive).toBe(false);
  });

  it("keeps third-party Antigravity models isolated from Gemini fallback and sorts pools deterministically", () => {
    const limitsWithReverseOrder: UsageLimits = {
      fiveHour: win({ percentUsed: 80 }),
      weekly: win({ percentUsed: 90 }),
      pools: {
        "third-party": {
          label: "Third-party (Claude, GPT)",
          fiveHour: null,
          weekly: null,
        },
        "gemini-argon": {
          label: "Gemini Argon",
          fiveHour: null,
          weekly: win({ percentUsed: 99 }),
        },
        gemini: {
          label: "Gemini",
          fiveHour: win({ percentUsed: 20 }),
          weekly: win({ percentUsed: 30 }),
        },
      },
    };

    const claudeView = ready(usageView(limitsWithReverseOrder, true, NOW, NOW, "antigravity", "claude-opus-5-5-high"));
    expect(claudeView.activePoolKey).toBe("third-party");
    expect(claudeView.windows[0].detail).toBe("No usage reported yet");
    expect(claudeView.windows[1].detail).toBe("No usage reported yet");

    const hydrogenView = ready(usageView(limitsWithReverseOrder, true, NOW, NOW, "antigravity", "gemini-4-hydrogen-high"));
    expect(hydrogenView.activePoolKey).toBe("gemini");
    expect(hydrogenView.windows[0].fraction).toBe(0.2);
    expect(hydrogenView.windows[1].fraction).toBe(0.3);
    expect(hydrogenView.pools.map((p) => p.key)).toEqual(["gemini", "gemini-argon"]);
  });

  it("selects model-specific pool in Claude provider (e.g. Sonnet vs Opus)", () => {
    const claudeLimits: UsageLimits = {
      fiveHour: win({ percentUsed: 30 }),
      weekly: win({ percentUsed: 40 }),
      pools: {
        sonnet: {
          label: "Claude Sonnet",
          fiveHour: null,
          weekly: win({ percentUsed: 55 }),
        },
        opus: {
          label: "Claude Opus",
          fiveHour: null,
          weekly: win({ percentUsed: 90 }),
        },
      },
    };

    const sonnetView = ready(usageView(claudeLimits, true, NOW, NOW, "claude", "claude-3-7-sonnet"));
    expect(sonnetView.activePoolKey).toBe("sonnet");
    expect(sonnetView.windows[1].fraction).toBe(0.55);

    const opusView = ready(usageView(claudeLimits, true, NOW, NOW, "claude", "claude-3-opus"));
    expect(opusView.activePoolKey).toBe("opus");
    expect(opusView.windows[1].fraction).toBe(0.9);
  });
});
