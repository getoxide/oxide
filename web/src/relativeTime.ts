function parseElapsedMs(iso: string, nowMs: number): { then: Date; ms: number } | null {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) return null;
  return { then: new Date(thenMs), ms: nowMs - thenMs };
}

function formatSubDay(seconds: number): string | null {
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return null;
}

/** "5m", "3h", "2d", "4w", "8mo", "2y": short enough for a narrow row. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const parsed = parseElapsedMs(iso, now);
  if (!parsed) return "";
  const s = Math.max(0, Math.round(parsed.ms / 1000));
  const subDay = formatSubDay(s);
  if (subDay !== null) return subDay;
  const steps: [number, string][] = [
    [86400, "d"],
    [604800, "w"],
    [2592000, "mo"],
    [31536000, "y"],
  ];
  let unit = steps[0]!;
  for (const step of steps) if (s >= step[0]) unit = step;
  return `${Math.floor(s / unit[0])}${unit[1]}`;
}

/** "now", "5m", "3h", "yesterday", "4d", then a short date: how long ago a Thread last moved. */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const parsed = parseElapsedMs(iso, now.getTime());
  if (!parsed) return "";
  const s = Math.max(0, Math.floor(parsed.ms / 1000));
  const subDay = formatSubDay(s);
  if (subDay !== null) return subDay;
  const days = Math.floor(s / 86400);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return parsed.then.toLocaleDateString([], { day: "numeric", month: "short" });
}
