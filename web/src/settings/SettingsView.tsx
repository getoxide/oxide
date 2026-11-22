import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, XIcon } from "@primer/octicons-react";
import { commands, type AvailableShell, type ShellKind, type TerminalSettings } from "../bindings";
import {
  BUNDLED_FONTS,
  DEFAULT_APPEARANCE,
  fontFamily,
  fontStyle,
  getAppearance,
  parseThemePack,
  saveAppearance,
  type Appearance,
  type FontRole,
  type ThemeVariant,
} from "../shared/appearance";
import { GithubSetup } from "./GithubSetup";
import { CodeEditorSettingsSection } from "./CodeEditorSettingsSection";
import { restoreSessionEnabled, setRestoreSession } from "../shared/session";

export type SettingsSectionId = "appearance" | "terminal" | "code" | "session" | "github";

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
  { key: "surfaces", label: "Issues & Pull requests", sample: "Reviewing #544 · ready for merge" },
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
  surfaces: [
    { label: "Inter", value: BUNDLED_FONTS[0].value },
    { label: "System", value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
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

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = { shell: "default", loadUserConfig: true };
const DEFAULT_AVAILABLE_SHELLS: AvailableShell[] = [{ kind: "default", label: "System default", isDefault: true }];

/** Settings: sectioned preferences (appearance, terminal, session, GitHub tools). */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("appearance");
  const [appearance, setAppearance] = useState(getAppearance);
  const [error, setError] = useState<string | null>(null);
  const [restoreSession, setRestore] = useState(restoreSessionEnabled);
  const [showAllFonts, setShowAllFonts] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);
  const [fontsLoading, setFontsLoading] = useState(false);
  const [fontsError, setFontsError] = useState<string | null>(null);
  const [availableShells, setAvailableShells] = useState<AvailableShell[]>(DEFAULT_AVAILABLE_SHELLS);
  const [terminalSettings, setTerminalSettingsState] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});

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

  const loadSystemFonts = async () => {
    setFontsLoading(true);
    setFontsError(null);
    try {
      const result = await commands.systemFonts();
      if (result.status === "ok") {
        if (result.data.length === 0) {
          setSystemFonts([]);
          setFontsError("No additional system fonts were found.");
        } else {
          setSystemFonts(result.data);
        }
      } else {
        setSystemFonts(null);
        setFontsError(result.error.message || "Could not load system fonts.");
      }
    } catch (cause) {
      setSystemFonts(null);
      setFontsError(cause instanceof Error ? cause.message : "Could not load system fonts.");
    } finally {
      setFontsLoading(false);
    }
  };

  const handleToggleAllFonts = (checked: boolean) => {
    setShowAllFonts(checked);
    if (checked && !fontsLoading && (!systemFonts || systemFonts.length === 0)) {
      void loadSystemFonts();
    }
  };

  const themes = useMemo(() => {
    try {
      return parseThemePack(appearance.themeJson).themes;
    } catch {
      return [];
    }
  }, [appearance.themeJson]);

  const apply = (next: Appearance) => {
    try {
      saveAppearance(next);
      setAppearance(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

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
              {themes.map((theme) => {
                const colors = swatch(theme);
                const checked = theme.name === appearance.themeName;
                return (
                  <button key={theme.name} type="button" role="radio" aria-checked={checked} className="theme-choice"
                    onClick={() => apply({ ...appearance, themeName: theme.name })}>
                    <span className="theme-swatch" aria-hidden="true" style={{ background: colors.background, color: colors.foreground }}>
                      <span>Aa</span>
                      <i style={{ background: colors.accent }} />
                      <i style={{ background: colors.second }} />
                    </span>
                    <span className="theme-choice-name">
                      {theme.name}
                      {checked && <CheckIcon size={12} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-item">
            <div className="settings-item-label">
              <strong>Show all system fonts</strong>
              <span className="settings-note">
                Reveal every font installed on your system alongside Oxide&rsquo;s recommended fonts.
              </span>
            </div>
            <div className="settings-item-controls">
              {fontsLoading && <span className="settings-note">Loading fonts…</span>}
              {showAllFonts && fontsError && (
                <>
                  <span className="settings-note" role="status">{fontsError}</span>
                  <button type="button" className="btn sm" onClick={() => { void loadSystemFonts(); }}>
                    Retry
                  </button>
                </>
              )}
              <input
                type="checkbox"
                role="switch"
                aria-label="Show all system fonts"
                checked={showAllFonts}
                onChange={(event) => handleToggleAllFonts(event.target.checked)}
              />
            </div>
          </div>
          {ROLES.map(({ key, label, sample }) => {
            const style = { ...fontStyle(key), ...appearance.typography?.[key] };
            const family = appearance.fonts[key] ?? fontFamily(key);
            const recommended = FONT_CHOICES[key];
            const visibleSystemFonts =
              showAllFonts && systemFonts
                ? systemFonts.filter((name) => !recommended.some((choice) => choice.value === name))
                : [];
            const needsCustomOption =
              !recommended.some((choice) => choice.value === family) &&
              !visibleSystemFonts.includes(family);
            const recommendedChoices = needsCustomOption
              ? [...recommended, { label: family, value: family }]
              : recommended;
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
                    {visibleSystemFonts.length > 0 ? (
                      <>
                        <optgroup label="Recommended">
                          {recommendedChoices.map((choice) => (
                            <option key={choice.value} value={choice.value}>{choice.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="System fonts">
                          {visibleSystemFonts.map((name) => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </optgroup>
                      </>
                    ) : (
                      recommendedChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{choice.label}</option>
                      ))
                    )}
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
      id: "terminal",
      label: "Terminal",
      description: "Applies to newly opened Terminals; running Terminals stay unaffected.",
      render: () => (
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
      ),
    },
    {
      id: "code",
      label: "Code",
      description: "Editor options apply immediately to every open Code workspace.",
      render: () => <CodeEditorSettingsSection />,
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
