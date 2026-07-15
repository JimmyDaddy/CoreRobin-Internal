import { defineConfig } from "i18next-cli";

import { TRANSLATION_NAMESPACES } from "./src/i18n/namespaces";
import {
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
} from "./src/language";

export default defineConfig({
  locales: [...SUPPORTED_LANGUAGES],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    ignore: ["src/**/*.test.{ts,tsx}"],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    functions: ["t", "*.t", "translateAuxiliary"],
    defaultNS: "common",
    nsSeparator: ":",
    keySeparator: ".",
    primaryLanguage: FALLBACK_LANGUAGE,
    secondaryLanguages: SUPPORTED_LANGUAGES.filter(
      (language) => language !== FALLBACK_LANGUAGE,
    ),
    removeUnusedKeys: false,
    preservePatterns: TRANSLATION_NAMESPACES.map(
      (namespace) => `${namespace}:*`,
    ),
    sort: true,
    indentation: 2,
  },
  types: {
    input: `src/i18n/locales/${FALLBACK_LANGUAGE}/*.json`,
    basePath: `src/i18n/locales/${FALLBACK_LANGUAGE}`,
    output: "src/types/i18next.d.ts",
    resourcesFile: "src/types/i18next-resources.d.ts",
  },
});
