import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist", "src/bindings.ts", "web/dist", "web/src/bindings.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  { languageOptions: { globals: globals.browser } },
  {
    // HTML sinks are how hostile text becomes markup. The only exceptions are the two documented
    // `eslint-disable-next-line` sites (highlighted code in ItemContent, chip markup in ComposerInput).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "HTML sink: render text as React children instead." },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: "HTML sink: render text as React children instead." },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]", message: "HTML sink: use textContent or DOM nodes instead." },
      ],
    },
  },
  {
    // The webview reaches the Core through one door. `commands.*` from ./bindings is typed and
    // generated; ./ipc.ts owns the rest (raw-body commands, events, streams).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/bindings.ts", "src/shared/ipc.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tauri-apps/api/core",
              message:
                "Do not import invoke/Channel here. Call `commands.*` from ./bindings (typed, generated from Rust), or use `Channel`/`attachFile` from ./ipc. A new backend command needs #[specta::specta], never a raw command-name string.",
            },
            {
              name: "@tauri-apps/api/event",
              message:
                "Do not call listen() here. Use `listenTo(event, handler)` from ./ipc: it returns a cleanup that is safe before registration finishes, so a component cannot leak a listener.",
            },
          ],
        },
      ],
    },
  },
  {
    // Persisted UI state has one guarded door: reads are `unknown` and never throw, writes never
    // fail the caller, and keys are listed in one place.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/shared/storage.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message:
            "Use readJson/writeJson/readText/writeText from ./storage and add the key to `storageKeys`. Do not call localStorage directly: access can throw, and stored data must be validated.",
        },
        {
          name: "sessionStorage",
          message: "Use ./storage (or add a sibling there). Do not call sessionStorage directly.",
        },
      ],
    },
  },
  {
    // A stale dependency list is a bug, not a style note. Fix the dependencies (a ref for a
    // value that must not retrigger, or split the effect) instead of silencing the rule.
    files: ["src/**/*.{ts,tsx}"],
    rules: { "react-hooks/exhaustive-deps": "error" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  { files: ["scripts/*.cjs", "web/scripts/*.cjs"], languageOptions: { globals: globals.node }, rules: { "@typescript-eslint/no-require-imports": "off" } },
  { files: ["tools/**/*.mjs"], languageOptions: { globals: globals.node } },
);
