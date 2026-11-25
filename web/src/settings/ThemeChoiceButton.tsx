import { CheckIcon } from "@primer/octicons-react";
import type { ThemeVariant } from "../shared/appearance";

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

interface ThemeChoiceButtonProps {
  variant: ThemeVariant;
  checked: boolean;
  onSelect: () => void;
}

/** Radio button displaying a theme variant's swatch and name. */
export function ThemeChoiceButton({ variant, checked, onSelect }: ThemeChoiceButtonProps) {
  const colors = swatch(variant);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="theme-choice"
      onClick={onSelect}
    >
      <span
        className="theme-swatch"
        aria-hidden="true"
        style={{ background: colors.background, color: colors.foreground }}
      >
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
}
