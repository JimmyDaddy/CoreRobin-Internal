import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.local-dev/**",
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "src-tauri/target/**",
      "test-results/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["*.config.{js,ts}", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["infra/notary-webhook-relay/**/*.mjs"],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
);
