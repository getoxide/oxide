import { XIcon } from "@primer/octicons-react";

/** The Settings page. It is empty on purpose: every old option is gone, and new ones are added deliberately. */
export function SettingsView({ onClose }: { onClose: () => void }) {
  return (
    <main className="centre settings-view" aria-label="Settings">
      <header className="settings-header">
        <h1>Settings</h1>
        <button className="icon-btn" aria-label="Close settings" title="Close settings" onClick={onClose}>
          <XIcon size={14} />
        </button>
      </header>
    </main>
  );
}
