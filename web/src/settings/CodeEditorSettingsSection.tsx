import { useState } from "react";
import {
  AUTO_INDENT_OPTIONS,
  CURSOR_BLINKING_OPTIONS,
  CURSOR_STYLE_OPTIONS,
  DEFAULT_CODE_EDITOR_SETTINGS,
  getCodeEditorSettings,
  LINE_HEIGHT_OPTIONS,
  LINE_NUMBERS_OPTIONS,
  RENDER_WHITESPACE_OPTIONS,
  resetCodeEditorSettings,
  saveCodeEditorSettings,
  TAB_SIZE_OPTIONS,
  WORD_WRAP_OPTIONS,
  type CodeEditorSettings,
} from "../editor/codeEditorSettings";

interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

function SelectSetting<T extends string | number>({
  label,
  note,
  value,
  options,
  onChange,
}: {
  label: string;
  note?: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="settings-item">
      <div className="settings-item-label">
        <strong>{label}</strong>
        {note && <span className="settings-note">{note}</span>}
      </div>
      <div className="settings-item-controls">
        <select
          aria-label={label}
          value={String(value)}
          onChange={(event) => {
            const match = options.find((opt) => String(opt.value) === event.target.value);
            if (match) onChange(match.value);
          }}
        >
          {options.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ToggleSetting({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-item settings-toggle">
      <span className="settings-item-label">
        <strong>{label}</strong>
        {note && <span className="settings-note">{note}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

const WORD_WRAP_LABELS: Record<(typeof WORD_WRAP_OPTIONS)[number], string> = {
  off: "Off",
  on: "On",
  wordWrapColumn: "At column",
  bounded: "Bounded",
};

const LINE_NUMBER_LABELS: Record<(typeof LINE_NUMBERS_OPTIONS)[number], string> = {
  on: "On",
  off: "Off",
  relative: "Relative",
};

const WHITESPACE_LABELS: Record<(typeof RENDER_WHITESPACE_OPTIONS)[number], string> = {
  none: "None",
  boundary: "Boundary",
  selection: "Selection",
  trailing: "Trailing",
  all: "All",
};

const AUTO_INDENT_LABELS: Record<(typeof AUTO_INDENT_OPTIONS)[number], string> = {
  none: "None",
  keep: "Keep",
  brackets: "Brackets",
  advanced: "Advanced",
  full: "Full",
};

const CURSOR_STYLE_LABELS: Record<(typeof CURSOR_STYLE_OPTIONS)[number], string> = {
  line: "Line",
  block: "Block",
  underline: "Underline",
  "line-thin": "Thin line",
  "block-outline": "Block outline",
  "underline-thin": "Thin underline",
};

const CURSOR_BLINKING_LABELS: Record<(typeof CURSOR_BLINKING_OPTIONS)[number], string> = {
  blink: "Blink",
  smooth: "Smooth",
  phase: "Phase",
  expand: "Expand",
  solid: "Solid",
};

/** Settings → Code: VS Code-inspired Monaco editor preferences with live broadcast. */
export function CodeEditorSettingsSection() {
  const [settings, setSettings] = useState<CodeEditorSettings>(getCodeEditorSettings);

  const update = <K extends keyof CodeEditorSettings>(key: K, value: CodeEditorSettings[K]) => {
    setSettings(saveCodeEditorSettings({ ...settings, [key]: value }));
  };

  const isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_CODE_EDITOR_SETTINGS);

  return (
    <>
      <h3 className="settings-group-title">Indentation</h3>
      <div className="settings-card">
        <SelectSetting
          label="Tab size"
          note="Number of spaces a tab equals."
          value={settings.tabSize}
          options={TAB_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} spaces` }))}
          onChange={(value) => update("tabSize", value)}
        />
        <ToggleSetting
          label="Insert spaces"
          note="Insert spaces instead of tab characters when pressing Tab."
          checked={settings.insertSpaces}
          onChange={(checked) => update("insertSpaces", checked)}
        />
      </div>

      <h3 className="settings-group-title">Display</h3>
      <div className="settings-card">
        <SelectSetting
          label="Word wrap"
          note="Controls how long lines wrap in the editor."
          value={settings.wordWrap}
          options={WORD_WRAP_OPTIONS.map((opt) => ({ value: opt, label: WORD_WRAP_LABELS[opt] }))}
          onChange={(value) => update("wordWrap", value)}
        />
        <SelectSetting
          label="Line numbers"
          value={settings.lineNumbers}
          options={LINE_NUMBERS_OPTIONS.map((opt) => ({ value: opt, label: LINE_NUMBER_LABELS[opt] }))}
          onChange={(value) => update("lineNumbers", value)}
        />
        <ToggleSetting
          label="Minimap"
          note="Show a condensed code overview along the right edge."
          checked={settings.minimap}
          onChange={(checked) => update("minimap", checked)}
        />
        <ToggleSetting
          label="Sticky scroll"
          note="Pin enclosing scopes at the top of the editor while scrolling."
          checked={settings.stickyScroll}
          onChange={(checked) => update("stickyScroll", checked)}
        />
        <SelectSetting
          label="Render whitespace"
          value={settings.renderWhitespace}
          options={RENDER_WHITESPACE_OPTIONS.map((opt) => ({ value: opt, label: WHITESPACE_LABELS[opt] }))}
          onChange={(value) => update("renderWhitespace", value)}
        />
        <ToggleSetting
          label="Bracket pair colorization"
          checked={settings.bracketPairColorization}
          onChange={(checked) => update("bracketPairColorization", checked)}
        />
        <ToggleSetting
          label="Font ligatures"
          note="Enable OpenType ligatures when supported by the code font."
          checked={settings.fontLigatures}
          onChange={(checked) => update("fontLigatures", checked)}
        />
        <SelectSetting
          label="Line height"
          value={settings.lineHeight}
          options={LINE_HEIGHT_OPTIONS.map((height) => ({
            value: height,
            label: height === 0 ? "Default" : `${height}×`,
          }))}
          onChange={(value) => update("lineHeight", value)}
        />
      </div>

      <h3 className="settings-group-title">Editing &amp; scrolling</h3>
      <div className="settings-card">
        <SelectSetting
          label="Auto-indent"
          value={settings.autoIndent}
          options={AUTO_INDENT_OPTIONS.map((opt) => ({ value: opt, label: AUTO_INDENT_LABELS[opt] }))}
          onChange={(value) => update("autoIndent", value)}
        />
        <ToggleSetting
          label="Format on paste"
          checked={settings.formatOnPaste}
          onChange={(checked) => update("formatOnPaste", checked)}
        />
        <ToggleSetting
          label="Smooth scrolling"
          checked={settings.smoothScrolling}
          onChange={(checked) => update("smoothScrolling", checked)}
        />
        <ToggleSetting
          label="Scroll beyond last line"
          checked={settings.scrollBeyondLastLine}
          onChange={(checked) => update("scrollBeyondLastLine", checked)}
        />
      </div>

      <h3 className="settings-group-title">Cursor</h3>
      <div className="settings-card">
        <SelectSetting
          label="Cursor style"
          value={settings.cursorStyle}
          options={CURSOR_STYLE_OPTIONS.map((opt) => ({ value: opt, label: CURSOR_STYLE_LABELS[opt] }))}
          onChange={(value) => update("cursorStyle", value)}
        />
        <SelectSetting
          label="Cursor blinking"
          value={settings.cursorBlinking}
          options={CURSOR_BLINKING_OPTIONS.map((opt) => ({ value: opt, label: CURSOR_BLINKING_LABELS[opt] }))}
          onChange={(value) => update("cursorBlinking", value)}
        />
        <div className="settings-item settings-item-end">
          <button
            type="button"
            className="btn sm"
            disabled={isDefault}
            onClick={() => setSettings(resetCodeEditorSettings())}
          >
            Restore defaults
          </button>
        </div>
      </div>
    </>
  );
}
