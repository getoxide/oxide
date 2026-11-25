import { useState } from "react";
import { commands } from "../bindings";
import {
  BUNDLED_FONTS,
  DEFAULT_APPEARANCE,
  fontFamily,
  fontStyle,
  parseThemePack,
  type Appearance,
  type FontRole,
} from "../shared/appearance";
import { ThemeChoiceButton } from "./ThemeChoiceButton";

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

/** Oxide's built-in Titanium Dark and Light themes, the only ones Settings offers. */
const BUILT_IN_THEMES = parseThemePack(DEFAULT_APPEARANCE.themeJson).themes;

const SIZES = Array.from({ length: 13 }, (_, index) => index + 10);
const WEIGHTS = [
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semibold"],
  [700, "Bold"],
] as const;

interface AppearanceSettingsSectionProps {
  appearance: Appearance;
  error: string | null;
  onApply: (next: Appearance) => void;
}

/** Appearance preferences: theme selector, per-role font families, sizes and weights. */
export function AppearanceSettingsSection({
  appearance,
  error,
  onApply,
}: AppearanceSettingsSectionProps) {
  const [showAllFonts, setShowAllFonts] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);
  const [fontsLoading, setFontsLoading] = useState(false);
  const [fontsError, setFontsError] = useState<string | null>(null);

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

  const typography = (role: FontRole, patch: Partial<{ size: number; weight: number }>) =>
    onApply({
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
    <div className="settings-card">
      <div className="settings-item settings-item-stacked">
        <strong>Theme</strong>
        <div className="theme-choices" role="radiogroup" aria-label="Theme">
          {BUILT_IN_THEMES.map((variant) => (
            <ThemeChoiceButton
              key={variant.name}
              variant={variant}
              checked={variant.name === appearance.themeName}
              onSelect={() =>
                onApply({ ...appearance, themeId: undefined, themeJson: DEFAULT_APPEARANCE.themeJson, themeName: variant.name })
              }
            />
          ))}
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
              <select
                aria-label={`${label} font`}
                value={family}
                onChange={(event) => onApply({ ...appearance, fonts: { ...appearance.fonts, [key]: event.target.value } })}
              >
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
              <select
                aria-label={`${label} weight`}
                value={style.weight}
                onChange={(event) => typography(key, { weight: Number(event.target.value) })}
              >
                {WEIGHTS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
              <select
                aria-label={`${label} size`}
                value={style.size}
                onChange={(event) => typography(key, { size: Number(event.target.value) })}
              >
                {SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
              </select>
            </div>
          </div>
        );
      })}
      <div className="settings-item settings-item-end">
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn sm" disabled={isDefault} onClick={() => onApply(structuredClone(DEFAULT_APPEARANCE))}>
          Restore defaults
        </button>
      </div>
    </div>
  );
}
