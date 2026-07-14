import { applicationImpactLevel } from "./applicationImpact";
import type { ApplicationImpact } from "./diagnosis";
import type { StartupItem } from "./types";

export type StartupAdvice = "review" | "normal" | "system" | "disabled";
export type StartupImpactLevel = "none" | "low" | "moderate" | "high";

export function startupAdvice(item: StartupItem): StartupAdvice {
  if (!item.enabled) return "disabled";
  if (item.system) return "system";
  return item.launchKind === "login" ? "review" : "normal";
}

export function startupRuntimeApplication(
  item: StartupItem,
  applications: readonly ApplicationImpact[],
): ApplicationImpact | null {
  const itemName = normalizeIdentity(item.name);
  const publisher = normalizeIdentity(item.publisher ?? "");
  const command = normalizeIdentity(item.command ?? "");
  return applications
    .map((application) => {
      const name = normalizeIdentity(application.name);
      let score = 0;
      if (name && command.includes(`${name}appcontents`)) score = 5;
      else if (name && (itemName === name || command.includes(name))) score = 4;
      else if (name && (itemName.includes(name) || name.includes(itemName))) score = 3;
      else if (publisher && name.includes(publisher)) score = 2;
      return { application, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.application.cpuPercent - left.application.cpuPercent ||
        right.application.memoryBytes - left.application.memoryBytes,
    )[0]?.application ?? null;
}

export function startupImpactLevel(
  item: StartupItem,
  application: ApplicationImpact | null,
  totalMemoryBytes: number,
): StartupImpactLevel {
  if (!item.enabled) return "none";
  if (application) {
    const runtimeImpact = applicationImpactLevel(application, totalMemoryBytes);
    if (runtimeImpact === "critical" || runtimeImpact === "high") return "high";
    if (runtimeImpact === "moderate") return "moderate";
  }
  return item.launchKind === "login" ? "moderate" : "low";
}

export function filterStartupItems(
  items: readonly StartupItem[],
  filter: "review" | "all" | "system",
  query: string,
): StartupItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter === "review" && startupAdvice(item) !== "review") return false;
    if (filter === "system" && !item.system) return false;
    if (!normalized) return true;
    return [item.name, item.publisher, item.command, item.path]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLowerCase().includes(normalized));
  });
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
