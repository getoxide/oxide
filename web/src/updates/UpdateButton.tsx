import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "@primer/octicons-react";
import { Popover } from "../shared/Popover";
import { UpdateInstallFlow } from "./UpdateInstallFlow";
import { useUpdateState } from "./useUpdateState";

/**
 * The titlebar's Update button: only while a newer release exists and this install is not a
 * development build. The popover holds the shared install flow (also shown in Settings).
 */
export function UpdateButton() {
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
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
  return (
    <>
      <button ref={trigger} className="btn sm update-btn" aria-label="Update available" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DownloadIcon size={14} />
        {state.operation.kind === "installed" ? "Restart" : "Update"}
      </button>
      {open && (
        <Popover anchor={trigger} label="Update available" width={280} onClose={() => setOpen(false)}>
          <UpdateInstallFlow state={state} available={available} onLater={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}
