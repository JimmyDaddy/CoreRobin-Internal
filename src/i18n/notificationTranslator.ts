import { FALLBACK_LANGUAGE, type SupportedLanguage } from "../language";
import type {
  ResourceAlertKind,
  ResourceAlertResource,
} from "../resourceAlerts";
import { loadCatalog, type TranslationTree } from "./catalogs";

export type NotificationTranslationKey =
  | `${ResourceAlertKind}.${ResourceAlertResource}.${"title" | "body"}`
  | `watch.${"triggered" | "recovered"}.${"title" | "body"}`
  | `watch.metric.${"cpu" | "memory" | "disk"}`
  | `test.${"title" | "body"}`;

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
  variables: Readonly<Record<string, string | number>> = {},
): Promise<string> {
  const translated = lookup(await loadCatalog(language, "notifications"), key);
  if (translated !== undefined || language === FALLBACK_LANGUAGE) {
    return interpolate(translated ?? key, variables);
  }
  return interpolate(
    lookup(await loadCatalog(FALLBACK_LANGUAGE, "notifications"), key) ?? key,
    variables,
  );
}

function interpolate(
  template: string,
  variables: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key])
      : match);
}
