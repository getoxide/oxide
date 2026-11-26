import { useState } from "react";
import { commands } from "../bindings";
import { UpdateInstallFlow } from "./UpdateInstallFlow";
import { useUpdateStateControl } from "./useUpdateState";

// The bindings type a float as `number | null` (a non-finite float serializes to null).
const whenText = (seconds: number | null) => (seconds === null ? "an unknown time" : new Date(seconds * 1000).toLocaleString());

/**
 * Settings > Updates: the installed version, the last check and whether it worked, "Check for
 * updates", and the same install flow as the titlebar button over the one state Core keeps. A
 * check that failed (no network) is reported only here.
 */
export function UpdatesSettingsSection() {
  const { state, replace } = useUpdateStateControl();
  const [problem, setProblem] = useState<string | null>(null);
  if (!state) return null;
  const busy = state.checking || state.operation.kind !== "idle";
  const checkNow = () => {
    setProblem(null);
    void commands.checkForUpdates().then((result) => {
      if (result.status === "ok") replace(result.data);
      else setProblem(result.error);
    }).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  const lastCheck = state.lastCheck ?? null;
  const available = state.available ?? null;
  const lastSuccess = state.lastCheckedAt ?? null;
  const development = state.channel === "development";
  let status: string;
  if (development) status = "This is a development build: it does not check for updates.";
  else if (state.checking) status = "Checking…";
  else if (!lastCheck) status = "Not checked yet";
  else if (!lastCheck.succeeded) status = `Last check failed on ${whenText(lastCheck.at)}. Oxide could not reach the update server.`;
  else if (available) status = `Version ${available.version} is available. Checked ${whenText(lastCheck.at)}.`;
  else status = `Up to date. Checked ${whenText(lastCheck.at)}.`;
  return (
    <div className="settings-card">
      <div className="settings-item">
        <span className="settings-item-label">
          <strong>Oxide {state.currentVersion}</strong>
          <span className="settings-note" role="status">{status}</span>
          {!development && lastCheck && !lastCheck.succeeded && lastSuccess !== null && (
            <span className="settings-note">Last successful check: {whenText(lastSuccess)}.</span>
          )}
        </span>
        {!development && (
          <button className="btn sm" disabled={busy} onClick={checkNow}>Check for updates</button>
        )}
      </div>
      {problem && <p role="alert" className="error update-message">{problem}</p>}
      {!development && available && <UpdateInstallFlow state={state} available={available} />}
    </div>
  );
}
