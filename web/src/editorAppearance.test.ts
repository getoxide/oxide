// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import kitThemeJson from "../../assets/brand/oxide/palette/oxide-titanium-theme.json?raw";
import { DEFAULT_APPEARANCE, getAppearance, saveAppearance } from "./appearance";
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
