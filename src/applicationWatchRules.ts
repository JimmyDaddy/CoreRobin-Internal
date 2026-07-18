import type { ApplicationImpact } from "./diagnosis";
import type { ApplicationWatchRule } from "./settings";

export interface ApplicationWatchRuleState {
  startedAtMs: number | null;
  active: boolean;
  lastNotifiedAtMs: number | null;
}

export interface ApplicationWatchRuleEvent {
  rule: ApplicationWatchRule;
  application: ApplicationImpact;
  value: number;
  triggeredAtMs: number;
}

export const APPLICATION_WATCH_COOLDOWN_MS = 10 * 60 * 1_000;

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
      next.set(rule.id, { ...previous, startedAtMs: null, active: false });
      continue;
    }

    const startedAtMs = previous.startedAtMs ?? sampledAtMs;
    const sustained = sampledAtMs - startedAtMs >= rule.durationSeconds * 1_000;
    const cooldownReady = previous.lastNotifiedAtMs === null ||
      sampledAtMs - previous.lastNotifiedAtMs >= APPLICATION_WATCH_COOLDOWN_MS;
    if (sustained && !previous.active && cooldownReady) {
      events.push({ rule, application, value, triggeredAtMs: sampledAtMs });
    }
    next.set(rule.id, {
      startedAtMs,
      active: sustained,
      lastNotifiedAtMs: events[events.length - 1]?.rule.id === rule.id
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
