// @vitest-environment jsdom
import kitThemeJson from "../../../assets/palette/oxide-titanium-theme.json?raw";
import kitTokensJson from "../../../assets/palette/oxide-tokens.json?raw";
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
  expect(rootStyle().getPropertyValue("--acc-pressed")).toBe(kitTokens.color.light["accent.pressed"]);
  const { theme } = terminalAppearance();
  expect(theme).toMatchObject(terminalColors(kitLight));
  expect(theme.foreground).toBe(kitLight["terminal.foreground"]);
  expect(theme.cursor).toBe(kitLight["terminal.cursor"]);
  expect(theme.selectionBackground).toBe(kitLight["terminal.selection.background"]);
});

it("falls back to Titanium Dark for a theme saved before the rebrand", async () => {
  const saved = {
    fonts: { ui: "-apple-system, sans-serif", code: "Menlo", terminal: "Menlo" },
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
    fonts: { ui: previousUi, code: previousMono, terminal: "Menlo" },
    themeJson: DEFAULT_APPEARANCE.themeJson,
    themeName: DEFAULT_APPEARANCE.themeName,
  }));
  vi.resetModules();
  const fresh = await import("./appearance");
  expect(fresh.getAppearance().fonts).toEqual({
    ui: DEFAULT_APPEARANCE.fonts.ui,
    code: DEFAULT_APPEARANCE.fonts.code,
    terminal: "Menlo",
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
  const { ui, code, terminal } = DEFAULT_APPEARANCE.fonts;
  for (const stack of [ui]) expect(stack).toMatch(/^Inter, .*sans-serif$/);
  for (const stack of [code, terminal]) expect(stack).toMatch(/^"JetBrains Mono", .*monospace$/);
  expect(DEFAULT_APPEARANCE.typography).toEqual({
    ui: { size: 13, weight: 400 },
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
    JSON.parse(localStorage.getItem("oxide:appearance:v1")!).fonts.terminal,
  ).toBe("Cascadia Code");
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
  typography.code = { size: 16, weight: 500 };
  saveAppearance({ ...old, typography });
  expect(terminalAppearance()).toMatchObject({ fontSize: 18, fontWeight: 700 });
  expect(document.documentElement.style.getPropertyValue("--font-code-size")).toBe("16px");
  expect(() => saveAppearance({ ...old, typography: { ...typography, ui: { size: 200, weight: 400 } } })).toThrow(/Font sizes/);
  expect(terminalAppearance().fontSize).toBe(18);
});

it("applies area-specific surface tokens and optional theme fonts, clearing them on fallback", () => {
  const customJson = JSON.stringify({
    name: "Studio",
    themes: [
      {
        name: "Studio Dark",
        appearance: "dark",
        fonts: {
          surfaces: "Georgia, serif",
        },
        style: {
          "title_bar.background": "#111111",
          "sidebar.background": "#121212",
          "sidebar.border": "#222222",
          "sidebar.foreground": "#eeeeee",
          "sidebar.item.hover": "#1f1f1f",
          "sidebar.item.active": "#2a2a2a",
          "sidebar.switch.background": "#181818",
          "sidebar.switch.active": "#303030",
          "surfaces.background": "#141414",
          "surfaces.header.background": "#191919",
          "surfaces.card.background": "#1d1d1d",
          "surfaces.border": "#2d2d2d",
          "surfaces.foreground": "#f0f0f0",
          "surfaces.font_size": 14,
          "tab_bar.background": "#151515",
          "tab.active_background": "#1c1c1c",
          "tab.inactive_background": "#141414",
          "tab.border": "#2b2b2b",
          "breadcrumbs.background": "#161616",
          "breadcrumbs.foreground": "#aaaaaa",
          "status_bar.background": "#171717",
          "status_bar.foreground": "#bbbbbb",
          "terminal.header.background": "#181818",
          "terminal.composer.background": "#1a1a1a",
          "terminal.block.border": "#2c2c2c",
          "terminal.block.running_rail": "#3399ff",
          "terminal.block.running_tint": "#3399ff22",
          "terminal.block.failed_rail": "#ff5555",
          "terminal.block.failed_tint": "#ff555522",
        },
      },
    ],
  });

  saveAppearance({
    ...getAppearance(),
    themeJson: customJson,
    themeName: "Studio Dark",
  });

  expect(rootStyle().getPropertyValue("--header-background")).toBe("#111111");
  expect(rootStyle().getPropertyValue("--sidebar-background")).toBe("#121212");
  expect(rootStyle().getPropertyValue("--sidebar-switch-active")).toBe("#303030");
  expect(rootStyle().getPropertyValue("--surfaces-card-background")).toBe("#1d1d1d");
  expect(rootStyle().getPropertyValue("--editor-tabs-background")).toBe("#151515");
  expect(rootStyle().getPropertyValue("--editor-breadcrumbs-foreground")).toBe("#aaaaaa");
  expect(rootStyle().getPropertyValue("--editor-status-bar-background")).toBe("#171717");
  expect(rootStyle().getPropertyValue("--terminal-header-background")).toBe("#181818");
  expect(rootStyle().getPropertyValue("--terminal-block-running-rail")).toBe("#3399ff");
  expect(rootStyle().getPropertyValue("--terminal-block-failed-tint")).toBe("#ff555522");
  expect(rootStyle().getPropertyValue("--font-surfaces")).toBe("Georgia, serif");
  expect(rootStyle().getPropertyValue("--font-surfaces-size")).toBe("14px");

  // Switching to a minimal partial theme clears area-specific overrides so fallbacks apply.
  saveAppearance(singleTheme("dark", { background: "#202020" }));
  expect(rootStyle().getPropertyValue("--sidebar-background")).toBe("");
  expect(rootStyle().getPropertyValue("--terminal-block-running-rail")).toBe("");
  expect(rootStyle().getPropertyValue("--font-surfaces-size")).toBe("13px");
});

it("supports independent font, size, and weight for GitHub Surfaces with fallback to Interface", () => {
  const base = getAppearance();
  expect(document.documentElement.style.getPropertyValue("--font-surfaces")).toBe(base.fonts.ui);
  expect(document.documentElement.style.getPropertyValue("--font-surfaces-size")).toBe("13px");
  expect(document.documentElement.style.getPropertyValue("--font-surfaces-weight")).toBe("400");

  saveAppearance({
    ...base,
    fonts: { ...base.fonts, surfaces: "Georgia" },
    typography: {
      ui: { size: 13, weight: 400 },
      code: { size: 13, weight: 400 },
      terminal: { size: 13, weight: 400 },
      surfaces: { size: 15, weight: 600 },
    },
  });
  expect(document.documentElement.style.getPropertyValue("--font-surfaces")).toBe("Georgia");
  expect(document.documentElement.style.getPropertyValue("--font-surfaces-size")).toBe("15px");
  expect(document.documentElement.style.getPropertyValue("--font-surfaces-weight")).toBe("600");

  expect(() =>
    saveAppearance({ ...getAppearance(), fonts: { ...base.fonts, surfaces: "   " } }),
  ).toThrow(/Each font/);
});
