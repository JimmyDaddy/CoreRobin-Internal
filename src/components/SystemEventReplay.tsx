import {
  Activity,
  BellRing,
  Clock3,
  Network,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  summarizeApplicationImpactHistory,
  type ApplicationImpactHistoryPoint,
} from "../applicationImpactHistory";
import type { ApplicationWatchHistoryEvent } from "../applicationWatchHistory";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { NetworkQualityHistoryPoint } from "../networkQualityHistory";
import type { ResourceAlertEvent } from "../resourceAlerts";
import type { HistoryPoint } from "../types";
import type { UserActionRecord } from "../userActionHistory";
import { formatBytes, formatPercent } from "../utils";

interface ReplayEvent {
  id: string;
  atMs: number;
  kind: "alert" | "watch" | "network" | "action";
  label: string;
  detail: string;
}

export function SystemEventReplay({
  points,
  applicationImpactPoints,
  alerts,
  watchEvents,
  networkQualityPoints,
  actions,
}: {
  points: readonly HistoryPoint[];
  applicationImpactPoints: readonly ApplicationImpactHistoryPoint[];
  alerts: readonly ResourceAlertEvent[];
  watchEvents: readonly ApplicationWatchHistoryEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actions: readonly UserActionRecord[];
}) {
  const { t, i18n } = useAppTranslation();
  const newestAt = Math.max(
    Date.now(),
    points[points.length - 1]?.timestamp ?? 0,
  );
  const [range, setRange] = useState(() => ({
    fromMs: newestAt - 24 * 60 * 60 * 1_000,
    toMs: newestAt,
  }));
  const visiblePoints = useMemo(
    () => points.filter((point) =>
      point.timestamp >= range.fromMs && point.timestamp <= range.toMs),
    [points, range],
  );
  const visibleImpact = useMemo(
    () => applicationImpactPoints.filter((point) =>
      point.sampledAtMs >= range.fromMs && point.sampledAtMs <= range.toMs),
    [applicationImpactPoints, range],
  );
  const applications = useMemo(
    () => summarizeApplicationImpactHistory(visibleImpact),
    [visibleImpact],
  );
  const events = useMemo(() => buildReplayEvents({
    points,
    alerts,
    watchEvents,
    networkQualityPoints,
    actions,
    fromMs: range.fromMs,
    toMs: range.toMs,
    t,
  }), [actions, alerts, networkQualityPoints, points, range, t, watchEvents]);
  const peakCpu = Math.max(0, ...visiblePoints.map((point) => point.cpuPercent));
  const peakMemory = Math.max(
    0,
    ...visiblePoints.map((point) => point.memoryPercent),
  );
  const topApplications = applications.slice(0, 2);

  const applyPreset = (hours: number) => {
    const toMs = Math.max(
      Date.now(),
      points[points.length - 1]?.timestamp ?? 0,
    );
    setRange({ fromMs: toMs - hours * 60 * 60 * 1_000, toMs });
  };

  return (
    <section className="panel system-event-replay" aria-labelledby="system-event-replay-title">
      <header>
        <div>
          <span className="eyebrow">{t("history:replay.eyebrow")}</span>
          <h3 id="system-event-replay-title">
            <RefreshCw size={17} />{t("history:replay.title")}
          </h3>
          <p>{t("history:replay.description")}</p>
        </div>
        <div className="system-event-replay__presets" role="group" aria-label={t("history:replay.range")}>
          {([
            [1, "history:replay.hours1"],
            [24, "history:replay.hours24"],
            [168, "history:replay.hours168"],
          ] as const).map(([hours, labelKey]) => (
            <button type="button" key={hours} onClick={() => applyPreset(hours)}>
              {t(labelKey)}
            </button>
          ))}
        </div>
      </header>
      <div className="system-event-replay__range">
        <label>
          <span>{t("history:replay.from")}</span>
          <input
            type="datetime-local"
            value={dateTimeLocalValue(range.fromMs)}
            max={dateTimeLocalValue(range.toMs)}
            onChange={(event) => {
              const fromMs = new Date(event.target.value).getTime();
              if (Number.isFinite(fromMs)) {
                setRange((current) => ({ ...current, fromMs }));
              }
            }}
          />
        </label>
        <span aria-hidden="true">—</span>
        <label>
          <span>{t("history:replay.to")}</span>
          <input
            type="datetime-local"
            value={dateTimeLocalValue(range.toMs)}
            min={dateTimeLocalValue(range.fromMs)}
            onChange={(event) => {
              const toMs = new Date(event.target.value).getTime();
              if (Number.isFinite(toMs)) {
                setRange((current) => ({ ...current, toMs }));
              }
            }}
          />
        </label>
      </div>
      <div className="system-event-replay__evidence">
        <Sparkles size={18} />
        <div>
          <strong>{t("history:replay.evidenceTitle")}</strong>
          <p>
            {topApplications.length > 0
              ? t("history:replay.applicationEvidence", {
                  from: formatTime(range.fromMs, i18n.resolvedLanguage),
                  to: formatTime(range.toMs, i18n.resolvedLanguage),
                  applications: topApplications
                    .map((application) => application.name)
                    .join("、"),
                  cpu: formatPercent(peakCpu),
                  memory: formatPercent(peakMemory),
                })
              : t("history:replay.noApplicationEvidence", {
                  cpu: formatPercent(peakCpu),
                  memory: formatPercent(peakMemory),
                })}
          </p>
          {topApplications[0] ? (
            <small>
              {t("history:replay.leadingApplication", {
                application: topApplications[0].name,
                cpu: formatPercent(topApplications[0].averageCpuPercent),
                memory: formatBytes(topApplications[0].averageMemoryBytes),
              })}
            </small>
          ) : null}
        </div>
      </div>
      {events.length > 0 ? (
        <ol className="system-event-replay__events">
          {events.slice(0, 80).map((event) => {
            const Icon = event.kind === "network"
              ? Network
              : event.kind === "action"
                ? Activity
                : BellRing;
            return (
              <li key={event.id}>
                <Icon size={14} />
                <time dateTime={new Date(event.atMs).toISOString()}>
                  {formatDateTime(event.atMs, i18n.resolvedLanguage)}
                </time>
                <div><strong>{event.label}</strong><small>{event.detail}</small></div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="system-event-replay__empty">
          <Clock3 size={18} />{t("history:replay.empty")}
        </div>
      )}
    </section>
  );
}

function buildReplayEvents({
  points,
  alerts,
  watchEvents,
  networkQualityPoints,
  actions,
  fromMs,
  toMs,
  t,
}: {
  points: readonly HistoryPoint[];
  alerts: readonly ResourceAlertEvent[];
  watchEvents: readonly ApplicationWatchHistoryEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actions: readonly UserActionRecord[];
  fromMs: number;
  toMs: number;
  t: ReturnType<typeof useAppTranslation>["t"];
}): ReplayEvent[] {
  const inRange = (atMs: number) => atMs >= fromMs && atMs <= toMs;
  return [
    ...alerts.filter((event) => inRange(event.timestamp)).map((event) => ({
      id: `alert:${event.id}`,
      atMs: event.timestamp,
      kind: "alert" as const,
      label: t(`history:replay.alert.${event.kind}`),
      detail: `${event.resource.toUpperCase()} · ${event.valuePercent.toFixed(0)}%`,
    })),
    ...watchEvents.filter((event) => inRange(event.timestamp)).map((event) => ({
      id: `watch:${event.id}`,
      atMs: event.timestamp,
      kind: "watch" as const,
      label: t(`history:replay.watch.${event.kind}`),
      detail: event.applicationName ?? t("history:watchRules.privateApplication"),
    })),
    ...networkQualityPoints.flatMap((point) => point.events
      .filter((event) => inRange(event.atMs))
      .map((event) => ({
        id: `network:${event.kind}:${event.atMs}`,
        atMs: event.atMs,
        kind: "network" as const,
        label: t(`history:replay.network.${event.kind}`),
        detail: point.status,
      }))),
    ...actions.filter((action) => inRange(action.startedAtMs)).map((action) => {
      const impact = describeActionImpact(points, action, t);
      return {
        id: `action:${action.id}`,
        atMs: action.startedAtMs,
        kind: "action" as const,
        label: t(`history:actions.kind.${action.kind}`),
        detail: [
          t(`history:actions.status.${action.status}`),
          t(`history:actions.verification.${action.verification}`),
          impact,
        ].filter(Boolean).join(" · "),
      };
    }),
  ].sort((left, right) => right.atMs - left.atMs);
}

function describeActionImpact(
  points: readonly HistoryPoint[],
  action: UserActionRecord,
  t: ReturnType<typeof useAppTranslation>["t"],
): string {
  if (action.status !== "succeeded" && action.status !== "partial") return "";
  const completedAtMs = action.completedAtMs ?? action.startedAtMs;
  const windowMs = 15 * 60 * 1_000;
  const before = points.filter((point) =>
    point.timestamp >= completedAtMs - windowMs
    && point.timestamp < completedAtMs);
  const after = points.filter((point) =>
    point.timestamp > completedAtMs
    && point.timestamp <= completedAtMs + windowMs);
  if (before.length < 2 || after.length < 2) {
    return t("history:replay.actionImpact.insufficient");
  }
  const averagePressure = (samples: readonly HistoryPoint[]) =>
    samples.reduce(
      (total, point) => total + point.cpuPercent + point.memoryPercent,
      0,
    ) / samples.length;
  const delta = averagePressure(after) - averagePressure(before);
  if (delta <= -5) return t("history:replay.actionImpact.improved");
  if (delta >= 5) return t("history:replay.actionImpact.increased");
  return t("history:replay.actionImpact.stable");
}

function dateTimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offsetMs).toISOString().slice(0, 16);
}

function formatTime(timestamp: number, language: string | undefined): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatDateTime(timestamp: number, language: string | undefined): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(timestamp);
}
