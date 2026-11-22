import { useEffect, useState } from "react";
import { commands, type AvailableShell, type ShellKind, type TerminalSettings } from "../bindings";

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = { shell: "default", loadUserConfig: true };
const DEFAULT_AVAILABLE_SHELLS: AvailableShell[] = [{ kind: "default", label: "System default", isDefault: true }];

/** Terminal shell and startup configuration preferences. */
export function TerminalSettingsSection() {
  const [availableShells, setAvailableShells] = useState<AvailableShell[]>(DEFAULT_AVAILABLE_SHELLS);
  const [terminalSettings, setTerminalSettingsState] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void commands.availableShells().then((shells) => {
      if (active && Array.isArray(shells) && shells.length > 0) setAvailableShells(shells);
    }).catch(() => {});
    void commands.terminalSettings().then((result) => {
      if (!active || !result) return;
      if (result.status === "error") {
        setTerminalError(result.error.message);
        return;
      }
      if (result.data) setTerminalSettingsState(result.data);
    }).catch((cause) => {
      if (active) setTerminalError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, []);

  const updateTerminalSettings = async (next: TerminalSettings) => {
    setTerminalError(null);
    try {
      const result = await commands.setTerminalSettings(next);
      if (result.status === "error") throw new Error(result.error.message);
      setTerminalSettingsState(result.data);
    } catch (cause) {
      setTerminalError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-item">
        <div className="settings-item-label">
          <strong>Shell</strong>
          <span className="settings-note">
            Choose the interactive shell Oxide launches for new Terminals.
          </span>
        </div>
        <div className="settings-item-controls">
          <select
            aria-label="Shell"
            value={terminalSettings.shell}
            onChange={(event) => void updateTerminalSettings({
              ...terminalSettings,
              shell: event.target.value as ShellKind,
            })}
          >
            {availableShells.map((shell) => (
              <option key={shell.kind} value={shell.kind}>{shell.label}</option>
            ))}
          </select>
        </div>
      </div>
      <label className="settings-item settings-toggle">
        <span className="settings-item-label">
          <strong>Load user configuration</strong>
          <span className="settings-note">
            Sources your shell&rsquo;s profile and rc files at startup. Turn off to start a clean shell with Command blocks still enabled.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Load user configuration"
          checked={terminalSettings.loadUserConfig}
          onChange={(event) => void updateTerminalSettings({
            ...terminalSettings,
            loadUserConfig: event.target.checked,
          })}
        />
      </label>
      {terminalError && <p className="error" role="alert">{terminalError}</p>}
    </div>
  );
}
