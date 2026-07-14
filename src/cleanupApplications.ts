import type { CleanupApplication } from "./types";

export const UNUSED_APPLICATION_AGE_MS = 180 * 24 * 60 * 60 * 1_000;

export function findUnusedApplications(
  applications: CleanupApplication[],
  now = Date.now(),
): CleanupApplication[] {
  const cutoff = now - UNUSED_APPLICATION_AGE_MS;
  return applications
    .filter((application) =>
      application.lastUsedAtMs !== null && application.lastUsedAtMs <= cutoff,
    )
    .sort((left, right) => {
      const lastUsedDifference = (left.lastUsedAtMs ?? 0) - (right.lastUsedAtMs ?? 0);
      return lastUsedDifference || right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name);
    });
}

export function unusedApplicationDays(application: CleanupApplication, now = Date.now()): number | null {
  if (application.lastUsedAtMs === null) return null;
  return Math.max(0, Math.floor((now - application.lastUsedAtMs) / 86_400_000));
}
