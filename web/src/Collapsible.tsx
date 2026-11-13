import { useEffect, useState, type ReactNode } from "react";

const COLLAPSE_MS = 160;

/**
 * Animated expand/collapse wrapper using CSS grid `0fr <-> 1fr` and opacity.
 * Keeps content unmounted when collapsed so closed sections hold zero layout or tab cost.
 */
export function Collapsible({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  if (open && !mounted) setMounted(true);
  if (!open && shown) setShown(false);

  useEffect(() => {
    if (open) {
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    if (!mounted) return;
    const timer = window.setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  if (!mounted) return null;
  return (
    <div
      className={`collapsible${shown && open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden={!open || undefined}
    >
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}
