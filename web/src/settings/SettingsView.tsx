import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, TrashIcon, XIcon } from "@primer/octicons-react";
import { commands, type ThemeSummary } from "../bindings";
import {
  BUNDLED_FONTS,
  DEFAULT_APPEARANCE,
  fontStyle,
  getAppearance,
  parseThemePack,
  saveAppearance,
  type Appearance,
  type ThemeVariant,
} from "../shared/appearance";
import { GithubSetup } from "./GithubSetup";
import { restoreSessionEnabled, setRestoreSession } from "../shared/session";

type FontRole = keyof Appearance["fonts"];

export type SettingsSectionId = "appearance" | "themes" | "session" | "github";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description?: string;
  render: () => ReactNode;
}

const ROLES: { key: FontRole; label: string; sample: string }[] = [
  { key: "ui", label: "Interface", sample: "Projects, tabs and buttons" },
  { key: "code", label: "Code editor", sample: "const answer = 42;" },
  { key: "terminal", label: "Terminal", sample: "~/project $ git status" },
];
const FONT_CHOICES: Record<FontRole, { label: string; value: string }[]> = {
  ui: [
    { label: "Inter", value: BUNDLED_FONTS[0].value },
    { label: "System", value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  ],
  code: [
    { label: "JetBrains Mono", value: BUNDLED_FONTS[1].value },
    { label: "System monospace", value: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, Menlo, monospace' },
  ],
  terminal: [
    { label: "JetBrains Mono", value: BUNDLED_FONTS[1].value },
    { label: "System monospace", value: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, Menlo, monospace' },
  ],
};
const SIZES = Array.from({ length: 13 }, (_, index) => index + 10);
const WEIGHTS = [[400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"]] as const;

/** The swatch colours of a theme variant: its background and two of its terminal colours. */
function swatch(theme: ThemeVariant) {
  const color = (key: string, fallback: string) => {
    const value = theme.style[key];
    return typeof value === "string" ? value : fallback;
  };
  const dark = theme.appearance === "dark";
  return {
    background: color("editor.background", color("background", dark ? "#1C1C1E" : "#FBFBFA")),
    foreground: color("editor.foreground", color("text", dark ? "#E8E6E1" : "#2C2C2E")),
    accent: color("terminal.ansi.blue", dark ? "#78A9F0" : "#0969DA"),
    second: color("terminal.ansi.green", dark ? "#5FCB8F" : "#15703C"),
  };
}

/** Settings: sectioned preferences (appearance, session, GitHub tools). */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("appearance");
  const [appearance, setAppearance] = useState(getAppearance);
  const [error, setError] = useState<string | null>(null);
  const [restoreSession, setRestore] = useState(restoreSessionEnabled);
  const [diskThemes, setDiskThemes] = useState<ThemeSummary[] | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [editingTheme, setEditingTheme] = useState<{ id: string; json: string; isNew: boolean } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});

  const apply = useCallback((next: Appearance) => {
    try {
      saveAppearance(next);
      setAppearance(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const reloadThemes = useCallback(() => {
    setThemeRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    void commands.listThemes().then((result) => {
      if (!active) return;
      if (result.status === "error") {
        setThemeError(result.error.message);
        return;
      }
      if (!Array.isArray(result.data)) return;
      setDiskThemes(result.data);
      setThemeError(null);
      const currentId = getAppearance().themeId;
      if (currentId) {
        const match = result.data.find((item) => item.id === currentId);
        if (!match || !match.json) {
          apply({
            ...getAppearance(),
            themeId: undefined,
            themeJson: DEFAULT_APPEARANCE.themeJson,
            themeName: DEFAULT_APPEARANCE.themeName,
          });
        }
      }
    }).catch((cause) => {
      if (active) setThemeError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [apply, themeRevision]);

  const themeEntries = useMemo(() => {
    if (diskThemes) {
      const entries: { id: string; builtin: boolean; json: string; variant: ThemeVariant }[] = [];
      for (const item of diskThemes) {
        if (!item.json) continue;
        try {
          const pack = parseThemePack(item.json);
          for (const variant of pack.themes) {
            entries.push({ id: item.id, builtin: item.builtin, json: item.json, variant });
          }
        } catch {
          // Invalid pack on disk is surfaced via item.error diagnostics.
        }
      }
      return entries;
    }
    try {
      return parseThemePack(appearance.themeJson).themes.map((variant) => ({
        id: appearance.themeId ?? variant.name.toLowerCase().replace(/\s+/g, "-"),
        builtin: true,
        json: appearance.themeJson,
        variant,
      }));
    } catch {
      return [];
    }
  }, [appearance.themeId, appearance.themeJson, diskThemes]);

  const brokenThemes = useMemo(
    () => (diskThemes ?? []).filter((item) => Boolean(item.error)),
    [diskThemes],
  );

  const typography = (role: FontRole, patch: Partial<{ size: number; weight: number }>) =>
    apply({
      ...appearance,
      typography: {
        ui: fontStyle("ui"),
        code: fontStyle("code"),
        terminal: fontStyle("terminal"),
        ...appearance.typography,
        [role]: { ...fontStyle(role), ...appearance.typography?.[role], ...patch },
      },
    });

  const isDefault = JSON.stringify(appearance) === JSON.stringify(DEFAULT_APPEARANCE);

  const sections: SettingsSection[] = [
    {
      id: "appearance",
      label: "Appearance",
      description: "Changes apply right away.",
      render: () => (
        <div className="settings-card">
          <div className="settings-item settings-item-stacked">
            <strong>Theme</strong>
            <div className="theme-choices" role="radiogroup" aria-label="Theme">
              {themeEntries.map(({ id, json, variant }) => {
                const colors = swatch(variant);
                const checked = variant.name === appearance.themeName && (!appearance.themeId || appearance.themeId === id);
                return (
                  <button key={`${id}:${variant.name}`} type="button" role="radio" aria-checked={checked} className="theme-choice"
                    onClick={() => apply({ ...appearance, themeId: id, themeJson: json, themeName: variant.name })}>
                    <span className="theme-swatch" aria-hidden="true" style={{ background: colors.background, color: colors.foreground }}>
                      <span>Aa</span>
                      <i style={{ background: colors.accent }} />
                      <i style={{ background: colors.second }} />
                    </span>
                    <span className="theme-choice-name">
                      {variant.name}
                      {checked && <CheckIcon size={12} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {ROLES.map(({ key, label, sample }) => {
            const style = { ...fontStyle(key), ...appearance.typography?.[key] };
            const family = appearance.fonts[key];
            const choices = FONT_CHOICES[key].some((choice) => choice.value === family)
              ? FONT_CHOICES[key]
              : [...FONT_CHOICES[key], { label: family, value: family }];
            return (
              <div className="settings-item" key={key}>
                <div className="settings-item-label">
                  <strong>{label}</strong>
                  <span className="settings-font-sample" style={{ fontFamily: family, fontSize: style.size, fontWeight: style.weight }}>
                    {sample}
                  </span>
                </div>
                <div className="settings-item-controls">
                  <select aria-label={`${label} font`} value={family}
                    onChange={(event) => apply({ ...appearance, fonts: { ...appearance.fonts, [key]: event.target.value } })}>
                    {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </select>
                  <select aria-label={`${label} weight`} value={style.weight}
                    onChange={(event) => typography(key, { weight: Number(event.target.value) })}>
                    {WEIGHTS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  </select>
                  <select aria-label={`${label} size`} value={style.size}
                    onChange={(event) => typography(key, { size: Number(event.target.value) })}>
                    {SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
                  </select>
                </div>
              </div>
            );
          })}
          <div className="settings-item settings-item-end">
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn sm" disabled={isDefault} onClick={() => apply(structuredClone(DEFAULT_APPEARANCE))}>
              Restore defaults
            </button>
          </div>
        </div>
      ),
    },
    {
      id: "themes",
      label: "Themes",
      description: "Disk-backed JSON themes in ~/.oxide/themes/.",
      render: () => (
        <div className="settings-card">
          <div className="settings-item settings-item-stacked">
            <div className="theme-toolbar">
              <button type="button" className="btn sm" onClick={() => void commands.openThemesFolder()}>
                Open themes folder
              </button>
              <button type="button" className="btn sm" onClick={() => reloadThemes()}>
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
                const colors = swatch(variant);
                const checked = variant.name === appearance.themeName && (!appearance.themeId || appearance.themeId === id);
                return (
                  <div key={`${id}:${variant.name}`} className="theme-choice-wrap">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      data-theme-id={id}
                      className="theme-choice"
                      onClick={() => apply({ ...appearance, themeId: id, themeJson: json, themeName: variant.name })}
                    >
                      <span className="theme-swatch" aria-hidden="true" style={{ background: colors.background, color: colors.foreground }}>
                        <span>Aa</span>
                        <i style={{ background: colors.accent }} />
                        <i style={{ background: colors.second }} />
                      </span>
                      <span className="theme-choice-name">
                        {variant.name}
                        {checked && <CheckIcon size={12} />}
                      </span>
                    </button>
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
                                setThemeError(res.error.message);
                                return;
                              }
                              if (appearance.themeId === id) {
                                apply({
                                  ...appearance,
                                  themeId: undefined,
                                  themeJson: DEFAULT_APPEARANCE.themeJson,
                                  themeName: DEFAULT_APPEARANCE.themeName,
                                });
                              }
                              reloadThemes();
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
                            apply({
                              ...appearance,
                              themeId: res.data.id,
                              themeJson: editingTheme.json,
                              themeName: pack.themes[0].name,
                            });
                            setEditingTheme(null);
                            setEditorError(null);
                            reloadThemes();
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
                      apply({
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
      ),
    },
    {
      id: "session",
      label: "Session",
      render: () => (
        <div className="settings-card">
          <label className="settings-item settings-toggle">
            <span className="settings-item-label">
              <strong>Restore Terminals and files at launch</strong>
              <span className="settings-note">
                Reopens each Project&rsquo;s Terminals with their folder and recent output, and the files open in Code.
                Programs that were running start again from a fresh shell. Turning this off forgets the saved session.
              </span>
            </span>
            <input type="checkbox" role="switch" checked={restoreSession}
              onChange={(event) => { setRestoreSession(event.target.checked); setRestore(event.target.checked); }} />
          </label>
        </div>
      ),
    },
    {
      id: "github",
      label: "GitHub",
      description: "Issues and Pull request work through Git and the GitHub CLI.",
      render: () => (
        <div className="settings-card">
          <GithubSetup />
        </div>
      ),
    },
  ];

  const selectSection = (id: SettingsSectionId, focus = false) => {
    setActiveSection(id);
    if (focus) tabRefs.current[id]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % sections.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + sections.length) % sections.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = sections.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectSection(sections[nextIndex].id, true);
  };

  return (
    <main className="centre settings-view" aria-label="Settings">
      <div className="settings-page">
        <header className="settings-header">
          <h1>Settings</h1>
          <button className="icon-btn" aria-label="Close settings" title="Close settings" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            <div className="settings-tablist" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
              {sections.map((section, index) => {
                const isActive = section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    ref={(element) => { tabRefs.current[section.id] = element; }}
                    type="button"
                    role="tab"
                    id={`settings-tab-${section.id}`}
                    className="settings-nav-item"
                    aria-selected={isActive}
                    aria-controls={`settings-panel-${section.id}`}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => selectSection(section.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    {section.label}
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="settings-content">
            {sections.map((section) => {
              const isActive = section.id === activeSection;
              return (
                <section
                  key={section.id}
                  id={`settings-panel-${section.id}`}
                  className="settings-section"
                  role="tabpanel"
                  aria-labelledby={`settings-tab-${section.id}`}
                  hidden={!isActive}
                >
                  <h2>{section.label}</h2>
                  {section.description && <p className="settings-note">{section.description}</p>}
                  {section.render()}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
