import type { UsageLimitWindow, UsageLimits } from "./bindings";

export type UsageSeverity = "normal" | "warning" | "critical";

/** One window's ring and what hovering it says. */
export interface UsageWindowView {
  key: "five-hour" | "weekly";
  /** The short name shown next to the ring. */
  label: string;
  /** The full name, for the tooltip heading. */
  title: string;
  /** Share used, 0 to 1. */
  fraction: number;
  severity: UsageSeverity;
  /** Shown beside the ring: "2 h 13 min", "Reset", or "—" when unknown. */
  countdown: string;
  /** The tooltip: exact percentage and reset time. */
  detail: string;
  ariaLabel: string;
}

export interface UsagePoolView {
  key: string;
  label: string;
  isActive: boolean;
  windows: UsageWindowView[];
}

export type UsageView =
  | { kind: "hidden" }
  | {
      kind: "ready";
      activePoolKey: string;
      activePoolLabel: string;
      /** The 5-hour window, then the weekly one for the active model; a window never reported is empty. */
      windows: UsageWindowView[];
      /** Detailed breakdown of all available pools/categories. */
      pools: UsagePoolView[];
      /** "Updated 3 h ago" when the figures predate this session. */
      updatedLabel: string | null;
    };

const WARNING_AT = 80;
const CRITICAL_AT = 95;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function split(seconds: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(seconds, 0);
  return {
    days: Math.floor(total / DAY),
    hours: Math.floor((total % DAY) / HOUR),
    minutes: Math.floor((total % HOUR) / MINUTE),
  };
}

/** "5 min", "2 h 13 min", "3 d 4 h": two units at most, never less than a minute. */
function duration(seconds: number, long: boolean): string {
  const { days, hours, minutes } = split(seconds);
  const unit = (n: number, short: string, one: string) =>
    long ? `${n} ${n === 1 ? one : `${one}s`}` : `${n} ${short}`;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(unit(days, "d", "day"));
    if (hours > 0) parts.push(unit(hours, "h", "hour"));
  } else if (hours > 0) {
    parts.push(unit(hours, "h", "hour"));
    if (minutes > 0) parts.push(unit(minutes, "min", "minute"));
  } else {
    parts.push(unit(Math.max(minutes, 1), "min", "minute"));
  }
  return parts.join(" ");
}

/** How long until `resetsAt` (epoch seconds), e.g. "2 h 13 min". */
export function formatCountdown(resetsAt: number, nowMs: number): string {
  return duration(resetsAt - nowMs / 1000, false);
}

/** "42%" or "42.5%": exact, without trailing zeros. */
function percentText(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

interface Resolved {
  percent: number | null;
  severity: UsageSeverity;
  percentLabel: string;
  resetLabel: string;
  resetAria: string;
  countdown: string;
}

function resolve(window: UsageLimitWindow, nowMs: number): Resolved {
  const hasReset = window.resetsAt != null;
  if (hasReset && window.resetsAt! * 1000 <= nowMs) {
    // Reset since the last report: the old pressure is gone until the Provider reports again.
    return {
      percent: 0,
      severity: "normal",
      percentLabel: "0% used",
      resetLabel: "Reset",
      resetAria: "reset",
      countdown: "Reset",
    };
  }
  const percent = window.percentUsed == null ? null : Math.min(Math.max(window.percentUsed, 0), 100);
  const severity: UsageSeverity =
    window.status === "limited" || (percent ?? 0) >= CRITICAL_AT
      ? "critical"
      : (percent ?? 0) >= WARNING_AT || window.status === "warning"
        ? "warning"
        : "normal";
  return {
    percent,
    severity,
    percentLabel: percent == null ? "Usage not reported" : `${percentText(percent)} used`,
    resetLabel: hasReset ? `Resets in ${formatCountdown(window.resetsAt!, nowMs)}` : "",
    resetAria: hasReset ? `resets in ${duration(window.resetsAt! - nowMs / 1000, true)}` : "",
    countdown: hasReset ? formatCountdown(window.resetsAt!, nowMs) : "—",
  };
}

function windowView(
  key: UsageWindowView["key"],
  label: string,
  title: string,
  window: UsageLimitWindow | null | undefined,
  nowMs: number,
): UsageWindowView {
  if (!window) {
    return {
      key,
      label,
      title,
      fraction: 0,
      severity: "normal",
      countdown: "—",
      detail: "No usage reported yet",
      ariaLabel: `${title} not reported yet`,
    };
  }
  const r = resolve(window, nowMs);
  return {
    key,
    label,
    title,
    fraction: (r.percent ?? 0) / 100,
    severity: r.severity,
    countdown: r.countdown,
    detail: [r.percentLabel, r.resetLabel].filter(Boolean).join(" · "),
    ariaLabel: [`${title} ${r.percentLabel}`, r.resetAria].filter(Boolean).join(", "),
  };
}

const POOL_ORDER = ["gemini", "gemini-argon", "third-party", "sonnet", "opus", "haiku", "default"];

function poolSortRank(key: string): number {
  const index = POOL_ORDER.indexOf(key);
  return index === -1 ? POOL_ORDER.length : index;
}

/** Resolves which pool key applies to the given provider and model name. */
export function resolveActivePoolKey(provider: string, model: string | null): string {
  const p = (provider || "").toLowerCase();
  const m = (model || "").toLowerCase();
  if (p === "antigravity" || p === "agy") {
    if (m.includes("argon")) return "gemini-argon";
    if (
      m.includes("claude") ||
      m.includes("sonnet") ||
      m.includes("opus") ||
      m.includes("haiku") ||
      m.includes("gpt") ||
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4")
    ) {
      return "third-party";
    }
    return "gemini";
  }
  if (p === "claude") {
    if (m.includes("opus")) return "opus";
    if (m.includes("sonnet")) return "sonnet";
    if (m.includes("haiku")) return "haiku";
    return "default";
  }
  return "default";
}

export function poolDisplayName(key: string, provider: string): string {
  if (key === "gemini") return "Gemini";
  if (key === "gemini-argon") return "Gemini Argon";
  if (key === "third-party") return "Third-party (Claude, GPT)";
  if (key === "sonnet") return "Claude Sonnet";
  if (key === "opus") return "Claude Opus";
  if (key === "haiku") return "Claude Haiku";
  if (key === "default") return provider.toLowerCase() === "claude" ? "Claude" : "General";
  return key;
}

/** Resolves the 5-hour and weekly windows for the selected model. */
export function resolveModelWindows(
  limits: UsageLimits | null,
  provider: string,
  model: string | null,
): {
  fiveHour: UsageLimitWindow | null | undefined;
  weekly: UsageLimitWindow | null | undefined;
  poolKey: string;
  poolLabel: string;
} {
  const poolKey = resolveActivePoolKey(provider, model);
  const pools = (limits as { pools?: Record<string, { label: string; fiveHour: UsageLimitWindow | null; weekly: UsageLimitWindow | null }> })?.pools;
  const hasPools = !!pools && Object.keys(pools).length > 0;
  const pool = pools?.[poolKey];
  const poolLabel = pool?.label || poolDisplayName(poolKey, provider);

  // For Antigravity third-party models, never fall back to the top-level Gemini limits once
  // pool breakdowns are present. Gemini Argon shares Gemini's 5-hour window.
  const isIsolatedThirdParty = hasPools && poolKey === "third-party";
  const fiveHour =
    pool?.fiveHour ??
    (poolKey === "gemini-argon" ? pools?.["gemini"]?.fiveHour : undefined) ??
    (isIsolatedThirdParty ? undefined : limits?.fiveHour);
  const weekly = pool?.weekly ?? (isIsolatedThirdParty ? undefined : limits?.weekly);

  return { fiveHour, weekly, poolKey, poolLabel };
}

/**
 * What the usage rings show. `sessionStartMs` marks the start of this run of Oxide: figures
 * reported before it are labelled with their age.
 */
export function usageView(
  limits: UsageLimits | null,
  reportsUsage: boolean,
  nowMs: number,
  sessionStartMs: number = nowMs,
  provider: string = "",
  model: string | null = null,
): UsageView {
  if (!reportsUsage) return { kind: "hidden" };

  const { fiveHour, weekly, poolKey, poolLabel } = resolveModelWindows(limits, provider, model);

  let newest = Math.max(
    fiveHour?.reportedAt ?? 0,
    weekly?.reportedAt ?? 0,
    limits?.fiveHour?.reportedAt ?? 0,
    limits?.weekly?.reportedAt ?? 0,
  );
  const poolsObj = (limits as { pools?: Record<string, { label: string; fiveHour: UsageLimitWindow | null; weekly: UsageLimitWindow | null }> })?.pools;

  const poolViews: UsagePoolView[] = [];
  if (poolsObj && Object.keys(poolsObj).length > 0) {
    const entries = Object.entries(poolsObj).sort(([a], [b]) => {
      const rankDiff = poolSortRank(a) - poolSortRank(b);
      return rankDiff !== 0 ? rankDiff : a.localeCompare(b);
    });
    for (const [key, poolData] of entries) {
      const p5h = poolData.fiveHour?.reportedAt ?? 0;
      const pwk = poolData.weekly?.reportedAt ?? 0;
      if (p5h > newest) newest = p5h;
      if (pwk > newest) newest = pwk;

      const pWindows: UsageWindowView[] = [];
      if (poolData.fiveHour) {
        pWindows.push(windowView("five-hour", "5h", `${poolData.label || poolDisplayName(key, provider)} 5h`, poolData.fiveHour, nowMs));
      } else if (key === "gemini-argon" && poolsObj["gemini"]?.fiveHour) {
        pWindows.push(windowView("five-hour", "5h", `${poolData.label || poolDisplayName(key, provider)} 5h`, poolsObj["gemini"].fiveHour, nowMs));
      }
      if (poolData.weekly) {
        pWindows.push(windowView("weekly", "Weekly", `${poolData.label || poolDisplayName(key, provider)} Weekly`, poolData.weekly, nowMs));
      }
      if (pWindows.length > 0) {
        poolViews.push({
          key,
          label: poolData.label || poolDisplayName(key, provider),
          isActive: key === poolKey,
          windows: pWindows,
        });
      }
    }
  }

  if (poolViews.length === 0 && (fiveHour || weekly)) {
    poolViews.push({
      key: poolKey,
      label: poolLabel,
      isActive: true,
      windows: [
        windowView("five-hour", "5h", "5-hour limit", fiveHour, nowMs),
        windowView("weekly", "Weekly", "Weekly limit", weekly, nowMs),
      ],
    });
  }

  const newestMs = newest * 1000;
  return {
    kind: "ready",
    activePoolKey: poolKey,
    activePoolLabel: poolLabel,
    windows: [
      windowView("five-hour", "5h", "5-hour limit", fiveHour, nowMs),
      windowView("weekly", "Weekly", "Weekly limit", weekly, nowMs),
    ],
    pools: poolViews,
    updatedLabel:
      newestMs > 0 && newestMs < sessionStartMs ? `Updated ${duration((nowMs - newestMs) / 1000, false)} ago` : null,
  };
}
