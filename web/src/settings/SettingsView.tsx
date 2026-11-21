import { useMemo, useState } from "react";
import { CheckIcon, XIcon } from "@primer/octicons-react";
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

/** Settings: appearance (applied as soon as it is chosen) and the GitHub tools. */
export function SettingsView({ onClose }: { onClose: () => void }) {
  const [appearance, setAppearance] = useState(getAppearance);
  const [error, setError] = useState<string | null>(null);
  const [restoreSession, setRestore] = useState(restoreSessionEnabled);
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

  return (
    <main className="centre settings-view" aria-label="Settings">
      <div className="settings-page">
        <header className="settings-header">
          <h1>Settings</h1>
          <button className="icon-btn" aria-label="Close settings" title="Close settings" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </header>

        <section className="settings-section" aria-labelledby="settings-appearance">
          <h2 id="settings-appearance">Appearance</h2>
          <p className="settings-note">Changes apply right away.</p>
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
        </section>

        <section className="settings-section" aria-labelledby="settings-session">
          <h2 id="settings-session">Session</h2>
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
        </section>

        <section className="settings-section" aria-labelledby="settings-github">
          <h2 id="settings-github">GitHub</h2>
          <p className="settings-note">Issues and Pull request work through Git and the GitHub CLI.</p>
          <div className="settings-card">
            <GithubSetup />
          </div>
        </section>
      </div>
    </main>
  );
}
