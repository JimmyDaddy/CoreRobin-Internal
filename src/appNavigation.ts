export type ActiveView =
  | "overview"
  | "applications"
  | "processes"
  | "storage"
  | "cleanup"
  | "network"
  | "startup"
  | "history"
  | "toolbox"
  | "settings"
  | "more";

export const PROFESSIONAL_VIEW_EYEBROW = {
  overview: "app:viewEyebrow.overview",
  applications: "app:viewEyebrow.applications",
  processes: "app:viewEyebrow.processes",
  storage: "app:viewEyebrow.storage",
  cleanup: "app:viewEyebrow.cleanup",
  network: "app:viewEyebrow.network",
  startup: "app:viewEyebrow.startup",
  history: "app:viewEyebrow.history",
  toolbox: "app:viewEyebrow.toolbox",
  settings: "app:viewEyebrow.settings",
  more: "app:viewEyebrow.overview",
} as const satisfies Record<ActiveView, string>;

const ACTIVE_VIEWS = new Set<ActiveView>([
  "overview",
  "applications",
  "processes",
  "storage",
  "cleanup",
  "network",
  "startup",
  "history",
  "toolbox",
  "settings",
  "more",
]);

export function isActiveView(value: unknown): value is ActiveView {
  return typeof value === "string" && ACTIVE_VIEWS.has(value as ActiveView);
}

export interface OpenDailyRequest {
  view: ActiveView;
  occurrenceId: string | null;
}

export function parseOpenDailyRequest(
  value: unknown,
  experienceMode: "simple" | "professional" = "simple",
): OpenDailyRequest | null {
  let request: OpenDailyRequest;
  if (isActiveView(value)) {
    request = { view: value, occurrenceId: null };
  } else {
    if (!value || typeof value !== "object") return null;
    const candidate = value as { view?: unknown; occurrenceId?: unknown };
    if (!isActiveView(candidate.view)) return null;
    request = {
      view: candidate.view,
      occurrenceId:
        typeof candidate.occurrenceId === "string" ? candidate.occurrenceId : null,
    };
  }
  return experienceMode === "professional"
    ? { view: "overview", occurrenceId: null }
    : request;
}
