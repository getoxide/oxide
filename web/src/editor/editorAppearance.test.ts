// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import kitThemeJson from "../../../assets/palette/oxide-titanium-theme.json?raw";
import { DEFAULT_APPEARANCE, getAppearance, saveAppearance } from "../shared/appearance";
import { editorAppearance } from "./editorAppearance";

const kitDark = (JSON.parse(kitThemeJson) as { themes: { appearance: string; style: Record<string, string> }[] }).themes.find((theme) => theme.appearance === "dark")!.style;
afterEach(() => saveAppearance(structuredClone(DEFAULT_APPEARANCE)));

it("falls back to Titanium Dark when neither the theme nor the page provides a colour", () => {
  saveAppearance({
    ...getAppearance(),
    themeName: "Bare",
    themeJson: JSON.stringify({ name: "Bare", themes: [{ name: "Bare", appearance: "dark", style: {} }] }),
  });
  const { colors, rules } = editorAppearance();
  expect(colors).toMatchObject({
    "editor.background": kitDark["editor.background"],
    "editor.foreground": kitDark["editor.foreground"],
    "editorGutter.background": kitDark["editor.gutter.background"],
    "editor.lineHighlightBackground": kitDark["editor.active_line.background"],
    "editor.selectionBackground": kitDark["editor.selection.background"],
    "editorIndentGuide.background1": kitDark["editor.indent_guide"],
  });
  expect(rules.find((rule) => rule.token === "diff.added")?.foreground).toBe(kitDark.success.slice(1));
  expect(rules.find((rule) => rule.token === "diff.removed")?.foreground).toBe(kitDark.error.slice(1));
});

it("applies custom editor colors and syntax rules from a custom theme", () => {
  saveAppearance({
    ...getAppearance(),
    themeName: "Custom Editor",
    themeJson: JSON.stringify({
      name: "Custom",
      themes: [
        {
          name: "Custom Editor",
          appearance: "dark",
          style: {
            "editor.background": "#101112",
            "editor.foreground": "#EEEEEE",
            "editor.gutter.background": "#131415",
            "editor.line_number": "#555555",
            "editor.active_line_number": "#FFFFFF",
            "editor.active_line.background": "#18191A",
            "editor.selection.background": "#224466",
            "editor.cursor": "#FFCC00",
            "editor.indent_guide": "#2A2B2C",
            "editor.widget.background": "#1B1C1D",
            "editor.widget.border": "#3A3B3C",
            syntax: {
              keyword: { color: "#FF79C6", font_weight: 700 },
              comment: { color: "#6272A4", font_style: "italic" },
            },
          },
        },
      ],
    }),
  });

  const { base, colors, rules } = editorAppearance();
  expect(base).toBe("vs-dark");
  expect(colors).toMatchObject({
    "editor.background": "#101112",
    "editor.foreground": "#EEEEEE",
    "editorGutter.background": "#131415",
    "editorLineNumber.foreground": "#555555",
    "editorLineNumber.activeForeground": "#FFFFFF",
    "editor.lineHighlightBackground": "#18191A",
    "editor.selectionBackground": "#224466",
    "editorCursor.foreground": "#FFCC00",
    "editorIndentGuide.background1": "#2A2B2C",
    "editorWidget.background": "#1B1C1D",
    "editorWidget.border": "#3A3B3C",
  });
  expect(rules.find((r) => r.token === "keyword")).toMatchObject({
    foreground: "FF79C6",
    fontStyle: "bold",
  });
  expect(rules.find((r) => r.token === "comment")).toMatchObject({
    foreground: "6272A4",
    fontStyle: "italic",
  });
});
