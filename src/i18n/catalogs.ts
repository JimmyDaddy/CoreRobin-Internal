import {
  normalizeLanguage,
  type SupportedLanguage,
} from "../language";
import {
  isTranslationNamespace,
  type TranslationNamespace,
} from "./namespaces";

export type TranslationTree = {
  readonly [key: string]: string | TranslationTree;
};

const catalogModules = import.meta.glob("./locales/*/*.json", {
  import: "default",
}) as Record<string, () => Promise<TranslationTree>>;

const catalogCache = new Map<string, Promise<TranslationTree>>();

export async function loadCatalog(
  language: SupportedLanguage,
  namespace: TranslationNamespace,
): Promise<TranslationTree> {
  const path = `./locales/${language}/${namespace}.json`;
  const loader = catalogModules[path];
  if (!loader) {
    throw new Error(`Missing translation catalog: ${language}/${namespace}`);
  }
  let pending = catalogCache.get(path);
  if (!pending) {
    pending = loader();
    catalogCache.set(path, pending);
  }
  return pending;
}

export async function loadI18nextCatalog(
  language: string,
  namespace: string,
): Promise<TranslationTree> {
  if (!isTranslationNamespace(namespace)) {
    throw new Error(`Unsupported translation namespace: ${namespace}`);
  }
  return loadCatalog(normalizeLanguage(language), namespace);
}
