import { useEffect, useState } from "react";
import { listenTo } from "./ipc";
import { commands } from "../bindings";
import { saveAllEditors } from "../editor/editorSaves";

/** Asks before quitting while editors hold unsaved changes; the shell sends `editor-quit-requested` with how many. */
export function QuitDialog() {
  const [unsaved, setUnsaved] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    return listenTo<number>("editor-quit-requested", (count) => { setUnsaved(count); setSaveError(null); });
  }, []);
  if (unsaved === null) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-label="Unsaved editor changes">
        <h2>Save your files before quitting?</h2>
        <p>{unsaved} editor {unsaved === 1 ? "has" : "have"} unsaved changes. Quitting also ends running terminals.</p>
        {saveError && <p role="alert" className="error">{saveError}</p>}
        <div className="modal-actions">
          <button autoFocus disabled={saving} onClick={() => { void commands.cancelQuit(); setUnsaved(null); }}>Cancel</button>
          <button disabled={saving} onClick={() => void commands.confirmQuit()}>Discard &amp; quit</button>
          <button className="primary" disabled={saving} onClick={() => {
            setSaving(true);
            void saveAllEditors()
              .then(async (saved) => {
                if (saved) await commands.confirmQuit();
                else setSaveError("Some files could not be saved. Cancel to review the editor errors.");
              })
              .catch((e: Error) => setSaveError(e.message))
              .finally(() => setSaving(false));
          }}>{saving ? "Saving…" : "Save all & quit"}</button>
        </div>
      </div>
    </div>
  );
}
