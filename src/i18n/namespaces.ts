export const MAIN_NAMESPACES = [
  "common",
  "app",
  "daily",
  "diagnosis",
  "applications",
  "wellbeing",
  "cleanup",
  "startup",
  "settings",
  "process",
  "storage",
  "network",
  "history",
  "format",
] as const;

const AUXILIARY_ONLY_NAMESPACES = [
  "splash",
  "tray",
  "companion",
] as const;

export const TRANSLATION_NAMESPACES = [
  ...MAIN_NAMESPACES,
  ...AUXILIARY_ONLY_NAMESPACES,
  "notifications",
] as const;

export type TranslationNamespace =
  (typeof TRANSLATION_NAMESPACES)[number];

export const DEFAULT_NAMESPACE: TranslationNamespace = "common";

export const AUXILIARY_NAMESPACES = [
  "common",
  "app",
  "wellbeing",
  ...AUXILIARY_ONLY_NAMESPACES,
] as const satisfies readonly TranslationNamespace[];

export function isTranslationNamespace(
  namespace: string,
): namespace is TranslationNamespace {
  return TRANSLATION_NAMESPACES.includes(
    namespace as TranslationNamespace,
  );
}
