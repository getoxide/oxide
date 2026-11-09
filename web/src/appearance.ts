export interface ThemeVariant {
  name: string;
  appearance: "dark" | "light";
  style: Record<string, unknown>;
}
export interface ThemePack {
  name: string;
  author?: string;
  themes: ThemeVariant[];
}
export interface Appearance {
  fonts: { ui: string; chat: string; code: string; terminal: string };
  typography?: Record<"ui" | "chat" | "code" | "terminal", { size: number; weight: number }>;
  themeJson: string;
  themeName: string;
}
// Bundled through fonts.css, so they win over installed copies; the rest cover scripts the subsets do not.
const SYSTEM =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, Menlo, monospace';
// Titanium values for the editor, terminal and syntax (assets/brand/oxide/palette/oxide-titanium-theme.json).
// Chrome colours stay in styles.css so the built-in theme keeps the focus ring and control tokens from :root.
const TITANIUM_DARK: Record<string, unknown> = {
  "editor.background": "#1C1C1E",
  "editor.foreground": "#E8E6E1",
  "editor.gutter.background": "#1C1C1E",
  "editor.line_number": "#7A7974",
  "editor.active_line_number": "#B3B1AB",
  "editor.active_line.background": "#242426",
  "editor.selection.background": "#2A4A78",
  "editor.cursor": "#E8E6E1",
  "editor.indent_guide": "#333335",
  "editor.widget.background": "#2C2C2E",
  "editor.widget.border": "#48484A",
  "terminal.background": "#1C1C1E",
  "terminal.foreground": "#E8E6E1",
  "terminal.cursor": "#58A6FF",
  "terminal.selection.background": "#2A4A78",
  "terminal.ansi.black": "#2C2C2E",
  "terminal.ansi.red": "#F27A72",
  "terminal.ansi.green": "#5FCB8F",
  "terminal.ansi.yellow": "#E8B84F",
  "terminal.ansi.blue": "#78A9F0",
  "terminal.ansi.magenta": "#C9A8F0",
  "terminal.ansi.cyan": "#7DD3D8",
  "terminal.ansi.white": "#E8E6E1",
  "terminal.ansi.bright_black": "#8A8883",
  "terminal.ansi.bright_red": "#FF9A92",
  "terminal.ansi.bright_green": "#86E0AE",
  "terminal.ansi.bright_yellow": "#F5CF7E",
  "terminal.ansi.bright_blue": "#9DC2F7",
  "terminal.ansi.bright_magenta": "#DBC2F9",
  "terminal.ansi.bright_cyan": "#A1E6EA",
  "terminal.ansi.bright_white": "#FFFFFF",
  "syntax": {
    "comment": {
      "color": "#9A9892",
      "font_style": "italic"
    },
    "keyword": {
      "color": "#C9A8F0"
    },
    "string": {
      "color": "#A8D5A2"
    },
    "number": {
      "color": "#E6B673"
    },
    "type": {
      "color": "#8FC1E8"
    },
    "identifier": {
      "color": "#E8E6E1"
    },
    "operator": {
      "color": "#B3B1AB"
    }
  }
};
export const BUNDLED_FONTS = [
  { label: "Inter (bundled)", value: SYSTEM },
  { label: "JetBrains Mono (bundled)", value: MONO },
];
export const DEFAULT_APPEARANCE: Appearance = {
  fonts: { ui: SYSTEM, chat: SYSTEM, code: MONO, terminal: MONO },
  typography: { ui: { size: 13, weight: 400 }, chat: { size: 14, weight: 400 }, code: { size: 13, weight: 400 }, terminal: { size: 13, weight: 400 } },
  themeJson: JSON.stringify(
    {
      name: "Oxide",
      themes: [{ name: "Oxide Dark", appearance: "dark", style: TITANIUM_DARK }],
    },
    null,
    2,
  ),
  themeName: "Oxide Dark",
};
const KEY = "oxide:appearance:v1";
export const COLOR_TOKENS: Record<string, string> = {
  background: "--bg",
  "surface.background": "--bg2",
  "elevated_surface.background": "--bg3",
  "element.background": "--bg4",
  text: "--fg",
  "text.bright": "--fg-bright",
  "text.muted": "--dim",
  "text.disabled": "--faint",
  "text.accent": "--acc2",
  border: "--line",
  "border.focused": "--line-strong",
  "element.border": "--gh-border",
  "element.hover": "--gh-btn-hover",
  "element.active": "--gh-btn-active",
  accent: "--acc",
  "accent.hover": "--acc-hover",
  "accent.foreground": "--acc-fg",
  error: "--red",
  success: "--green",
  warning: "--yellow",
  hint: "--purple",
};
const LIGHT: Record<string, string> = {
  background: "#FBFBFA",
  "surface.background": "#F2F1EE",
  "elevated_surface.background": "#E9E8E4",
  "element.background": "#DEDDD8",
  text: "#2C2C2E",
  "text.bright": "#1C1C1E",
  "text.muted": "#5F5E5A",
  "text.disabled": "#62615C",
  "text.accent": "#0860C7",
  border: "#DEDDD8",
  "border.focused": "#BDBCB7",
  "element.border": "#C7C6C1",
  "element.hover": "#E9E8E4",
  "element.active": "#DEDDD8",
  accent: "#0969DA",
  "accent.hover": "#0860C7",
  "accent.foreground": "#FFFFFF",
  error: "#C4281F",
  success: "#15703C",
  warning: "#8A5A00",
  hint: "#7148C0",
};
const LIGHT_ONLY_TOKENS: Record<string, string> = {
  "--acc-pressed": "#0757B5",
  "--diff-added-bg": "#15703C1F",
  "--diff-removed-bg": "#C4281F1F",
  "--attention-approval-bg": "#F7EBCB",
  "--attention-input-bg": "#DCE9F9",
  "--attention-error-bg": "#F9DEDC",
  "--attention-interrupted-bg": "#E9E8E4",
};
const TITANIUM_LIGHT_TERMINAL: Record<string, string> = {
  "terminal.background": "#FBFBFA",
  "terminal.foreground": "#2C2C2E",
  "terminal.cursor": "#0969DA",
  "terminal.selection.background": "#BCD6F5",
  "terminal.ansi.black": "#2C2C2E",
  "terminal.ansi.red": "#C4281F",
  "terminal.ansi.green": "#15703C",
  "terminal.ansi.yellow": "#8A5A00",
  "terminal.ansi.blue": "#0969DA",
  "terminal.ansi.magenta": "#7148C0",
  "terminal.ansi.cyan": "#0B7285",
  "terminal.ansi.white": "#62615C",
  "terminal.ansi.bright_black": "#62615C",
  "terminal.ansi.bright_red": "#A5201A",
  "terminal.ansi.bright_green": "#0F5A30",
  "terminal.ansi.bright_yellow": "#6E4700",
  "terminal.ansi.bright_blue": "#0757B5",
  "terminal.ansi.bright_magenta": "#5B38A0",
  "terminal.ansi.bright_cyan": "#095C6B",
  "terminal.ansi.bright_white": "#1C1C1E",
};
export function isColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
  );
}
export function parseThemePack(raw: string): ThemePack {
  if (raw.length > 1024 * 1024)
    throw new Error("Theme JSON must be smaller than 1 MiB.");
  const pack = JSON.parse(raw) as ThemePack;
  if (
    !pack ||
    typeof pack.name !== "string" ||
    !pack.name.trim() ||
    !Array.isArray(pack.themes) ||
    !pack.themes.length ||
    pack.themes.length > 64
  )
    throw new Error("Provide a name and a nonempty themes array.");
  const names = new Set<string>();
  for (const theme of pack.themes) {
    if (
      !theme ||
      typeof theme.name !== "string" ||
      !theme.name.trim() ||
      names.has(theme.name)
    )
      throw new Error("Each theme needs a unique name.");
    names.add(theme.name);
    if (theme.appearance !== "dark" && theme.appearance !== "light")
      throw new Error(`${theme.name}: appearance must be dark or light.`);
    if (
      !theme.style ||
      typeof theme.style !== "object" ||
      Array.isArray(theme.style)
    )
      throw new Error(`${theme.name}: style must be an object.`);
    for (const [key, value] of Object.entries(theme.style)) {
      if (
        (key in COLOR_TOKENS ||
          key.startsWith("terminal.") ||
          key.startsWith("editor.")) &&
        value !== null &&
        !isColor(value)
      )
        throw new Error(
          `${theme.name}: ${key} must be a hex color (#RGB, #RGBA, #RRGGBB or #RRGGBBAA).`,
        );
      if (key === "syntax") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("syntax must be an object.");
        for (const [token, rule] of Object.entries(value)) {
          if (
            !/^[\w.-]+$/.test(token) ||
            !rule ||
            typeof rule !== "object" ||
            Array.isArray(rule)
          )
            throw new Error(`Invalid syntax rule: ${token}.`);
          const r = rule as Record<string, unknown>;
          if (r.color !== undefined && r.color !== null && !isColor(r.color))
            throw new Error(`Invalid syntax color: ${token}.`);
          if (
            r.font_style !== undefined &&
            r.font_style !== null &&
            !["normal", "italic"].includes(String(r.font_style))
          )
            throw new Error(`Invalid font_style: ${token}.`);
          if (
            r.font_weight !== undefined &&
            r.font_weight !== null &&
            (typeof r.font_weight !== "number" ||
              r.font_weight < 100 ||
              r.font_weight > 900)
          )
            throw new Error(`Invalid font_weight: ${token}.`);
        }
      }
    }
  }
  return pack;
}
function load(): Appearance {
  try {
    const stored = JSON.parse(
      localStorage.getItem(KEY) ?? "null",
    ) as Appearance | null;
    if (!stored) return structuredClone(DEFAULT_APPEARANCE);
    validateAppearance(stored);
    return stored;
  } catch {
    return structuredClone(DEFAULT_APPEARANCE);
  }
}
export function validateAppearance(value: Appearance) {
  if (value.typography && Object.keys(DEFAULT_APPEARANCE.fonts).some((key) => {
    const style = value.typography?.[key as keyof Appearance["fonts"]];
    return !style || !Number.isInteger(style.size) || style.size < 10 || style.size > 32 || ![400, 500, 600, 700].includes(style.weight);
  })) throw new Error("Font sizes must be 10–32 px and weights must be Regular, Medium, Semibold or Bold.");
  if (
    !value.fonts ||
    Object.keys(DEFAULT_APPEARANCE.fonts).some(
      (key) =>
        typeof value.fonts[key as keyof Appearance["fonts"]] !== "string" ||
        !value.fonts[key as keyof Appearance["fonts"]].trim() ||
        value.fonts[key as keyof Appearance["fonts"]].length > 300,
    )
  )
    throw new Error(
      "Each font needs a family name or fallback list (up to 300 characters).",
    );
  if (
    !parseThemePack(value.themeJson).themes.some(
      (theme) => theme.name === value.themeName,
    )
  )
    throw new Error("Select a theme from this theme pack.");
}
let current = load();
let cachedTheme = parseThemePack(current.themeJson).themes.find(
  (theme) => theme.name === current.themeName,
)!;
export function getAppearance(): Appearance {
  return structuredClone(current);
}
export function activeTheme(): ThemeVariant {
  return cachedTheme;
}
export function themeColor(key: string, fallback: string): string {
  const color = activeTheme().style[key];
  return isColor(color) ? color : fallback;
}
export function applyAppearance(): void {
  const theme = activeTheme();
  const root = document.documentElement;
  for (const variable of Object.values(COLOR_TOKENS))
    root.style.removeProperty(variable);
  const colors = {
    ...(theme.appearance === "light" ? LIGHT : {}),
    ...Object.fromEntries(
      Object.entries(theme.style).filter(([, value]) => value !== null),
    ),
  };
  for (const [key, variable] of Object.entries(COLOR_TOKENS)) {
    if (isColor(colors[key])) root.style.setProperty(variable, colors[key]);
  }
  root.style.removeProperty("--gh-btn");
  root.style.removeProperty("--gh-blue");
  for (const [variable, value] of Object.entries(LIGHT_ONLY_TOKENS)) {
    if (theme.appearance === "light") root.style.setProperty(variable, value);
    else root.style.removeProperty(variable);
  }
  if (theme.appearance === "light")
    root.style.setProperty("--gh-btn", "var(--bg2)");
  else if (Object.keys(theme.style).length)
    root.style.setProperty("--gh-btn", "var(--bg3)");
  if (isColor(colors.accent))
    root.style.setProperty("--gh-blue", "var(--acc)");
  root.style.colorScheme = theme.appearance;
  root.dataset.appearance = theme.appearance;
  root.style.setProperty(
    "--terminal-background",
    themeColor("terminal.background", String(colors.background ?? TITANIUM_DARK["terminal.background"])),
  );
  for (const [key, family] of Object.entries(current.fonts))
    root.style.setProperty(`--font-${key}`, family);
  for (const key of Object.keys(current.fonts) as (keyof Appearance["fonts"])[]) {
    const style = fontStyle(key);
    root.style.setProperty(`--font-${key}-size`, `${style.size}px`);
    root.style.setProperty(`--font-${key}-weight`, String(style.weight));
  }
}
export function fontStyle(key: keyof Appearance["fonts"]) {
  return current.typography?.[key] ?? DEFAULT_APPEARANCE.typography![key];
}
export function saveAppearance(value: Appearance) {
  validateAppearance(value);
  localStorage.setItem(KEY, JSON.stringify(value));
  current = structuredClone(value);
  cachedTheme = parseThemePack(current.themeJson).themes.find(
    (theme) => theme.name === current.themeName,
  )!;
  applyAppearance();
  window.dispatchEvent(new Event("oxide-appearance-changed"));
}
export function terminalAppearance() {
  const fallbacks = activeTheme().appearance === "light" ? TITANIUM_LIGHT_TERMINAL : TITANIUM_DARK;
  const color = (token: string) => themeColor(token, String(fallbacks[token]));
  return {
    fontFamily: current.fonts.terminal,
    fontSize: fontStyle("terminal").size,
    fontWeight: fontStyle("terminal").weight,
    theme: {
      background: themeColor(
        "terminal.background",
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim() || String(fallbacks["terminal.background"]),
      ),
      foreground: color("terminal.foreground"),
      cursor: color("terminal.cursor"),
      selectionBackground: color("terminal.selection.background"),
      ...Object.fromEntries(
        [
          "black",
          "red",
          "green",
          "yellow",
          "blue",
          "magenta",
          "cyan",
          "white",
          "brightBlack",
          "brightRed",
          "brightGreen",
          "brightYellow",
          "brightBlue",
          "brightMagenta",
          "brightCyan",
          "brightWhite",
        ].map((key) => [
          key,
          color(`terminal.ansi.${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`),
        ]),
      ),
    },
  };
}
