import i18n from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";
import { initReactI18next } from "react-i18next";

import {
  AUXILIARY_NAMESPACES,
  DEFAULT_NAMESPACE,
  MAIN_NAMESPACES,
} from "./i18n/namespaces";
import {
  FALLBACK_LANGUAGE,
  initialLanguage,
  persistLanguage,
  SUPPORTED_LANGUAGES,
} from "./language";

// Shared formatters also import this instance in auxiliary windows. Identify
// the entry from its URL before surface bootstrap runs, so they do not eagerly
// initialize every main-window namespace or retain its full catalog map.
const auxiliaryEntry = typeof window !== "undefined"
  && /(?:^|\/)(?:splash|tray|companion|robin-chat)\.html$/.test(window.location.pathname);
const loadEntryCatalog = auxiliaryEntry
  ? (await import("./i18n/surfaceCatalogs")).loadSurfaceCatalog
  : (await import("./i18n/catalogs")).loadI18nextCatalog;

export {
  DEFAULT_LANGUAGE,
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  localeDefinition,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LOCALES,
  type LocaleDirection,
  type SupportedLanguage,
} from "./language";

await i18n
  .use(
    resourcesToBackend((language: string, namespace: string) =>
      loadEntryCatalog(language, namespace),
    ),
  )
  .use(initReactI18next)
  .init({
    lng: initialLanguage(),
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    load: "currentOnly",
    ns: auxiliaryEntry ? [...AUXILIARY_NAMESPACES, "format"] : MAIN_NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

persistLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", persistLanguage);

export const appT = i18n.getFixedT(null, MAIN_NAMESPACES);

export default i18n;
