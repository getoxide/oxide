import { useEffect, useId, useRef, useState } from "react";
import { XIcon } from "@primer/octicons-react";
import { usageView, type UsageSeverity, type UsageWindowView } from "./usageLimits";
import { SESSION_START_MS, useNow, useUsageLimits } from "./useUsageLimits";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const STROKE: Record<UsageSeverity, string> = {
  normal: "var(--acc)",
  warning: "var(--yellow)",
  critical: "var(--red)",
};

function providerDisplayName(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "antigravity" || p === "agy") return "Antigravity";
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function Ring({
  window,
  updatedLabel,
  onClick,
}: {
  window: UsageWindowView;
  updatedLabel: string | null;
  onClick: () => void;
}) {
  const tooltipId = useId();
  return (
    <div className="usage-item">
      <button
        type="button"
        className="usage-btn"
        aria-label={`${window.ariaLabel} · Click for all limits`}
        aria-describedby={tooltipId}
        onClick={onClick}
      >
        <span className="usage-label">{window.label}</span>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="usage-ring-track" cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="2.5" />
          <circle
            className="usage-ring-fill"
            cx="9"
            cy="9"
            r={RADIUS}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke={STROKE[window.severity]}
            strokeDasharray={`${window.fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
        <span className="usage-countdown">{window.countdown}</span>
      </button>
      <div className="usage-popover" id={tooltipId} role="tooltip">
        <strong className="usage-title">{window.title}</strong>
        <p className="usage-detail">{window.detail}</p>
        <p className="usage-hint">Click to see all limits</p>
        {updatedLabel && <p className="usage-updated">{updatedLabel}</p>}
      </div>
    </div>
  );
}

/**
 * The Provider's Usage limits for the active Model, each as a labelled ring with the time left until
 * it resets; clicking a ring reveals a detailed breakdown of all pools and limits for this Provider.
 * Hidden for a Provider that reports no Usage limits.
 */
export function UsageRing({
  provider,
  model,
  reportsUsage,
}: {
  provider: string;
  model?: string | null;
  reportsUsage: boolean;
}) {
  const limits = useUsageLimits(provider, reportsUsage);
  const now = useNow();
  const [detailedOpen, setDetailedOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!detailedOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setDetailedOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailedOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [detailedOpen]);

  const view = usageView(limits, reportsUsage, now, SESSION_START_MS, provider, model ?? null);
  if (view.kind === "hidden") return null;

  return (
    <div className="usage-rings" ref={rootRef}>
      {view.windows.map((window) => (
        <Ring
          key={window.key}
          window={window}
          updatedLabel={view.updatedLabel}
          onClick={() => setDetailedOpen((open) => !open)}
        />
      ))}
      {detailedOpen && (
        <div className="usage-details-popover" role="dialog" aria-label="Usage limits details">
          <div className="usage-details-header">
            <div className="usage-details-title-row">
              <strong className="usage-details-title">{providerDisplayName(provider)} limits</strong>
              <button
                type="button"
                className="icon-btn sm"
                onClick={() => setDetailedOpen(false)}
                aria-label="Close details"
              >
                <XIcon size={12} />
              </button>
            </div>
            <div className="usage-details-subtitle">
              <span>Active model: <strong>{model || "Default"}</strong></span>
              <span className="chip sm">{view.activePoolLabel}</span>
            </div>
          </div>
          <div className="usage-details-pools">
            {view.pools.map((pool) => (
              <div key={pool.key} className={`usage-pool-card${pool.isActive ? " active-pool" : ""}`}>
                <div className="usage-pool-header">
                  <span className="usage-pool-name">{pool.label}</span>
                  {pool.isActive && <span className="chip sm active-chip">Selected model</span>}
                </div>
                <div className="usage-pool-windows">
                  {pool.windows.map((win) => (
                    <div key={win.key} className="usage-pool-window-row">
                      <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
                        <circle className="usage-ring-track" cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="2.5" />
                        <circle
                          className="usage-ring-fill"
                          cx="9"
                          cy="9"
                          r={RADIUS}
                          fill="none"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          stroke={STROKE[win.severity]}
                          strokeDasharray={`${win.fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                          transform="rotate(-90 9 9)"
                        />
                      </svg>
                      <span className="usage-pool-window-label">{win.title}:</span>
                      <span className="usage-pool-window-detail">{win.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {view.updatedLabel && <p className="usage-updated">{view.updatedLabel}</p>}
        </div>
      )}
    </div>
  );
}
