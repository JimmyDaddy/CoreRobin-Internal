import type { HistoryPoint } from "../types";
import { useTranslation } from "react-i18next";
import { resourceUsageLevel } from "../utils";

interface ResourceHistoryProps {
  history: HistoryPoint[];
}

const WIDTH = 720;
const HEIGHT = 176;
const TOP_PADDING = 12;
const BOTTOM_PADDING = 22;

function pathFor(values: number[]): string {
  if (values.length === 0) {
    return "";
  }
  const drawableHeight = HEIGHT - TOP_PADDING - BOTTOM_PADDING;
  return values
    .map((value, index) => {
      const x = values.length === 1 ? WIDTH : (index / (values.length - 1)) * WIDTH;
      const y = TOP_PADDING + (1 - Math.min(100, Math.max(0, value)) / 100) * drawableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export function ResourceHistory({ history }: ResourceHistoryProps) {
  const { t } = useTranslation();
  const cpuPath = pathFor(history.map((point) => point.cpuPercent));
  const memoryPath = pathFor(history.map((point) => point.memoryPercent));
  const latest = history[history.length - 1];

  return (
    <section className="panel history-panel" aria-labelledby="history-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{t("common.fiveMinutes")}</span>
          <h2 id="history-title">{t("history.title")}</h2>
        </div>
        <div className="chart-legend" aria-label={t("history.legend")}>
          <span className={latest ? `resource-usage resource-usage--${resourceUsageLevel(latest.cpuPercent)}` : undefined}><i className="legend-dot legend-dot--cpu" />CPU {latest ? `${latest.cpuPercent.toFixed(0)}%` : t("history.warmup")}</span>
          <span className={latest ? `resource-usage resource-usage--${resourceUsageLevel(latest.memoryPercent)}` : undefined}><i className="legend-dot legend-dot--memory" />{t("history.memory")} {latest ? `${latest.memoryPercent.toFixed(0)}%` : t("history.warmup")}</span>
        </div>
      </div>

      {history.length < 2 ? (
        <div className="history-empty">
          <span className="pulse-dot" />
          {t("history.establishing")}
        </div>
      ) : (
        <svg
          className="history-chart"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("history.chartLabel", {
            cpu: latest?.cpuPercent.toFixed(0),
            memory: latest?.memoryPercent.toFixed(0),
          })}
        >
          <defs>
            <linearGradient id="cpu-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--chart-cpu)" stopOpacity="0.2" />
              <stop offset="1" stopColor="var(--chart-cpu)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[25, 50, 75].map((value) => {
            const y = TOP_PADDING + (1 - value / 100) * (HEIGHT - TOP_PADDING - BOTTOM_PADDING);
            return <line key={value} className="chart-grid" x1="0" x2={WIDTH} y1={y} y2={y} />;
          })}
          <path
            className="chart-area"
            d={`${cpuPath} L${WIDTH} ${HEIGHT - BOTTOM_PADDING} L0 ${HEIGHT - BOTTOM_PADDING} Z`}
          />
          <path className="chart-line chart-line--memory" d={memoryPath} />
          <path className="chart-line chart-line--cpu" d={cpuPath} />
          <text className="chart-axis-label" x="0" y={HEIGHT - 3}>{t("common.earlier")}</text>
          <text className="chart-axis-label" x={WIDTH} y={HEIGHT - 3} textAnchor="end">{t("common.now")}</text>
        </svg>
      )}
    </section>
  );
}
