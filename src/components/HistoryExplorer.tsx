import {
  Activity,
  BellRing,
  BatteryMedium,
  BookOpen,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  History,
  MemoryStick,
  Network,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  HISTORY_RETENTION_OPTIONS,
  type HistoryRetentionDays,
} from "../historyStore";
import { buildHistoryStories, type HistoryStory } from "../historyStories";
import type { UsageThresholds } from "../settings";
import type { HistoryPoint } from "../types";
import { formatBytes, formatRate, resourceUsageLevel } from "../utils";
import "./HistoryExplorer.css";
import type {
  ResourceAlertEvent,
  ResourceAlertResource,
} from "../resourceAlerts";
import type { UserActionKind, UserActionRecord } from "../userActionHistory";
import { UserActionTimeline } from "./UserActionTimeline";
import type { ApplicationWatchHistoryEvent } from "../applicationWatchHistory";
import { ApplicationWatchTimeline } from "./ApplicationWatchTimeline";
import type { ApplicationImpactHistoryPoint } from "../applicationImpactHistory";
import type { ApplicationImpactHistoryStorageStatus } from "../hooks/useApplicationImpactHistory";
import { ApplicationImpactHistoryPanel } from "./ApplicationImpactHistoryPanel";
import { PersonalBaselinePanel } from "./PersonalBaselinePanel";
import type { NetworkQualityHistoryPoint } from "../networkQualityHistory";
import { SystemEventReplay } from "./SystemEventReplay";
import { buildBatteryUsageSessions } from "../batterySessions";
import type { NativeHistoryStorageStatus } from "../hooks/useNativeHistoryStorage";
import {
  downsampleTimeSeries,
  timeSeriesBucketMs,
  type TimeSeriesRangeHours,
} from "../timeSeries";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { HistoryExportPanel } from "./HistoryExportPanel";

interface HistoryExplorerProps {
  points: HistoryPoint[];
  storedPointCount: number;
  applicationImpactPoints: ApplicationImpactHistoryPoint[];
  applicationImpactHistoryEnabled: boolean;
  applicationImpactStorageStatus: ApplicationImpactHistoryStorageStatus;
  historyStorageStatus: NativeHistoryStorageStatus;
  alertEvents: ResourceAlertEvent[];
  storedAlertEventCount: number;
  applicationWatchEvents?: ApplicationWatchHistoryEvent[];
  storedApplicationWatchEventCount?: number;
  actionRecords: UserActionRecord[];
  networkQualityPoints: NetworkQualityHistoryPoint[];
  storedUserActionCount: number;
  activeAlertCount: number;
  persistenceEnabled: boolean;
  retentionDays: HistoryRetentionDays;
  usageThresholds: UsageThresholds;
  onPersistenceEnabledChange: (enabled: boolean) => void;
  onRetentionDaysChange: (days: HistoryRetentionDays) => void;
  onApplicationImpactHistoryEnabledChange: (enabled: boolean) => void;
  onClear: () => void;
  onOpenUserAction: (kind: UserActionKind) => void;
}

export function HistoryExplorer({
  points,
  storedPointCount,
  applicationImpactPoints,
  applicationImpactHistoryEnabled,
  applicationImpactStorageStatus,
  historyStorageStatus,
  alertEvents,
  storedAlertEventCount,
  applicationWatchEvents = [],
  storedApplicationWatchEventCount = 0,
  actionRecords,
  networkQualityPoints,
  storedUserActionCount,
  activeAlertCount,
  persistenceEnabled,
  retentionDays,
  usageThresholds,
  onPersistenceEnabledChange,
  onRetentionDaysChange,
  onApplicationImpactHistoryEnabledChange,
  onClear,
  onOpenUserAction,
}: HistoryExplorerProps) {
  const { t, i18n } = useAppTranslation();
  const [alertFilter, setAlertFilter] = useState<"all" | ResourceAlertResource>("all");
  const [applicationImpactFocusAtMs, setApplicationImpactFocusAtMs] =
    useState<number | null>(null);
  const [chartRangeHours, setChartRangeHours] =
    useState<TimeSeriesRangeHours>(24);
  const summary = useMemo(() => summarizeHistory(points), [points]);
  const visibleAlertEvents = useMemo(
    () =>
      [...alertEvents]
        .filter((event) => alertFilter === "all" || event.resource === alertFilter)
        .reverse()
        .slice(0, 100),
    [alertEvents, alertFilter],
  );
  const stories = useMemo(
    () => buildHistoryStories(alertEvents).slice(0, 6),
    [alertEvents],
  );
  const range = historyRangeLabel(points, i18n.resolvedLanguage);
  const batterySessions = useMemo(
    () => buildBatteryUsageSessions(points),
    [points],
  );

  return (
    <section className="history-explorer" aria-labelledby="persistent-history-title">
      <header className="panel history-hero">
        <div>
          <span className="eyebrow">{t("history:localArchive")}</span>
          <h2 id="persistent-history-title">{t("history:archiveTitle")}</h2>
          <p>{t("history:archiveDescription")}</p>
        </div>
        <span className={`history-hero__status${persistenceEnabled ? "" : " is-disabled"}`}>
          <i />
          {persistenceEnabled ? t("history:saving") : t("history:sessionOnly")}
        </span>
      </header>

      <section className="panel history-controls" aria-label={t("history:controls")}>
        <label className="settings-switch">
          <input
            type="checkbox"
            role="switch"
            checked={persistenceEnabled}
            onChange={(event) => onPersistenceEnabledChange(event.target.checked)}
          />
          <span>{t("history:saveOnDevice")}</span>
        </label>
        <label className="history-controls__retention">
          <span>{t("history:retention")}</span>
          <select
            value={retentionDays}
            onChange={(event) =>
              onRetentionDaysChange(
                event.target.value === "1" ? 1 : event.target.value === "30" ? 30 : 7,
              )
            }
          >
            {HISTORY_RETENTION_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {t("history:retentionDays", { count: days })}
              </option>
            ))}
          </select>
        </label>
        <span className="history-controls__range">
          {range ?? t("history:noRange")} · {t("history:savedPoints", { count: storedPointCount })}
          {" · "}{t("history:alerts.savedEvents", { count: storedAlertEventCount })}
          {" · "}{t("history:watchRules.savedEvents", {
            count: storedApplicationWatchEventCount,
          })}
          {" · "}{t("history:actions.saved", { count: storedUserActionCount })}
        </span>
        <span
          className={`history-controls__storage is-${historyStorageStatus.state}`}
          title={historyStorageStatus.error ?? undefined}
        >
          <Database size={13} />
          {historyStorageStatus.state === "failed"
            ? t("history:storage.failed")
            : historyStorageStatus.lastSavedAtMs
              ? t("history:storage.saved", {
                  size: formatBytes(historyStorageStatus.byteSize),
                  time: new Date(historyStorageStatus.lastSavedAtMs)
                    .toLocaleTimeString(i18n.resolvedLanguage),
                })
              : t("history:storage.waiting")}
        </span>
        <button
          className="button button--danger-ghost"
          type="button"
          disabled={
            storedPointCount === 0 &&
            storedAlertEventCount === 0 &&
            storedApplicationWatchEventCount === 0 &&
            storedUserActionCount === 0
          }
          onClick={onClear}
        >
          <Trash2 size={14} />{t("history:clearSaved")}
        </button>
      </section>

      {points.length === 0 ? (
        <section className="panel history-archive-empty">
          <History size={23} />
          <strong>{t("history:emptyTitle")}</strong>
          <span>{t("history:emptyDescription")}</span>
        </section>
      ) : (
        <>
          <section className="history-archive-summary" aria-label={t("history:summary")}>
            <HistorySummaryItem
              label={t("history:averageCpu")}
              value={`${summary.averageCpu.toFixed(0)}%`}
              level={resourceUsageLevel(summary.averageCpu, usageThresholds)}
            />
            <HistorySummaryItem
              label={t("history:averageMemory")}
              value={`${summary.averageMemory.toFixed(0)}%`}
              level={resourceUsageLevel(summary.averageMemory, usageThresholds)}
            />
            <HistorySummaryItem label={t("history:peakDisk")} value={formatRate(summary.peakDisk)} />
            <HistorySummaryItem label={t("history:peakNetwork")} value={formatRate(summary.peakNetwork)} />
          </section>

          <div
            className="application-impact-history__ranges"
            role="group"
            aria-label={t("history:chartRange")}
          >
            {([1, 24, 168] as const).map((hours) => (
              <button
                type="button"
                className={chartRangeHours === hours ? "is-active" : undefined}
                aria-pressed={chartRangeHours === hours}
                key={hours}
                onClick={() => setChartRangeHours(hours)}
              >
                {t(`history:applicationImpact.hours${hours}`)}
              </button>
            ))}
          </div>
          <ResourceArchiveChart points={points} rangeHours={chartRangeHours} />
          <ThroughputArchiveChart points={points} rangeHours={chartRangeHours} />
          <PersonalBaselinePanel points={points} />
        </>
      )}

      <ApplicationImpactHistoryPanel
        points={applicationImpactPoints}
        enabled={applicationImpactHistoryEnabled}
        focusAtMs={applicationImpactFocusAtMs}
        storageStatus={applicationImpactStorageStatus}
        onEnabledChange={onApplicationImpactHistoryEnabledChange}
      />

      <SystemEventReplay
        points={points}
        applicationImpactPoints={applicationImpactPoints}
        alerts={alertEvents}
        watchEvents={applicationWatchEvents}
        networkQualityPoints={networkQualityPoints}
        actions={actionRecords}
      />

      <HistoryExportPanel
        sources={{
          points,
          alerts: alertEvents,
          networkQualityPoints,
          actions: actionRecords,
          applicationImpactPoints,
        }}
      />

      <section className="panel battery-sessions" aria-labelledby="battery-sessions-title">
        <header>
          <div>
            <span className="eyebrow">{t("history:batterySessions.eyebrow")}</span>
            <h3 id="battery-sessions-title"><BatteryMedium size={17} />{t("history:batterySessions.title")}</h3>
            <p>{t("history:batterySessions.description")}</p>
          </div>
          <span>{t("history:batterySessions.count", { count: batterySessions.length })}</span>
        </header>
        {batterySessions.length > 0 ? (
          <ol>
            {batterySessions.slice(0, 10).map((session) => (
              <li key={session.id}>
                <div className="battery-sessions__time">
                  <strong>{new Date(session.startedAtMs).toLocaleString(i18n.resolvedLanguage)}</strong>
                  <small>{session.ongoing
                    ? t("history:batterySessions.ongoing")
                    : t("history:batterySessions.duration", {
                        minutes: Math.max(1, Math.round(
                          (session.endedAtMs - session.startedAtMs) / 60_000,
                        )),
                      })}</small>
                </div>
                <div><small>{t("history:batterySessions.charge")}</small><strong>
                  {session.startChargePercent ?? "—"}% → {session.endChargePercent ?? "—"}%
                </strong></div>
                <div><small>{t("history:batterySessions.drainRate")}</small><strong>
                  {session.drainPercentPerHour === null
                    ? "—"
                    : `${session.drainPercentPerHour.toFixed(1)}%/h`}
                </strong></div>
                <div className="battery-sessions__evidence">
                  <small>{t("history:batterySessions.evidence")}</small>
                  <span>{session.majorApplicationNames.length > 0
                    ? session.majorApplicationNames.join(" · ")
                    : t("history:batterySessions.noApplicationEvidence")}</span>
                  {session.blockerNames.length > 0 ? (
                    <em>{t("history:batterySessions.blockers", {
                      names: session.blockerNames.join(" · "),
                    })}</em>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="battery-sessions__empty">{t("history:batterySessions.empty")}</div>
        )}
      </section>

      {stories.length > 0 ? (
      <section className="panel history-stories" aria-labelledby="history-stories-title">
        <header className="history-stories__header">
          <div>
            <span className="eyebrow">{t("history:stories.eyebrow")}</span>
            <h3 id="history-stories-title"><BookOpen size={16} />{t("history:stories.title")}</h3>
            <p>{t("history:stories.description")}</p>
          </div>
          <span>{t("history:stories.count", { count: stories.length })}</span>
        </header>
        <div className="history-story-list">
          {stories.map((story) => (
            <HistoryStoryCard
              key={story.id}
              story={story}
              onInspectApplications={() => {
                setApplicationImpactFocusAtMs(story.peakAtMs);
                window.requestAnimationFrame(() => {
                  document.getElementById("application-impact-history")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                });
              }}
            />
          ))}
        </div>
      </section>
      ) : null}

      {actionRecords.length > 0 ? (
      <div className="panel history-user-actions">
        <UserActionTimeline
          records={actionRecords}
          storedCount={storedUserActionCount}
          onOpenAction={onOpenUserAction}
        />
      </div>
      ) : null}

      {applicationWatchEvents.length > 0 ? (
        <div className="panel history-application-watch">
          <ApplicationWatchTimeline events={applicationWatchEvents} />
        </div>
      ) : null}

      {alertEvents.length > 0 ? (
      <section className="panel history-alerts" aria-labelledby="history-alerts-title">
        <header className="history-alerts__header">
          <div>
            <span className="eyebrow">{t("history:alerts.eyebrow")}</span>
            <h3 id="history-alerts-title"><BellRing size={16} />{t("history:alerts.title")}</h3>
            <p>{t("history:alerts.description")}</p>
          </div>
          <span className={`history-alerts__status${activeAlertCount > 0 ? " is-active" : ""}`}>
            {activeAlertCount > 0
              ? t("history:alerts.active", { count: activeAlertCount })
              : t("history:alerts.normal")}
          </span>
        </header>
        <div className="history-alerts__toolbar">
          <div className="history-alert-filters" role="group" aria-label={t("history:alerts.filters")}>
            {(["all", "cpu", "memory", "volume"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={alertFilter === filter ? "is-active" : ""}
                aria-pressed={alertFilter === filter}
                onClick={() => setAlertFilter(filter)}
              >
                {filter === "all"
                  ? t("history:alerts.all")
                  : alertResourceLabel(filter, t)}
              </button>
            ))}
          </div>
          <span>{t("history:alerts.eventCount", { count: visibleAlertEvents.length })}</span>
        </div>
        {visibleAlertEvents.length === 0 ? (
          <div className="history-alerts__empty">
            <CheckCircle2 size={20} />
            <strong>{t("history:alerts.emptyTitle")}</strong>
            <span>{t("history:alerts.emptyDescription")}</span>
          </div>
        ) : (
          <div className="history-alert-list">
            {visibleAlertEvents.map((event) => (
              <ResourceAlertRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </section>
      ) : null}

      <section className="panel history-privacy" aria-labelledby="history-privacy-title">
        <span className="history-privacy__icon" aria-hidden="true"><ShieldCheck size={19} /></span>
        <div>
          <span className="eyebrow">{t("history:privacyEyebrow")}</span>
          <h3 id="history-privacy-title">{t("history:privacyTitle")}</h3>
          <ul>
            <li>{t("history:privacyLocal")}</li>
            <li>{t("history:privacyCollected")}</li>
            <li>{t("history:privacyExcluded")}</li>
            <li>{t("history:privacyControl")}</li>
          </ul>
        </div>
      </section>
    </section>
  );
}

function HistoryStoryCard({
  story,
  onInspectApplications,
}: {
  story: HistoryStory;
  onInspectApplications: () => void;
}) {
  const { t, i18n } = useAppTranslation();
  const Icon = story.status === "active" ? TriangleAlert : CheckCircle2;
  const duration = formatAlertDuration(story.durationMs, t);
  const startedAt = formatTimestamp(story.startedAtMs, i18n.resolvedLanguage);
  const peakAt = formatTimestamp(story.peakAtMs, i18n.resolvedLanguage);
  const endedAt = story.endedAtMs === null
    ? null
    : formatTimestamp(story.endedAtMs, i18n.resolvedLanguage);
  return (
    <article className={`history-story is-${story.resource} is-${story.status} is-${story.severity}`}>
      <span className="history-story__icon" aria-hidden="true"><Icon size={17} /></span>
      <div>
        <span>{story.status === "active" ? t("history:stories.happeningNow") : t("history:stories.resolved")}</span>
        <h4>{t(`history:stories.${story.resource}.${story.status}.title`)}</h4>
        <p>{t(`history:stories.${story.resource}.${story.status}.description`, {
          duration,
          value: story.peakPercent.toFixed(0),
        })}</p>
        {story.culpritName ? (
          <p className="history-story__cause">
            {t("history:stories.cause", { name: story.culpritName })}
          </p>
        ) : null}
        <div className="history-story__timeline" aria-label={t("history:stories.timeline")}>
          <span>{t("history:stories.startedAt", { time: startedAt })}</span>
          <span>{t("history:stories.peakedAt", {
            time: peakAt,
            value: story.peakPercent.toFixed(0),
          })}</span>
          {endedAt ? <span>{t("history:stories.endedAt", { time: endedAt })}</span> : null}
        </div>
        <small>{t(`history:stories.${story.resource}.guidance`)}</small>
        <button
          className="history-story__application-link"
          type="button"
          onClick={onInspectApplications}
        >
          <Activity size={13} />{t("history:stories.inspectApplications")}
        </button>
      </div>
      <time dateTime={new Date(story.startedAtMs).toISOString()}>
        {startedAt}
      </time>
    </article>
  );
}

function ResourceAlertRow({ event }: { event: ResourceAlertEvent }) {
  const { t, i18n } = useAppTranslation();
  const Icon = event.resource === "cpu"
    ? Cpu
    : event.resource === "memory"
      ? MemoryStick
      : HardDrive;
  const duration = formatAlertDuration(event.durationMs, t);
  return (
    <article className={`history-alert-row is-${event.kind} is-${event.severity}`}>
      <span className="history-alert-row__icon" aria-hidden="true"><Icon size={16} /></span>
      <div className="history-alert-row__body">
        <div>
          <strong>{alertResourceLabel(event.resource, t)}</strong>
          <span>{event.kind === "triggered"
            ? t(`history:alerts.severity.${event.severity}`)
            : t("history:alerts.recovered")}</span>
        </div>
        <p>
          {event.kind === "triggered"
            ? t("history:alerts.triggeredDetail", {
                value: event.valuePercent.toFixed(0),
                threshold: event.thresholdPercent.toFixed(0),
                duration,
              })
            : t("history:alerts.recoveredDetail", {
                value: event.valuePercent.toFixed(0),
                duration,
              })}
        </p>
      </div>
      <time dateTime={new Date(event.timestamp).toISOString()}>
        {formatTimestamp(event.timestamp, i18n.resolvedLanguage)}
      </time>
    </article>
  );
}

function alertResourceLabel(
  resource: ResourceAlertResource,
  t: AppTFunction,
): string {
  if (resource === "cpu") return "CPU";
  if (resource === "memory") return t("history:memory");
  return t("history:alerts.volume");
}

function formatAlertDuration(
  durationMs: number,
  t: AppTFunction,
): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return t("format:seconds", { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("format:minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("format:hours", { count: hours });
  return t("format:days", { count: Math.round(hours / 24) });
}

function HistorySummaryItem({
  label,
  value,
  level,
}: {
  label: string;
  value: string;
  level?: string;
}) {
  return (
    <article className="panel history-summary-item">
      <span>{label}</span>
      <strong className={level ? `resource-usage resource-usage--${level}` : undefined}>{value}</strong>
    </article>
  );
}

function ResourceArchiveChart({
  points,
  rangeHours,
}: {
  points: HistoryPoint[];
  rangeHours: TimeSeriesRangeHours;
}) {
  const { t, i18n } = useAppTranslation();
  const now = Date.now();
  const bucketMs = timeSeriesBucketMs(rangeHours);
  const displayPoints = downsampleTimeSeries(
    points.map((point) => ({
      timestamp: point.timestamp,
      values: [point.cpuPercent, point.memoryPercent],
    })),
    rangeHours,
    now,
  );
  return (
    <section className="panel history-archive-chart" aria-labelledby="history-resource-chart-title">
      <ArchiveChartHeader
        eyebrow={t("history:fiveMinuteResolution")}
        title={t("history:resourceChart")}
        icon={History}
        legends={[
          { label: "CPU", className: "is-cpu" },
          { label: t("history:memory"), className: "is-memory" },
        ]}
      />
      <TimeSeriesChart
        ariaLabel={t("history:resourceChartLabel")}
        completenessLabel={(percent) => t("history:dataCompleteness", { percent })}
        earlierLabel={formatRangeStart(now, rangeHours, i18n.resolvedLanguage)}
        endAtMs={now}
        expectedIntervalMs={bucketMs}
        gapThresholdMs={bucketMs * 2.5}
        language={i18n.resolvedLanguage}
        maximum={100}
        nowLabel={t("common:now")}
        points={displayPoints}
        series={[
          {
            label: "CPU",
            color: "var(--chart-cpu)",
            format: (value) => `${value.toFixed(0)}%`,
          },
          {
            label: t("history:memory"),
            color: "var(--chart-memory)",
            dashed: true,
            format: (value) => `${value.toFixed(0)}%`,
          },
        ]}
        startAtMs={now - rangeHours * 60 * 60 * 1_000}
      />
    </section>
  );
}

function ThroughputArchiveChart({
  points,
  rangeHours,
}: {
  points: HistoryPoint[];
  rangeHours: TimeSeriesRangeHours;
}) {
  const { t, i18n } = useAppTranslation();
  const diskValues = points.map(
    (point) => (point.diskReadBytesPerSecond ?? 0) + (point.diskWriteBytesPerSecond ?? 0),
  );
  const networkValues = points.map(
    (point) => (point.networkReceivedBytesPerSecond ?? 0) + (point.networkTransmittedBytesPerSecond ?? 0),
  );
  const scale = Math.max(1, ...diskValues, ...networkValues);
  const now = Date.now();
  const bucketMs = timeSeriesBucketMs(rangeHours);
  const displayPoints = downsampleTimeSeries(
    points.map((point) => ({
      timestamp: point.timestamp,
      values: [
        (point.diskReadBytesPerSecond ?? 0)
          + (point.diskWriteBytesPerSecond ?? 0),
        (point.networkReceivedBytesPerSecond ?? 0)
          + (point.networkTransmittedBytesPerSecond ?? 0),
      ],
    })),
    rangeHours,
    now,
  );
  return (
    <section className="panel history-archive-chart" aria-labelledby="history-throughput-chart-title">
      <ArchiveChartHeader
        eyebrow={t("history:fiveMinuteResolution")}
        title={t("history:throughputChart")}
        icon={Database}
        legends={[
          { label: t("app:metrics.disk"), className: "is-disk" },
          { label: t("app:metrics.network"), className: "is-network" },
        ]}
      />
      <TimeSeriesChart
        ariaLabel={t("history:throughputChartLabel")}
        completenessLabel={(percent) => t("history:dataCompleteness", { percent })}
        earlierLabel={formatRangeStart(now, rangeHours, i18n.resolvedLanguage)}
        endAtMs={now}
        expectedIntervalMs={bucketMs}
        gapThresholdMs={bucketMs * 2.5}
        language={i18n.resolvedLanguage}
        maximum={scale}
        nowLabel={t("common:now")}
        points={displayPoints}
        series={[
          {
            label: t("app:metrics.disk"),
            color: "var(--green)",
            format: formatRate,
          },
          {
            label: t("app:metrics.network"),
            color: "var(--blue)",
            dashed: true,
            format: formatRate,
          },
        ]}
        startAtMs={now - rangeHours * 60 * 60 * 1_000}
      />
      <div className="history-throughput-peaks">
        <span><Database size={13} />{t("history:peakDisk")} <strong>{formatRate(Math.max(...diskValues))}</strong></span>
        <span><Network size={13} />{t("history:peakNetwork")} <strong>{formatRate(Math.max(...networkValues))}</strong></span>
      </div>
    </section>
  );
}

function ArchiveChartHeader({
  eyebrow,
  title,
  icon: Icon,
  legends,
}: {
  eyebrow: string;
  title: string;
  icon: typeof History;
  legends: Array<{ label: string; className: string }>;
}) {
  return (
    <header className="history-archive-chart__header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h3><Icon size={16} />{title}</h3>
      </div>
      <div className="history-archive-legend" aria-hidden="true">
        {legends.map((legend) => (
          <span key={legend.label}><i className={legend.className} />{legend.label}</span>
        ))}
      </div>
    </header>
  );
}

function formatRangeStart(
  now: number,
  rangeHours: TimeSeriesRangeHours,
  language: string | undefined,
): string {
  return formatTimestamp(
    now - rangeHours * 60 * 60 * 1_000,
    language,
  );
}

function summarizeHistory(points: readonly HistoryPoint[]) {
  const totals = points.reduce(
    (summary, point) => ({
      cpu: summary.cpu + point.cpuPercent,
      memory: summary.memory + point.memoryPercent,
      peakDisk: Math.max(
        summary.peakDisk,
        (point.diskReadBytesPerSecond ?? 0) + (point.diskWriteBytesPerSecond ?? 0),
      ),
      peakNetwork: Math.max(
        summary.peakNetwork,
        (point.networkReceivedBytesPerSecond ?? 0) + (point.networkTransmittedBytesPerSecond ?? 0),
      ),
    }),
    { cpu: 0, memory: 0, peakDisk: 0, peakNetwork: 0 },
  );
  const count = Math.max(1, points.length);
  return {
    averageCpu: totals.cpu / count,
    averageMemory: totals.memory / count,
    peakDisk: totals.peakDisk,
    peakNetwork: totals.peakNetwork,
  };
}

function historyRangeLabel(points: readonly HistoryPoint[], language: string | undefined): string | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  return `${formatTimestamp(first.timestamp, language)} – ${formatTimestamp(last.timestamp, language)}`;
}

function formatTimestamp(timestamp: number, language: string | undefined): string {
  return new Date(timestamp).toLocaleString(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
