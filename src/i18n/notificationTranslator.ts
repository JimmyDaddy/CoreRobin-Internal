import { FALLBACK_LANGUAGE, type SupportedLanguage } from "../language";
import type {
  ResourceAlertKind,
  ResourceAlertResource,
} from "../resourceAlerts";
import { loadCatalog, type TranslationTree } from "./catalogs";

export type NotificationTranslationKey =
  `${ResourceAlertKind}.${ResourceAlertResource}.${"title" | "body"}`;

function lookup(tree: TranslationTree, key: string): string | undefined {
  let value: string | TranslationTree = tree;
  for (const segment of key.split(".")) {
    if (typeof value === "string") return undefined;
    const next: string | TranslationTree | undefined = value[segment];
    if (next === undefined) return undefined;
    value = next;
  }
  return typeof value === "string" ? value : undefined;
}

export async function translateNotification(
  language: SupportedLanguage,
  key: NotificationTranslationKey,
): Promise<string> {
  const translated = lookup(await loadCatalog(language, "notifications"), key);
  if (translated !== undefined || language === FALLBACK_LANGUAGE) {
    return translated ?? key;
  }
  return lookup(await loadCatalog(FALLBACK_LANGUAGE, "notifications"), key) ?? key;
}
