import { activeTheme, isColor, themeColor } from "./appearance";
import type { editor } from "monaco-editor";
export function editorAppearance(): editor.IStandaloneThemeData {
  const theme = activeTheme();
  const css = getComputedStyle(document.documentElement);
  const color = (token: string, variable: string, fallback: string) =>
    themeColor(token, css.getPropertyValue(variable).trim() || fallback);
  const syntax = theme.style.syntax as
    | Record<
        string,
        { color?: string; font_style?: string; font_weight?: number }
      >
    | undefined;
  const foreground = (value: string) => {
    const raw = value.slice(1);
    return (
      raw.length <= 4 ? [...raw].map((char) => char + char).join("") : raw
    ).slice(0, 6);
  };
  return {
    base: theme.appearance === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "diff.added", foreground: foreground(color("version_control.added", "--green", "#5FCB8F")) },
      { token: "diff.removed", foreground: foreground(color("version_control.deleted", "--red", "#F27A72")) },
      { token: "diff.header", foreground: foreground(color("text.accent", "--acc2", "#58A6FF")) },
      ...Object.entries(syntax ?? {}).map(([token, rule]) => ({
        token,
        ...(isColor(rule.color) ? { foreground: foreground(rule.color) } : {}),
        fontStyle: [
          rule.font_style === "italic" ? "italic" : "",
          (rule.font_weight ?? 400) >= 600 ? "bold" : "",
        ]
          .filter(Boolean)
          .join(" "),
      })),
    ],
    colors: {
      "editor.background": color("editor.background", "--bg", "#1C1C1E"),
      "editor.foreground": color("editor.foreground", "--fg", "#E8E6E1"),
      "editorGutter.background": color(
        "editor.gutter.background",
        "--bg",
        "#1C1C1E",
      ),
      "editor.lineHighlightBackground": color(
        "editor.active_line.background",
        "--bg2",
        "#242426",
      ),
      "editorLineNumber.foreground": color(
        "editor.line_number",
        "--faint",
        "#9A9892",
      ),
      "editorLineNumber.activeForeground": color(
        "editor.active_line_number",
        "--fg",
        "#E8E6E1",
      ),
      "editor.selectionBackground": color(
        "editor.selection.background",
        "--bg4",
        "#2A4A78",
      ),
      "editorCursor.foreground": color("editor.cursor", "--acc2", "#58A6FF"),
      "editorIndentGuide.background1": color(
        "editor.indent_guide",
        "--line",
        "#333335",
      ),
      "editorWidget.background": color(
        "editor.widget.background",
        "--bg2",
        "#242426",
      ),
      "editorWidget.border": color("editor.widget.border", "--line", "#333335"),
      "editorSuggestWidget.background": color(
        "editor.widget.background",
        "--bg2",
        "#242426",
      ),
      "editorSuggestWidget.selectedBackground": color(
        "editor.selection.background",
        "--bg4",
        "#3A3A3C",
      ),
    },
  };
}
