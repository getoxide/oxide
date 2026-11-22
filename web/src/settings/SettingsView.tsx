import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { XIcon } from "@primer/octicons-react";
import { commands, type ThemeSummary } from "../bindings";
import {
  DEFAULT_APPEARANCE,
  getAppearance,
  parseThemePack,
  saveAppearance,
  type Appearance,
} from "../shared/appearance";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { CodeEditorSettingsSection } from "./CodeEditorSettingsSection";
import { GithubSetup } from "./GithubSetup";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { TerminalSettingsSection } from "./TerminalSettingsSection";
import type { ThemeEntry } from "./ThemeChoiceButton";
import { ThemesSettingsSection } from "./ThemesSettingsSection";
import { restoreSessionEnabled, setRestoreSession } from "../shared/session";

export type SettingsSectionId = "appearance" | "themes" | "terminal" | "code" | "session" | "shortcuts" | "github";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description?: string;
  render: () => ReactNode;
}

/** Settings: sectioned preferences (appearance, terminal, session, GitHub tools). */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("appearance");
  const [appearance, setAppearance] = useState(getAppearance);
  const [error, setError] = useState<string | null>(null);
  const [restoreSession, setRestore] = useState(restoreSessionEnabled);
  const [diskThemes, setDiskThemes] = useState<ThemeSummary[] | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const [themeError, setThemeError] = useState<string | null>(null);
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

  const themeEntries = useMemo<ThemeEntry[]>(() => {
    if (diskThemes) {
      const entries: ThemeEntry[] = [];
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

  const sections: SettingsSection[] = [
    {
      id: "appearance",
      label: "Appearance",
      description: "Changes apply right away.",
      render: () => (
        <AppearanceSettingsSection
          appearance={appearance}
          themeEntries={themeEntries}
          error={error}
          onApply={apply}
        />
      ),
    },
    {
      id: "themes",
      label: "Themes",
      description: "Disk-backed JSON themes in ~/.oxide/themes/.",
      render: () => (
        <ThemesSettingsSection
          appearance={appearance}
          themeEntries={themeEntries}
          brokenThemes={brokenThemes}
          themeError={themeError}
          onSetThemeError={setThemeError}
          onApply={apply}
          onReloadThemes={reloadThemes}
        />
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      description: "Applies to newly opened Terminals; running Terminals stay unaffected.",
      render: () => <TerminalSettingsSection />,
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
      id: "shortcuts",
      label: "Shortcuts",
      description: "Click a shortcut and press a new key combination. Bare Ctrl+letter keys stay reserved for the Terminal unless explicitly bound here.",
      render: () => <ShortcutsSettings />,
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
