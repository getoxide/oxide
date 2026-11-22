import { useState } from "react";
import { TrashIcon } from "@primer/octicons-react";
import { commands, type ThemeSummary } from "../bindings";
import { DEFAULT_APPEARANCE, parseThemePack, type Appearance } from "../shared/appearance";
import { ThemeChoiceButton, type ThemeEntry } from "./ThemeChoiceButton";

interface ThemesSettingsSectionProps {
  appearance: Appearance;
  themeEntries: ThemeEntry[];
  brokenThemes: ThemeSummary[];
  themeError: string | null;
  onSetThemeError: (error: string | null) => void;
  onApply: (next: Appearance) => void;
  onReloadThemes: () => void;
}

/** Disk-backed JSON theme management: browse, create, edit and delete custom themes. */
export function ThemesSettingsSection({
  appearance,
  themeEntries,
  brokenThemes,
  themeError,
  onSetThemeError,
  onApply,
  onReloadThemes,
}: ThemesSettingsSectionProps) {
  const [editingTheme, setEditingTheme] = useState<{ id: string; json: string; isNew: boolean } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  return (
    <div className="settings-card">
      <div className="settings-item settings-item-stacked">
        <div className="theme-toolbar">
          <button type="button" className="btn sm" onClick={() => void commands.openThemesFolder()}>
            Open themes folder
          </button>
          <button type="button" className="btn sm" onClick={onReloadThemes}>
            Reload from disk
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const base = themeEntries[0]?.json ?? appearance.themeJson;
              setEditingTheme({ id: "custom-theme", json: base, isNew: true });
              setEditorError(null);
            }}
          >
            New custom theme
          </button>
        </div>
        <div className="theme-choices" role="radiogroup" aria-label="Themes">
          {themeEntries.map(({ id, builtin, json, variant }) => {
            const checked =
              variant.name === appearance.themeName &&
              (!appearance.themeId || appearance.themeId === id);
            return (
              <div key={`${id}:${variant.name}`} className="theme-choice-wrap">
                <ThemeChoiceButton
                  id={id}
                  variant={variant}
                  checked={checked}
                  onSelect={() => onApply({ ...appearance, themeId: id, themeJson: json, themeName: variant.name })}
                />
                {!builtin && (
                  <div className="theme-choice-actions">
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Edit theme ${id}`}
                      onClick={() => {
                        setEditingTheme({ id, json, isNew: false });
                        setEditorError(null);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={`Delete theme ${id}`}
                      title={`Delete theme ${id}`}
                      onClick={() => {
                        void (async () => {
                          const res = await commands.deleteTheme(id);
                          if (res.status === "error") {
                            onSetThemeError(res.error.message);
                            return;
                          }
                          if (appearance.themeId === id) {
                            onApply({
                              ...appearance,
                              themeId: undefined,
                              themeJson: DEFAULT_APPEARANCE.themeJson,
                              themeName: DEFAULT_APPEARANCE.themeName,
                            });
                          }
                          onReloadThemes();
                        })();
                      }}
                    >
                      <TrashIcon size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {brokenThemes.length > 0 && (
          <div className="theme-diagnostics" aria-label="Theme diagnostics">
            {brokenThemes.map((item) => (
              <div key={item.id} className="theme-diagnostic">
                <strong>{item.id}.json</strong>: {item.error}
              </div>
            ))}
          </div>
        )}
        {themeError && <p className="error" role="alert">{themeError}</p>}
        {editingTheme && (
          <div className="theme-editor">
            <div className="theme-editor-header">
              <label>
                <span>File ID</span>
                <input
                  type="text"
                  aria-label="Theme file id"
                  value={editingTheme.id}
                  disabled={!editingTheme.isNew}
                  onChange={(event) => setEditingTheme({ ...editingTheme, id: event.target.value })}
                />
              </label>
              <div className="theme-toolbar">
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={Boolean(editorError)}
                  onClick={() => {
                    void (async () => {
                      try {
                        const pack = parseThemePack(editingTheme.json);
                        const res = await commands.saveTheme(editingTheme.id, editingTheme.json);
                        if (res.status === "error") {
                          setEditorError(res.error.message);
                          return;
                        }
                        onApply({
                          ...appearance,
                          themeId: res.data.id,
                          themeJson: editingTheme.json,
                          themeName: pack.themes[0].name,
                        });
                        setEditingTheme(null);
                        setEditorError(null);
                        onReloadThemes();
                      } catch (cause) {
                        setEditorError(cause instanceof Error ? cause.message : String(cause));
                      }
                    })();
                  }}
                >
                  Save theme
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setEditingTheme(null);
                    setEditorError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
            <textarea
              aria-label="Theme JSON"
              value={editingTheme.json}
              onChange={(event) => {
                const nextJson = event.target.value;
                setEditingTheme({ ...editingTheme, json: nextJson });
                try {
                  const pack = parseThemePack(nextJson);
                  setEditorError(null);
                  onApply({
                    ...appearance,
                    themeId: editingTheme.id,
                    themeJson: nextJson,
                    themeName: pack.themes[0].name,
                  });
                } catch (cause) {
                  setEditorError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
            />
            {editorError && <p className="error" role="alert">{editorError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
