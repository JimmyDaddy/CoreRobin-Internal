import type {
  ResourceAlertEvent,
  ResourceAlertResource,
  ResourceAlertSeverity,
} from "./resourceAlerts";

export interface HistoryStory {
  id: string;
  resource: ResourceAlertResource;
  severity: ResourceAlertSeverity;
  status: "active" | "recovered";
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number;
  peakPercent: number;
  peakAtMs: number;
  culpritName: string | null;
}

export function buildHistoryStories(
  events: readonly ResourceAlertEvent[],
): HistoryStory[] {
  const stories: HistoryStory[] = [];
  const activeByResource = new Map<ResourceAlertResource, number>();

  for (const event of [...events].sort((left, right) => left.timestamp - right.timestamp)) {
    if (event.kind === "triggered") {
      const story: HistoryStory = {
        id: `${event.resource}:${event.startedAtMs}`,
        resource: event.resource,
        severity: event.severity,
        status: "active",
        startedAtMs: event.startedAtMs,
        endedAtMs: null,
        durationMs: event.durationMs,
        peakPercent: event.peakValuePercent ?? event.valuePercent,
        peakAtMs: event.peakAtMs ?? event.timestamp,
        culpritName: event.culpritName ?? null,
      };
      stories.push(story);
      activeByResource.set(event.resource, stories.length - 1);
      continue;
    }

    const activeIndex = activeByResource.get(event.resource);
    if (activeIndex === undefined) {
      stories.push({
        id: `${event.resource}:${event.startedAtMs}`,
        resource: event.resource,
        severity: event.severity,
        status: "recovered",
        startedAtMs: event.startedAtMs,
        endedAtMs: event.timestamp,
        durationMs: event.durationMs,
        peakPercent: event.peakValuePercent ?? event.valuePercent,
        peakAtMs: event.peakAtMs ?? event.timestamp,
        culpritName: event.culpritName ?? null,
      });
      continue;
    }
    const active = stories[activeIndex];
    if (!active) continue;
    const eventPeak = event.peakValuePercent ?? event.valuePercent;
    const eventPeakAtMs = event.peakAtMs ?? event.timestamp;
    const peakChanged = eventPeak > active.peakPercent;
    stories[activeIndex] = {
      ...active,
      severity: active.severity === "critical" || event.severity === "critical"
        ? "critical"
        : "high",
      status: "recovered",
      endedAtMs: event.timestamp,
      durationMs: Math.max(active.durationMs, event.durationMs),
      peakPercent: Math.max(active.peakPercent, eventPeak),
      peakAtMs: peakChanged ? eventPeakAtMs : active.peakAtMs,
      culpritName: active.culpritName ?? event.culpritName ?? null,
    };
    activeByResource.delete(event.resource);
  }

  return stories.sort((left, right) => right.startedAtMs - left.startedAtMs);
}
