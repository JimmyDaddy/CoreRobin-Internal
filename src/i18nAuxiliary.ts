import { createInstance, type ParseKeys } from "i18next";
import resourcesToBackend from "i18next-resources-to-backend";

import { loadI18nextCatalog } from "./i18n/catalogs";
import {
  AUXILIARY_NAMESPACES,
  DEFAULT_NAMESPACE,
} from "./i18n/namespaces";
import {
  FALLBACK_LANGUAGE,
  initialLanguage,
  normalizeLanguage,
  persistLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "./language";

type TranslationValues = Record<string, string | number>;
type AuxiliaryTranslationKey = ParseKeys<typeof AUXILIARY_NAMESPACES>;
export type AuxiliaryTranslate = (
  key: AuxiliaryTranslationKey,
  values?: TranslationValues,
) => string;

const auxiliaryI18n = createInstance();

await auxiliaryI18n
  .use(
    resourcesToBackend((language: string, namespace: string) =>
      loadI18nextCatalog(language, namespace),
    ),
  )
  .init({
    lng: initialLanguage(),
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    load: "currentOnly",
    ns: AUXILIARY_NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    interpolation: { escapeValue: false },
  });

export function subscribeAuxiliaryLanguage(listener: () => void): () => void {
  auxiliaryI18n.on("languageChanged", listener);
  return () => auxiliaryI18n.off("languageChanged", listener);
}

export function getAuxiliaryLanguage(): SupportedLanguage {
  return normalizeLanguage(
    auxiliaryI18n.resolvedLanguage ?? auxiliaryI18n.language,
  );
}

export const translateAuxiliary: AuxiliaryTranslate = (key, values = {}) =>
  String(auxiliaryI18n.t(key as never, values));

export async function changeAuxiliaryLanguage(
  nextLanguage: SupportedLanguage,
): Promise<void> {
  await auxiliaryI18n.changeLanguage(nextLanguage);
}

persistLanguage(getAuxiliaryLanguage());
auxiliaryI18n.on("languageChanged", persistLanguage);

export default auxiliaryI18n;
