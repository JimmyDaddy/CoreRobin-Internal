import type { ApplicationImpact } from "./diagnosis";
import type { ResourceAlertResource } from "./resourceAlerts";

export function alertCulpritName(
  resource: ResourceAlertResource,
  applications: readonly ApplicationImpact[],
  totalMemoryBytes: number,
): string | null {
  if (resource === "volume") return null;
  const candidate = [...applications].sort((left, right) =>
    resource === "cpu"
      ? right.cpuPercent - left.cpuPercent
      : right.memoryBytes - left.memoryBytes
  )[0];
  if (!candidate) return null;
  if (resource === "cpu" && candidate.cpuPercent < 20) return null;
  if (
    resource === "memory" &&
    (totalMemoryBytes <= 0 || candidate.memoryBytes / totalMemoryBytes < 0.08)
  ) {
    return null;
  }
  return truncateApplicationName(candidate.name);
}

function truncateApplicationName(name: string): string | null {
  const normalized = name.trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, 120).join("");
}
