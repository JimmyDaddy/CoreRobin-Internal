import { MAX_RESOURCE_ALERT_EVENTS } from "./alertStore";
import type { ResourceAlertEvent } from "./resourceAlerts";

export function createSeenResourceAlertIds(
  events: readonly ResourceAlertEvent[],
): Set<string> {
  return new Set(
    events.slice(-MAX_RESOURCE_ALERT_EVENTS).map((event) => event.id),
  );
}

export function reconcileSeenResourceAlertIds(
  seenIds: Set<string>,
  events: readonly ResourceAlertEvent[],
): ResourceAlertEvent[] {
  const retainedEvents = events.slice(-MAX_RESOURCE_ALERT_EVENTS);
  const unseen = retainedEvents.filter((event) => !seenIds.has(event.id));

  seenIds.clear();
  for (const event of retainedEvents) seenIds.add(event.id);
  return unseen;
}
