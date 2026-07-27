import type { ApplicationImpact } from "./diagnosis";
import type { ApplicationWatchRule } from "./settings";

export interface ApplicationWatchRuleState {
  startedAtMs: number | null;
  active: boolean;
  lastNotifiedAtMs: number | null;
}

export interface ApplicationWatchRuleEvent {
  kind: "triggered" | "recovered";
  rule: ApplicationWatchRule;
  application: ApplicationImpact | null;
  value: number;
  triggeredAtMs: number;
}

export const APPLICATION_WATCH_COOLDOWN_MS = 10 * 60 * 1_000;
export const MINIMUM_APPLICATION_WATCH_SAMPLE_INTERVAL_MS = 5_000;
export const MAXIMUM_APPLICATION_WATCH_SAMPLE_INTERVAL_MS = 10_000;

export function applicationWatchSamplingIntervalMs(
  rules: readonly ApplicationWatchRule[],
): number | null {
  const shortestDurationSeconds = rules
    .filter((rule) => rule.enabled)
    .reduce<number | null>(
      (shortest, rule) =>
        shortest === null
          ? rule.durationSeconds
          : Math.min(shortest, rule.durationSeconds),
      null,
    );
  if (shortestDurationSeconds === null) return null;
  return Math.max(
    MINIMUM_APPLICATION_WATCH_SAMPLE_INTERVAL_MS,
    Math.min(
      MAXIMUM_APPLICATION_WATCH_SAMPLE_INTERVAL_MS,
      shortestDurationSeconds * 500,
    ),
  );
}

export function evaluateApplicationWatchRules(
  states: Map<string, ApplicationWatchRuleState>,
  rules: readonly ApplicationWatchRule[],
  applications: readonly ApplicationImpact[],
  sampledAtMs: number,
): { states: Map<string, ApplicationWatchRuleState>; events: ApplicationWatchRuleEvent[] } {
  const next = new Map(states);
  const events: ApplicationWatchRuleEvent[] = [];
  const applicationByName = new Map(
    applications.map((application) => [application.name.toLocaleLowerCase(), application]),
  );
  const ruleIds = new Set(rules.map((rule) => rule.id));
  for (const id of next.keys()) if (!ruleIds.has(id)) next.delete(id);

  for (const rule of rules) {
    const previous = next.get(rule.id) ?? {
      startedAtMs: null,
      active: false,
      lastNotifiedAtMs: null,
    };
    if (!rule.enabled) {
      next.set(rule.id, { ...previous, startedAtMs: null, active: false });
      continue;
    }
    const application = applicationByName.get(rule.applicationName.toLocaleLowerCase());
    const value = application ? applicationMetricValue(application, rule.metric) : 0;
    if (!application || value < rule.threshold) {
      if (previous.active) {
        events.push({
          kind: "recovered",
          rule,
          application: application ?? null,
          value,
          triggeredAtMs: sampledAtMs,
        });
      }
      next.set(rule.id, { ...previous, startedAtMs: null, active: false });
      continue;
    }

    const startedAtMs = previous.startedAtMs ?? sampledAtMs;
    const sustained = sampledAtMs - startedAtMs >= rule.durationSeconds * 1_000;
    const cooldownReady = previous.lastNotifiedAtMs === null ||
      sampledAtMs - previous.lastNotifiedAtMs >= APPLICATION_WATCH_COOLDOWN_MS;
    if (sustained && !previous.active && cooldownReady) {
      events.push({
        kind: "triggered",
        rule,
        application,
        value,
        triggeredAtMs: sampledAtMs,
      });
    }
    next.set(rule.id, {
      startedAtMs,
      active: sustained,
      lastNotifiedAtMs: events[events.length - 1]?.rule.id === rule.id &&
          events[events.length - 1]?.kind === "triggered"
        ? sampledAtMs
        : previous.lastNotifiedAtMs,
    });
  }
  return { states: next, events };
}

export function applicationMetricValue(
  application: ApplicationImpact,
  metric: ApplicationWatchRule["metric"],
): number {
  if (metric === "cpu") return application.cpuPercent;
  if (metric === "memory") return application.memoryBytes / (1_024 ** 2);
  return application.diskBytesPerSecond / (1_024 ** 2);
}
