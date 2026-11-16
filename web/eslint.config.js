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
  { files: ["scripts/*.cjs", "web/scripts/*.cjs"], languageOptions: { globals: globals.node }, rules: { "@typescript-eslint/no-require-imports": "off" } },
  { files: ["tools/**/*.mjs"], languageOptions: { globals: globals.node } },
);
