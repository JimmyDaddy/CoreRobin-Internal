import {
  BellRing,
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
import { formatRate, resourceUsageLevel } from "../utils";
import type {
  ResourceAlertEvent,
  ResourceAlertResource,
} from "../resourceAlerts";
import type { UserActionKind, UserActionRecord } from "../userActionHistory";
import { UserActionTimeline } from "./UserActionTimeline";
import type { ApplicationWatchHistoryEvent } from "../applicationWatchHistory";
import { ApplicationWatchTimeline } from "./ApplicationWatchTimeline";

interface HistoryExplorerProps {
  points: HistoryPoint[];
  storedPointCount: number;
  alertEvents: ResourceAlertEvent[];
  storedAlertEventCount: number;
  applicationWatchEvents?: ApplicationWatchHistoryEvent[];
  storedApplicationWatchEventCount?: number;
  actionRecords: UserActionRecord[];
  storedUserActionCount: number;
  activeAlertCount: number;
  persistenceEnabled: boolean;
  retentionDays: HistoryRetentionDays;
  usageThresholds: UsageThresholds;
  onPersistenceEnabledChange: (enabled: boolean) => void;
  onRetentionDaysChange: (days: HistoryRetentionDays) => void;
  onClear: () => void;
  onOpenUserAction: (kind: UserActionKind) => void;
}

const CHART_WIDTH = 900;
const CHART_HEIGHT = 210;
const CHART_TOP = 14;
const CHART_BOTTOM = 178;

export function HistoryExplorer({
  points,
  storedPointCount,
  alertEvents,
  storedAlertEventCount,
  applicationWatchEvents = [],
  storedApplicationWatchEventCount = 0,
  actionRecords,
  storedUserActionCount,
  activeAlertCount,
  persistenceEnabled,
  retentionDays,
  usageThresholds,
  onPersistenceEnabledChange,
  onRetentionDaysChange,
  onClear,
  onOpenUserAction,
}: HistoryExplorerProps) {
  const { t, i18n } = useAppTranslation();
  const [alertFilter, setAlertFilter] = useState<"all" | ResourceAlertResource>("all");
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

          <ResourceArchiveChart points={points} />
          <ThroughputArchiveChart points={points} />
        </>
      )}

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
          {stories.map((story) => <HistoryStoryCard key={story.id} story={story} />)}
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

function HistoryStoryCard({ story }: { story: HistoryStory }) {
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

function ResourceArchiveChart({ points }: { points: HistoryPoint[] }) {
  const { t, i18n } = useAppTranslation();
  const cpuPath = percentagePath(points.map((point) => point.cpuPercent));
  const memoryPath = percentagePath(points.map((point) => point.memoryPercent));
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
      <HistorySvg
        label={t("history:resourceChartLabel")}
        points={points}
        language={i18n.resolvedLanguage}
      >
        <path className="history-archive-line is-memory" d={memoryPath} />
        <path className="history-archive-line is-cpu" d={cpuPath} />
      </HistorySvg>
    </section>
  );
}

function ThroughputArchiveChart({ points }: { points: HistoryPoint[] }) {
  const { t, i18n } = useAppTranslation();
  const diskValues = points.map(
    (point) => (point.diskReadBytesPerSecond ?? 0) + (point.diskWriteBytesPerSecond ?? 0),
  );
  const networkValues = points.map(
    (point) => (point.networkReceivedBytesPerSecond ?? 0) + (point.networkTransmittedBytesPerSecond ?? 0),
  );
  const scale = Math.max(1, ...diskValues, ...networkValues);
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
      <HistorySvg
        label={t("history:throughputChartLabel")}
        points={points}
        language={i18n.resolvedLanguage}
      >
        <path className="history-archive-line is-disk" d={scaledPath(diskValues, scale)} />
        <path className="history-archive-line is-network" d={scaledPath(networkValues, scale)} />
      </HistorySvg>
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

function HistorySvg({
  label,
  points,
  language,
  children,
}: {
  label: string;
  points: HistoryPoint[];
  language: string | undefined;
  children: React.ReactNode;
}) {
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <svg
      className="history-archive-svg"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {[25, 50, 75].map((value) => {
        const y = CHART_TOP + (1 - value / 100) * (CHART_BOTTOM - CHART_TOP);
        return <line key={value} className="history-archive-grid" x1="0" x2={CHART_WIDTH} y1={y} y2={y} />;
      })}
      {children}
      <text x="0" y={CHART_HEIGHT - 4}>{first ? formatTimestamp(first.timestamp, language) : ""}</text>
      <text x={CHART_WIDTH} y={CHART_HEIGHT - 4} textAnchor="end">{last ? formatTimestamp(last.timestamp, language) : ""}</text>
    </svg>
  );
}

function percentagePath(values: number[]): string {
  return scaledPath(values.map((value) => Math.min(100, Math.max(0, value))), 100);
}

function scaledPath(values: number[], maximum: number): string {
  if (values.length === 0) return "";
  const height = CHART_BOTTOM - CHART_TOP;
  if (values.length === 1) {
    const y = CHART_TOP + (1 - Math.min(maximum, Math.max(0, values[0] ?? 0)) / maximum) * height;
    return `M0 ${y.toFixed(1)} L${CHART_WIDTH} ${y.toFixed(1)}`;
  }
  return values.map((value, index) => {
    const x = index / (values.length - 1) * CHART_WIDTH;
    const y = CHART_TOP + (1 - Math.min(maximum, Math.max(0, value)) / maximum) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
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
