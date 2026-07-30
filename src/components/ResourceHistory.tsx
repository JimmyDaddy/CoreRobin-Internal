import type { HistoryPoint } from "../types";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { UsageThresholds } from "../settings";
import { resourceUsageLevel } from "../utils";
import { TimeSeriesChart } from "./TimeSeriesChart";

interface ResourceHistoryProps {
  history: HistoryPoint[];
  usageThresholds: UsageThresholds;
}

export function ResourceHistory({ history, usageThresholds }: ResourceHistoryProps) {
  const { t, i18n } = useAppTranslation();
  const latest = history[history.length - 1];
  const endAtMs = latest?.timestamp ?? Date.now();
  const startAtMs = endAtMs - 5 * 60 * 1_000;

  return (
    <section className="panel history-panel" aria-labelledby="history-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{t("common:fiveMinutes")}</span>
          <h2 id="history-title">{t("history:title")}</h2>
        </div>
        <div className="chart-legend" aria-label={t("history:legend")}>
          <span className={latest ? `resource-usage resource-usage--${resourceUsageLevel(latest.cpuPercent, usageThresholds)}` : undefined}><i className="legend-dot legend-dot--cpu" />CPU {latest ? `${latest.cpuPercent.toFixed(0)}%` : t("history:warmup")}</span>
          <span className={latest ? `resource-usage resource-usage--${resourceUsageLevel(latest.memoryPercent, usageThresholds)}` : undefined}><i className="legend-dot legend-dot--memory" />{t("history:memory")} {latest ? `${latest.memoryPercent.toFixed(0)}%` : t("history:warmup")}</span>
        </div>
      </div>

      {history.length < 2 ? (
        <div className="history-empty">
          <span className="live-status-dot" />
          {t("history:establishing")}
        </div>
      ) : (
        <TimeSeriesChart
          ariaLabel={t("history:chartLabel", {
            cpu: latest?.cpuPercent.toFixed(0),
            memory: latest?.memoryPercent.toFixed(0),
          })}
          className="history-chart"
          completenessLabel={(percent) => t("history:dataCompleteness", { percent })}
          earlierLabel={t("common:fiveMinutesBack")}
          endAtMs={endAtMs}
          expectedIntervalMs={1_000}
          gapThresholdMs={5_000}
          language={i18n.resolvedLanguage}
          maximum={100}
          nowLabel={t("common:now")}
          points={history.map((point) => ({
            timestamp: point.timestamp,
            values: [point.cpuPercent, point.memoryPercent],
          }))}
          series={[
            {
              label: "CPU",
              color: "var(--chart-cpu)",
              format: (value) => `${value.toFixed(0)}%`,
            },
            {
              label: t("history:memory"),
              color: "var(--chart-memory)",
              format: (value) => `${value.toFixed(0)}%`,
            },
          ]}
          startAtMs={startAtMs}
        />
      )}
    </section>
  );
}
