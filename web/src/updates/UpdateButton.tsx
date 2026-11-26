import { useRef, useState } from "react";
import { DownloadIcon } from "@primer/octicons-react";
import { Popover } from "../shared/Popover";
import { openExternalLink } from "../shared/externalLink";
import { useUpdateState } from "./useUpdateState";

/**
 * The titlebar's Update button: only while a newer release exists and this install is not a
 * development build. The popover names both versions and links the release notes; installing
 * comes with the next slice.
 */
export function UpdateButton() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const available = state?.available;
  if (!state || !available || state.channel === "development") return null;
  return (
    <>
      <button ref={trigger} className="btn sm update-btn" aria-label="Update available" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DownloadIcon size={14} />
        Update
      </button>
      {open && (
        <Popover anchor={trigger} label="Update available" width={260} onClose={() => setOpen(false)}>
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
        </Popover>
      )}
    </>
  );
}
