import { Database, History, Network, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  HISTORY_RETENTION_OPTIONS,
  type HistoryRetentionDays,
} from "../historyStore";
import type { UsageThresholds } from "../settings";
import type { HistoryPoint } from "../types";
import { formatRate, resourceUsageLevel } from "../utils";

interface HistoryExplorerProps {
  points: HistoryPoint[];
  storedPointCount: number;
  persistenceEnabled: boolean;
  retentionDays: HistoryRetentionDays;
  usageThresholds: UsageThresholds;
  onPersistenceEnabledChange: (enabled: boolean) => void;
  onRetentionDaysChange: (days: HistoryRetentionDays) => void;
  onClear: () => void;
}

const CHART_WIDTH = 900;
const CHART_HEIGHT = 210;
const CHART_TOP = 14;
const CHART_BOTTOM = 178;

export function HistoryExplorer({
  points,
  storedPointCount,
  persistenceEnabled,
  retentionDays,
  usageThresholds,
  onPersistenceEnabledChange,
  onRetentionDaysChange,
  onClear,
}: HistoryExplorerProps) {
  const { t, i18n } = useTranslation();
  const summary = useMemo(() => summarizeHistory(points), [points]);
  const range = historyRangeLabel(points, i18n.resolvedLanguage);

  return (
    <section className="history-explorer" aria-labelledby="persistent-history-title">
      <header className="panel history-hero">
        <div>
          <span className="eyebrow">{t("history.localArchive")}</span>
          <h2 id="persistent-history-title">{t("history.archiveTitle")}</h2>
          <p>{t("history.archiveDescription")}</p>
        </div>
        <span className={`history-hero__status${persistenceEnabled ? "" : " is-disabled"}`}>
          <i />
          {persistenceEnabled ? t("history.saving") : t("history.sessionOnly")}
        </span>
      </header>

      <section className="panel history-controls" aria-label={t("history.controls")}>
        <label className="settings-switch">
          <input
            type="checkbox"
            role="switch"
            checked={persistenceEnabled}
            onChange={(event) => onPersistenceEnabledChange(event.target.checked)}
          />
          <span>{t("history.saveOnDevice")}</span>
        </label>
        <label className="history-controls__retention">
          <span>{t("history.retention")}</span>
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
                {t("history.retentionDays", { count: days })}
              </option>
            ))}
          </select>
        </label>
        <span className="history-controls__range">
          {range ?? t("history.noRange")} · {t("history.savedPoints", { count: storedPointCount })}
        </span>
        <button
          className="button button--danger-ghost"
          type="button"
          disabled={storedPointCount === 0}
          onClick={onClear}
        >
          <Trash2 size={14} />{t("history.clearSaved")}
        </button>
      </section>

      {points.length === 0 ? (
        <section className="panel history-archive-empty">
          <History size={23} />
          <strong>{t("history.emptyTitle")}</strong>
          <span>{t("history.emptyDescription")}</span>
        </section>
      ) : (
        <>
          <section className="history-archive-summary" aria-label={t("history.summary")}>
            <HistorySummaryItem
              label={t("history.averageCpu")}
              value={`${summary.averageCpu.toFixed(0)}%`}
              level={resourceUsageLevel(summary.averageCpu, usageThresholds)}
            />
            <HistorySummaryItem
              label={t("history.averageMemory")}
              value={`${summary.averageMemory.toFixed(0)}%`}
              level={resourceUsageLevel(summary.averageMemory, usageThresholds)}
            />
            <HistorySummaryItem label={t("history.peakDisk")} value={formatRate(summary.peakDisk)} />
            <HistorySummaryItem label={t("history.peakNetwork")} value={formatRate(summary.peakNetwork)} />
          </section>

          <ResourceArchiveChart points={points} />
          <ThroughputArchiveChart points={points} />
        </>
      )}

      <section className="panel history-privacy" aria-labelledby="history-privacy-title">
        <span className="history-privacy__icon" aria-hidden="true"><ShieldCheck size={19} /></span>
        <div>
          <span className="eyebrow">{t("history.privacyEyebrow")}</span>
          <h3 id="history-privacy-title">{t("history.privacyTitle")}</h3>
          <ul>
            <li>{t("history.privacyLocal")}</li>
            <li>{t("history.privacyCollected")}</li>
            <li>{t("history.privacyExcluded")}</li>
            <li>{t("history.privacyControl")}</li>
          </ul>
        </div>
      </section>
    </section>
  );
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
  const { t, i18n } = useTranslation();
  const cpuPath = percentagePath(points.map((point) => point.cpuPercent));
  const memoryPath = percentagePath(points.map((point) => point.memoryPercent));
  return (
    <section className="panel history-archive-chart" aria-labelledby="history-resource-chart-title">
      <ArchiveChartHeader
        eyebrow={t("history.fiveMinuteResolution")}
        title={t("history.resourceChart")}
        icon={History}
        legends={[
          { label: "CPU", className: "is-cpu" },
          { label: t("history.memory"), className: "is-memory" },
        ]}
      />
      <HistorySvg
        label={t("history.resourceChartLabel")}
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
  const { t, i18n } = useTranslation();
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
        eyebrow={t("history.fiveMinuteResolution")}
        title={t("history.throughputChart")}
        icon={Database}
        legends={[
          { label: t("app.metrics.disk"), className: "is-disk" },
          { label: t("app.metrics.network"), className: "is-network" },
        ]}
      />
      <HistorySvg
        label={t("history.throughputChartLabel")}
        points={points}
        language={i18n.resolvedLanguage}
      >
        <path className="history-archive-line is-disk" d={scaledPath(diskValues, scale)} />
        <path className="history-archive-line is-network" d={scaledPath(networkValues, scale)} />
      </HistorySvg>
      <div className="history-throughput-peaks">
        <span><Database size={13} />{t("history.peakDisk")} <strong>{formatRate(Math.max(...diskValues))}</strong></span>
        <span><Network size={13} />{t("history.peakNetwork")} <strong>{formatRate(Math.max(...networkValues))}</strong></span>
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
