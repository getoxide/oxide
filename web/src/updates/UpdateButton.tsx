import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "@primer/octicons-react";
import { commands, type UpdateState } from "../bindings";
import { Popover } from "../shared/Popover";
import { openExternalLink } from "../shared/externalLink";
import { useUpdateState } from "./useUpdateState";

function percent(operation: Extract<UpdateState["operation"], { kind: "downloading" }>): number | null {
  if (!operation.total) return null;
  return Math.min(100, Math.floor(((operation.downloaded ?? 0) * 100) / operation.total));
}

/**
 * The titlebar's Update button: only while a newer release exists and this install is not a
 * development build. The popover names both versions, links the release notes and runs the
 * install: download with progress, then the restart question. Core owns every step, so a failure
 * simply returns here as an error with the install offered again.
 */
export function UpdateButton() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previous = useRef<string | undefined>(undefined);
  const kind = state?.operation.kind;
  useEffect(() => {
    // The restart question appears by itself the moment the install finishes.
    if (kind === "installed" && previous.current !== undefined && previous.current !== "installed") setOpen(true);
    previous.current = kind;
  }, [kind]);
  const available = state?.available;
  if (!state || !available || state.channel === "development") return null;
  const { operation } = state;
  const run = (start: () => Promise<unknown>) => {
    setProblem(null);
    void start().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  const shownError = problem ?? state.error;
  return (
    <>
      <button ref={trigger} className="btn sm update-btn" aria-label="Update available" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DownloadIcon size={14} />
        {operation.kind === "installed" ? "Restart" : "Update"}
      </button>
      {open && (
        <Popover anchor={trigger} label="Update available" width={280} onClose={() => setOpen(false)}>
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
          {operation.kind === "idle" && state.channel === "inApp" && (
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
                <button className="btn sm" onClick={() => setOpen(false)}>Later</button>
                <button className="btn sm primary" onClick={() => run(() => commands.restartForUpdate())}>Restart now</button>
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
