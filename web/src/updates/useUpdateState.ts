import { useEffect, useState } from "react";
import { commands, type UpdateState } from "../bindings";
import { listenTo } from "../shared/ipc";

/**
 * The update state Core keeps (ADR-0021), live: read once, then replaced by every push. Core owns
 * it, so the titlebar button and the Settings section read the same answer. A check that failed
 * is silent: Core keeps its last answer and the window shows no error, so there is nothing to
 * catch here but an unreachable Core, which also stays silent.
 */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    const stop = listenTo<UpdateState>("update-state-changed", (pushed) => { if (live) setState(pushed); });
    void commands.updateState().then((current) => { if (live && current) setState((existing) => existing ?? current); }).catch(() => {});
    return () => { live = false; stop(); };
  }, []);
  return state;
}
