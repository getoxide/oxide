import { useState } from "react";
import { commands, type UpdateState } from "../bindings";
import { openExternalLink } from "../shared/externalLink";

type Available = NonNullable<UpdateState["available"]>;

function percent(operation: Extract<UpdateState["operation"], { kind: "downloading" }>): number | null {
  if (!operation.total) return null;
  return Math.min(100, Math.floor(((operation.downloaded ?? 0) * 100) / operation.total));
}

/**
 * The version details, release-notes link and install flow of a newer release: download with
 * progress, then the restart question. The titlebar popover and the Settings section both render
 * this over the one state Core keeps, so an install started in either shows in both. Core owns
 * every step, so a failure simply returns here as an error with the install offered again.
 */
export function UpdateInstallFlow({
  state,
  available,
  onLater,
}: {
  state: UpdateState;
  available: Available;
  /** Shown as "Later" beside "Restart now"; omit where there is nothing to dismiss. */
  onLater?: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const { operation } = state;
  const run = (start: () => Promise<unknown>) => {
    setProblem(null);
    void start().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  const shownError = problem ?? state.error;
  return (
    <>
      <dl className="update-popover">
        <dt>Installed</dt>
        <dd>{state.currentVersion}</dd>
        <dt>New version</dt>
        <dd>{available.version}</dd>
      </dl>
      <a
        className="update-notes"
        href={available.releaseNotesUrl}
        onClick={(event) => { event.preventDefault(); void openExternalLink(available.releaseNotesUrl); }}
      >
        Release notes
      </a>
      {shownError && <p role="alert" className="error update-message">{shownError}</p>}
      {state.installLocation === "moveToApplications" && (
        <p role="note" className="update-message update-location-notice">
          Move Oxide to your Applications folder, then open it from there to update. Oxide is running from a disk
          image, Downloads or another place where an update would fail or land in the wrong spot.
        </p>
      )}
      {operation.kind === "idle" && state.channel === "inApp" && state.installLocation !== "moveToApplications" && (
        <div className="update-actions">
          <button className="btn sm primary" onClick={() => run(() => commands.installUpdate())}>
            {shownError ? "Try again" : "Install update"}
          </button>
        </div>
      )}
      {operation.kind === "downloading" && (
        <div className="update-message">
          <progress value={operation.downloaded ?? 0} max={operation.total ?? undefined} aria-label="Download progress" />
          <span>{percent(operation) === null ? "Downloading…" : `Downloading… ${percent(operation)}%`}</span>
        </div>
      )}
      {operation.kind === "installing" && <p className="update-message">Verifying and installing…</p>}
      {operation.kind === "installed" && (
        <>
          <p className="update-message">
            {available.version} is installed. Restart now to use it: running Terminal programs will end, and unsaved
            files are asked about as when you quit.
            {operation.staged && " On Windows the update is applied when Oxide quits."}
          </p>
          <div className="update-actions">
            {onLater && <button className="btn sm" onClick={onLater}>Later</button>}
            <button className="btn sm primary" onClick={() => run(() => commands.restartForUpdate())}>Restart now</button>
          </div>
        </>
      )}
    </>
  );
}
