import packageMetadata from "../package.json";

import type { AppSettings } from "./settings";
import type { SystemSnapshot } from "./types";

export const PRODUCT_URLS = {
  releaseManifest: "https://monitor-app.corerobin.com/release-manifest.json",
  releases_zh: "https://monitor-app.corerobin.com/releases/",
  releases_en: "https://monitor-app.corerobin.com/en/releases/",
  guide_zh: "https://monitor-app.corerobin.com/guide/",
  guide_en: "https://monitor-app.corerobin.com/en/guide/",
  privacy_zh: "https://monitor-app.corerobin.com/privacy/",
  privacy_en: "https://monitor-app.corerobin.com/en/privacy/",
  issues: "https://github.com/JimmyDaddy/corerobin-monitor/issues/new/choose",
} as const;

export type ProductPage = Exclude<keyof typeof PRODUCT_URLS, "releaseManifest">;
export type LocalizedProductPage = "releases" | "guide" | "privacy";

export function localizedProductPage(
  page: LocalizedProductPage,
  language: string | undefined,
): ProductPage {
  const suffix = language === "zh-CN" || language === "zh-Hant" ? "zh" : "en";
  return `${page}_${suffix}`;
}

export const CURRENT_APP_VERSION = packageMetadata.version;
export const ONBOARDING_STORAGE_KEY = "core-robin.onboarding.v1";

const OWNED_STORAGE_PREFIXES = ["core-robin.", "status-orbit.", "pulse."] as const;
let productDataResetInProgress = false;

export interface ReleaseManifest {
  schemaVersion: 1;
  tagName: string;
  name: string;
  publishedAt: string;
  releaseUrl: string;
}

export type UpdateCheckResult =
  | { status: "current"; latestVersion: string; releaseUrl: string }
  | { status: "available"; latestVersion: string; releaseUrl: string };

export async function checkForProductUpdate(
  fetcher: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const response = await fetcher(PRODUCT_URLS.releaseManifest, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`update_manifest_http_${response.status}`);
  const manifest = parseReleaseManifest(await response.json());
  const latestVersion = manifest.tagName.slice(1);
  return {
    status: compareStableVersions(latestVersion, CURRENT_APP_VERSION) > 0
      ? "available"
      : "current",
    latestVersion,
    releaseUrl: manifest.releaseUrl,
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("update_manifest_invalid");
  }
  const tagName = typeof value.tagName === "string" ? value.tagName : "";
  const name = typeof value.name === "string" ? value.name : "";
  const publishedAt = typeof value.publishedAt === "string" ? value.publishedAt : "";
  const releaseUrl = typeof value.releaseUrl === "string" ? value.releaseUrl : "";
  if (
    !/^v\d+\.\d+\.\d+$/.test(tagName) ||
    !name ||
    !publishedAt ||
    !releaseUrl.startsWith("https://github.com/JimmyDaddy/corerobin-monitor/releases/")
  ) {
    throw new Error("update_manifest_invalid");
  }
  return { schemaVersion: 1, tagName, name, publishedAt, releaseUrl };
}

export function compareStableVersions(left: string, right: string): number {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function buildRedactedDiagnosticSummary({
  snapshot,
  settings,
  desktopRuntime,
}: {
  snapshot: SystemSnapshot;
  settings: AppSettings;
  desktopRuntime: boolean;
}): string {
  const temperature = snapshot.warmingUp
    ? "waiting_for_first_sample"
    : snapshot.sensors.temperature.celsius === null
      ? "temporarily_unavailable"
      : "available";
  const battery = snapshot.warmingUp
    ? "waiting_for_first_sample"
    : !snapshot.sensors.battery.present
      ? "not_supported_or_not_present"
      : snapshot.sensors.battery.chargePercent === null
        ? "temporarily_unavailable"
        : "available";
  return [
    "CoreRobin diagnostic summary (privacy-redacted)",
    `App version: ${CURRENT_APP_VERSION}`,
    `Runtime: ${desktopRuntime ? "desktop" : "browser-demo"}`,
    `System: ${snapshot.host.osName} ${snapshot.host.osVersion}`,
    `Architecture: ${snapshot.host.architecture}`,
    `Snapshot schema: ${snapshot.schemaVersion}`,
    `Experience mode: ${settings.experienceMode}`,
    `System sampling: ${settings.systemSampleIntervalMs} ms`,
    `Connection refresh: ${settings.connectionRefreshIntervalMs} ms`,
    `Temperature data: ${temperature}`,
    `Battery data: ${battery}`,
    `History saving: ${settings.historyPersistenceEnabled ? "enabled" : "disabled"}`,
    `Notifications: ${settings.desktopNotificationsEnabled ? "enabled" : "disabled"}`,
    "Excluded: hostname, process names, file paths, network addresses, and history values.",
  ].join("\n");
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard_unavailable");
}

export function clearCoreRobinWebData(
  local: Storage = window.localStorage,
  session: Storage = window.sessionStorage,
): number {
  return clearOwnedStorage(local) + clearOwnedStorage(session);
}

export function beginProductDataReset(): void {
  productDataResetInProgress = true;
}

export function isProductDataResetInProgress(): boolean {
  return productDataResetInProgress;
}

export function hasCompletedOnboarding(storage: Storage = window.localStorage): boolean {
  try {
    return storage.getItem(ONBOARDING_STORAGE_KEY) === "completed";
  } catch {
    return false;
  }
}

export function completeOnboarding(storage: Storage = window.localStorage): void {
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, "completed");
  } catch {
    // The guide can still be dismissed for the current session.
  }
}

function clearOwnedStorage(storage: Storage): number {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key))
    .filter((key) => OWNED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)));
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

function stableVersionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error("invalid_stable_version");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
