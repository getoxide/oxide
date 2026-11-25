import { useEffect, useRef, useState } from "react";

/** How often an open GitHub panel reloads while the window is visible. */
export const REFRESH_INTERVAL_MS = 30_000;

/** How old the last tick must be before focus, the window showing again or a Surface being shown
 *  again asks GitHub once more: a quick switch away and back reuses what is on screen. */
export const REVALIDATE_AFTER_MS = 5_000;

export interface AutoRefreshOptions {
  /** Whether the Surface is shown. While false nothing ticks: no timer, no focus. Turning it on
   *  is the Surface being shown again, the one change that revalidates. */
  enabled?: boolean;
  /** The timer's period, e.g. faster while a pull request's checks run; `null` runs no timer,
   *  leaving only focus, visibility and reveal. Changing it never revalidates by itself. */
  intervalMs?: number | null;
  /** How many timer ticks to give before the timer stops, counted from when the Surface was
   *  shown or the period or this limit last changed. Focus and visibility still revalidate. */
  maxTicks?: number;
}

/** A counter that changes whenever GitHub should be asked again: on a timer that only runs while
 *  the window is visible, and, once the last tick is older than `REVALIDATE_AFTER_MS`, on window
 *  focus, on the window becoming visible and on the Surface being shown again. Pass it to
 *  `useQuery` as its soft `poll` token, so a tick never overlaps a fetch in flight. */
export function useAutoRefresh({ enabled = true, intervalMs = REFRESH_INTERVAL_MS, maxTicks = Infinity }: AutoRefreshOptions = {}): number {
  const [tick, setTick] = useState(0);
  // When the last tick (or the mount) happened; set in an effect, since render must stay pure.
  const last = useRef(0);
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    last.current = Date.now();
  }, []);

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
    let ticks = 0;
    const timer =
      intervalMs === null
        ? undefined
        : setInterval(() => {
            if (ticks >= maxTicks) return clearInterval(timer);
            if (document.visibilityState !== "visible") return;
            ticks += 1;
            bump();
          }, intervalMs);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [enabled, intervalMs, maxTicks]);
  return tick;
}
