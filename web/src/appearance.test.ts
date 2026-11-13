// @vitest-environment jsdom
import kitThemeJson from "../../assets/brand/oxide/palette/oxide-titanium-theme.json?raw";
import kitTokensJson from "../../assets/brand/oxide/palette/oxide-tokens.json?raw";
import { beforeEach, expect, it, vi } from "vitest";
import {
  activeTheme,
  COLOR_TOKENS,
  DEFAULT_APPEARANCE,
  getAppearance,
  parseThemePack,
  saveAppearance,
  terminalAppearance,
} from "./appearance";

// The brand kit is the source of truth, so expected values come from it rather than from the code under test.
const kit = JSON.parse(kitThemeJson) as { themes: { name: string; appearance: "dark" | "light"; style: Record<string, unknown> }[] };
const kitDark = kit.themes.find((theme) => theme.appearance === "dark")!.style;
const kitLight = kit.themes.find((theme) => theme.appearance === "light")!.style;
const kitTokens = JSON.parse(kitTokensJson) as { color: Record<"dark" | "light", Record<string, string>> };
const rootStyle = () => document.documentElement.style;
const singleTheme = (appearance: "dark" | "light", style: Record<string, unknown> = {}) => ({
  ...getAppearance(),
  themeName: "Plain",
  themeJson: JSON.stringify({ name: "Plain", themes: [{ name: "Plain", appearance, style }] }),
});
const terminalColors = (style: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(style)
      .filter(([key]) => key.startsWith("terminal.ansi."))
      .map(([key, value]) => [key.slice("terminal.ansi.".length).replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()), value]),
  );

beforeEach(() => {
  saveAppearance(structuredClone(DEFAULT_APPEARANCE));
});

it("opens a fresh profile on the Titanium editor, syntax and terminal colours", () => {
  const style = activeTheme().style;
  for (const key of Object.keys(kitDark).filter((key) => key.startsWith("editor.") || key.startsWith("terminal.") || key === "syntax"))
    expect(style[key], key).toEqual(kitDark[key]);
  const { theme } = terminalAppearance();
  expect(theme).toMatchObject(terminalColors(kitDark));
  expect(Object.keys(terminalColors(kitDark))).toHaveLength(16);
  expect(theme.background).toBe(kitDark["terminal.background"]);
});
it("gives a light theme without colours the Titanium Light chrome, focus ring and terminal", () => {
  saveAppearance(singleTheme("light"));
  for (const [key, variable] of Object.entries(COLOR_TOKENS))
    expect(rootStyle().getPropertyValue(variable), key).toBe(kitLight[key]);
  expect(rootStyle().getPropertyValue("--gh-blue")).toBe("var(--acc)");
  expect(kitTokens.color.light["focus.ring"]).toBe(kitLight.accent);
  expect(rootStyle().getPropertyValue("--attention-approval-bg")).toBe(kitTokens.color.light["attention.approval.background"]);
  expect(rootStyle().getPropertyValue("--attention-input-bg")).toBe(kitTokens.color.light["attention.input.background"]);
  expect(rootStyle().getPropertyValue("--attention-error-bg")).toBe(kitTokens.color.light["attention.error.background"]);
  expect(rootStyle().getPropertyValue("--attention-interrupted-bg")).toBe(kitTokens.color.light["attention.interrupted.background"]);
  expect(rootStyle().getPropertyValue("--acc-pressed")).toBe(kitTokens.color.light["accent.pressed"]);
  expect(rootStyle().getPropertyValue("--diff-added-bg")).toBe(kitTokens.color.light["diff.added.background"]);
  expect(rootStyle().getPropertyValue("--diff-removed-bg")).toBe(kitTokens.color.light["diff.removed.background"]);
  const { theme } = terminalAppearance();
  expect(theme).toMatchObject(terminalColors(kitLight));
  expect(theme.foreground).toBe(kitLight["terminal.foreground"]);
  expect(theme.cursor).toBe(kitLight["terminal.cursor"]);
  expect(theme.selectionBackground).toBe(kitLight["terminal.selection.background"]);
});

it("drops the light attention surfaces again when returning to a dark theme", () => {
  saveAppearance(singleTheme("light"));
  saveAppearance(structuredClone(DEFAULT_APPEARANCE));
  expect(rootStyle().getPropertyValue("--attention-approval-bg")).toBe("");
});

it("falls back to Titanium Dark for a theme saved before the rebrand", async () => {
  const saved = {
    fonts: { ui: "-apple-system, sans-serif", chat: "Arial", code: "Menlo", terminal: "Menlo" },
    themeJson: JSON.stringify({ name: "Oxide", themes: [{ name: "Oxide Dark", appearance: "dark", style: {} }] }),
    themeName: "Oxide Dark",
  };
  localStorage.setItem("oxide:appearance:v1", JSON.stringify(saved));
  vi.resetModules();
  const fresh = await import("./appearance");
  expect(fresh.getAppearance()).toMatchObject(saved);
  const { theme } = fresh.terminalAppearance();
  expect(theme).toMatchObject(terminalColors(kitDark));
  expect(theme.foreground).toBe(kitDark["terminal.foreground"]);
  expect(theme.background).toBe(kitDark["terminal.background"]);
});

it("moves the previous default font stacks to the bundled families and leaves chosen fonts alone", async () => {
  const previousUi = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif';
  const previousMono = '"Cascadia Code", "SFMono-Regular", Consolas, Menlo, monospace';
  localStorage.setItem("oxide:appearance:v1", JSON.stringify({
    fonts: { ui: previousUi, chat: "Georgia", code: previousMono, terminal: previousMono },
    themeJson: DEFAULT_APPEARANCE.themeJson,
    themeName: DEFAULT_APPEARANCE.themeName,
  }));
  vi.resetModules();
  const fresh = await import("./appearance");
  expect(fresh.getAppearance().fonts).toEqual({
    ui: DEFAULT_APPEARANCE.fonts.ui,
    chat: "Georgia",
    code: DEFAULT_APPEARANCE.fonts.code,
    terminal: DEFAULT_APPEARANCE.fonts.terminal,
  });
});

it("gives a profile that stored the previous built-in theme the Titanium one", async () => {
  const previousBuiltIn = JSON.stringify({ name: "Oxide", themes: [{ name: "Oxide Dark", appearance: "dark", style: {} }] }, null, 2);
  localStorage.setItem("oxide:appearance:v1", JSON.stringify({
    fonts: DEFAULT_APPEARANCE.fonts,
    themeJson: previousBuiltIn,
    themeName: "Oxide Dark",
  }));
  vi.resetModules();
  const fresh = await import("./appearance");
  expect(fresh.getAppearance().themeJson).toBe(DEFAULT_APPEARANCE.themeJson);
  expect(fresh.activeTheme().style.syntax).toEqual(kitDark.syntax);
});

it("offers built-in Oxide Light alongside Oxide Dark and applies Titanium Light tokens", () => {
  const themes = parseThemePack(DEFAULT_APPEARANCE.themeJson).themes;
  expect(themes.map((t) => t.name)).toEqual(["Oxide Dark", "Oxide Light"]);
  saveAppearance({ ...DEFAULT_APPEARANCE, themeName: "Oxide Light" });
  expect(activeTheme().appearance).toBe("light");
  expect(document.documentElement.dataset.appearance).toBe("light");
  expect(rootStyle().getPropertyValue("--bg")).toBe(kitLight.background);
  expect(activeTheme().style.syntax).toEqual(kitLight.syntax);
});

it("imports both variants of the Titanium theme pack", () => {
  for (const variant of parseThemePack(kitThemeJson).themes) {
    saveAppearance({ ...getAppearance(), themeJson: kitThemeJson, themeName: variant.name });
    expect(activeTheme().appearance).toBe(variant.appearance);
    expect(rootStyle().getPropertyValue("--bg")).toBe(variant.style.background);
    expect(terminalAppearance().theme).toMatchObject({ brightWhite: variant.style["terminal.ansi.bright_white"] });
  }
});

it("defaults to the bundled families with system fallbacks and keeps the documented sizes", () => {
  const { ui, chat, code, terminal } = DEFAULT_APPEARANCE.fonts;
  for (const stack of [ui, chat]) expect(stack).toMatch(/^Inter, .*sans-serif$/);
  for (const stack of [code, terminal]) expect(stack).toMatch(/^"JetBrains Mono", .*monospace$/);
  expect(DEFAULT_APPEARANCE.typography).toEqual({
    ui: { size: 13, weight: 400 },
    chat: { size: 14, weight: 400 },
    code: { size: 13, weight: 400 },
    terminal: { size: 13, weight: 400 },
  });
});

it("applies a selected JSON theme across UI and terminal and persists separate font families", () => {
  const themeJson = JSON.stringify({
    name: "Custom",
    themes: [
      {
        name: "Paper",
        appearance: "light",
        style: {
          background: "#fafafa",
          text: "#202020",
          "terminal.background": "#eeeeee",
          "terminal.foreground": "#111111",
          syntax: { keyword: { color: "#334455", font_style: "italic" } },
        },
      },
    ],
  });
  saveAppearance({
    ...getAppearance(),
    themeJson,
    themeName: "Paper",
    fonts: {
      ui: "Inter",
      chat: "Arial",
      code: "Consolas",
      terminal: "Cascadia Code",
    },
  });
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe(
    "#fafafa",
  );
  expect(document.documentElement.style.getPropertyValue("--font-code")).toBe(
    "Consolas",
  );
  expect(terminalAppearance().theme.background).toBe("#eeeeee");
  expect(activeTheme().appearance).toBe("light");
  expect(
    JSON.parse(localStorage.getItem("oxide:appearance:v1")!).fonts.chat,
  ).toBe("Arial");
});
it("rejects malformed or unsafe theme values and keeps the previous appearance", () => {
  const before = getAppearance();
  expect(() => saveAppearance({ ...before, themeJson: "{broken" })).toThrow();
  expect(getAppearance()).toEqual(before);
  expect(() =>
    parseThemePack(
      JSON.stringify({
        name: "Bad",
        themes: [
          {
            name: "Bad",
            appearance: "dark",
            style: { background: "url(https://example.com/a)" },
          },
        ],
      }),
    ),
  ).toThrow(/hex color/);
  expect(() =>
    parseThemePack(
      JSON.stringify({
        name: "Bad",
        themes: [
          {
            name: "Bad",
            appearance: "dark",
            style: { syntax: { keyword: { color: "#nope" } } },
          },
        ],
      }),
    ),
  ).toThrow(/syntax color/);
});

it("applies size and weight to each area and preserves legacy appearance settings", () => {
  const old = { ...getAppearance(), typography: undefined };
  saveAppearance(old);
  expect(terminalAppearance()).toMatchObject({ fontSize: 13, fontWeight: 400 });
  const typography = structuredClone(DEFAULT_APPEARANCE.typography!);
  typography.terminal = { size: 18, weight: 700 };
  typography.chat = { size: 16, weight: 500 };
  saveAppearance({ ...old, typography });
  expect(terminalAppearance()).toMatchObject({ fontSize: 18, fontWeight: 700 });
  expect(document.documentElement.style.getPropertyValue("--font-chat-size")).toBe("16px");
  expect(() => saveAppearance({ ...old, typography: { ...typography, ui: { size: 200, weight: 400 } } })).toThrow(/Font sizes/);
  expect(terminalAppearance().fontSize).toBe(18);
});
