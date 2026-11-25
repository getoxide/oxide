import { useEffect, useRef, useState } from "react";

/** How often an open GitHub panel reloads while the window is visible. */
export const REFRESH_INTERVAL_MS = 30_000;

/** How old the last tick must be before focus, the window showing again or a Surface being shown
 *  again asks GitHub once more: a quick switch away and back reuses what is on screen. */
export const REVALIDATE_AFTER_MS = 5_000;

export interface AutoRefreshOptions {
  /** Whether the Surface is shown. While false nothing ticks: no timer, no focus. */
  enabled?: boolean;
  /** The timer's period, e.g. faster while a pull request's checks run. */
  intervalMs?: number;
}

/** A counter that changes whenever GitHub should be asked again: on a timer that only runs while
 *  the window is visible, and, once the last tick is older than `REVALIDATE_AFTER_MS`, on window
 *  focus, on the window becoming visible and on the Surface being shown again. Pass it to
 *  `useQuery` as its soft `poll` token, so a tick never overlaps a fetch in flight. */
export function useAutoRefresh({ enabled = true, intervalMs = REFRESH_INTERVAL_MS }: AutoRefreshOptions = {}): number {
  const [tick, setTick] = useState(0);
  const last = useRef(Date.now());
  const wasEnabled = useRef(enabled);

  useEffect(() => {
    const revealed = enabled && !wasEnabled.current;
    wasEnabled.current = enabled;
    if (!enabled) return;
    const bump = () => {
      last.current = Date.now();
      setTick((n) => n + 1);
    };
    const revalidate = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= REVALIDATE_AFTER_MS) bump();
    };
    if (revealed) revalidate();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, intervalMs);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [enabled, intervalMs]);
  return tick;
}
