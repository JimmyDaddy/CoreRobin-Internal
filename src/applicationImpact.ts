import type { ApplicationImpact } from "./diagnosis";

const MEBIBYTE = 1_024 ** 2;

export type ApplicationSortKey = "impact" | "cpu" | "memory" | "disk";
export type ApplicationImpactLevel = "low" | "moderate" | "high" | "critical";
export type ApplicationPrimaryResource = "cpu" | "memory" | "disk" | "balanced";

export function applicationMemoryPercent(
  application: Pick<ApplicationImpact, "memoryBytes">,
  totalMemoryBytes: number,
): number {
  if (totalMemoryBytes <= 0) return 0;
  return Math.max(0, application.memoryBytes / totalMemoryBytes * 100);
}

export function applicationImpactLevel(
  application: ApplicationImpact,
  totalMemoryBytes: number,
): ApplicationImpactLevel {
  const memoryPercent = applicationMemoryPercent(application, totalMemoryBytes);
  const diskMebibytes = application.diskBytesPerSecond / MEBIBYTE;
  if (application.cpuPercent >= 100 || memoryPercent >= 25 || diskMebibytes >= 100) {
    return "critical";
  }
  if (application.cpuPercent >= 50 || memoryPercent >= 15 || diskMebibytes >= 25) {
    return "high";
  }
  if (application.cpuPercent >= 10 || memoryPercent >= 5 || diskMebibytes >= 5) {
    return "moderate";
  }
  return "low";
}

export function applicationPrimaryResource(
  application: ApplicationImpact,
  totalMemoryBytes: number,
): ApplicationPrimaryResource {
  const scores = [
    ["cpu", application.cpuPercent / 50],
    ["memory", applicationMemoryPercent(application, totalMemoryBytes) / 15],
    ["disk", application.diskBytesPerSecond / (25 * MEBIBYTE)],
  ] as const;
  const primary = [...scores].sort((left, right) => right[1] - left[1])[0];
  return primary && primary[1] >= 0.5 ? primary[0] : "balanced";
}

export function sortApplications(
  applications: readonly ApplicationImpact[],
  sortKey: ApplicationSortKey,
  totalMemoryBytes: number,
): ApplicationImpact[] {
  return [...applications].sort((left, right) => {
    const difference = applicationMetric(right, sortKey, totalMemoryBytes) -
      applicationMetric(left, sortKey, totalMemoryBytes);
    return difference || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

function applicationMetric(
  application: ApplicationImpact,
  sortKey: ApplicationSortKey,
  totalMemoryBytes: number,
): number {
  switch (sortKey) {
    case "cpu":
      return application.cpuPercent;
    case "memory":
      return application.memoryBytes;
    case "disk":
      return application.diskBytesPerSecond;
    case "impact":
      return application.cpuPercent +
        applicationMemoryPercent(application, totalMemoryBytes) * 2 +
        application.diskBytesPerSecond / MEBIBYTE;
  }
}
