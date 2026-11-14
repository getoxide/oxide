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
  { files: ["scripts/*.cjs", "web/scripts/*.cjs"], languageOptions: { globals: globals.node }, rules: { "@typescript-eslint/no-require-imports": "off" } },
  { files: ["tools/**/*.mjs"], languageOptions: { globals: globals.node } },
);
