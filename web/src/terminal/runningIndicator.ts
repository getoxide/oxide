import { useEffect, useState } from "react";

/** How long a command runs before it shows as running: a faster one never flashes the running UI. */
export const RUNNING_INDICATOR_DELAY_MS = 300;

/**
 * Whether to show something as running: only once it has run for longer than
 * RUNNING_INDICATOR_DELAY_MS, and from then on until it stops. Time based, never by command.
 */
export function useRunningIndicator(running: boolean): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setOverdue(true), RUNNING_INDICATOR_DELAY_MS);
    // Reset when it stops, so the next run waits out the delay again (`running &&` covers the render between).
    return () => {
      clearTimeout(timer);
      setOverdue(false);
    };
  }, [running]);
  return running && overdue;
}
