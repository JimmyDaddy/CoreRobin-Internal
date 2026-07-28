import {
  Activity,
  BatteryMedium,
  Cpu,
  Database,
  MemoryStick,
  Network,
  Sparkles,
  Thermometer,
} from "lucide-react";
import { useMemo } from "react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import {
  buildPersonalBaseline,
  type PersonalBaselineComparison,
} from "../personalBaseline";
import type { HistoryPoint } from "../types";
import { formatRate } from "../utils";

export function PersonalBaselinePanel({
  points,
  compact = false,
}: {
  points: readonly HistoryPoint[];
  compact?: boolean;
}) {
  const { t } = useAppTranslation();
  const comparisons = useMemo(() => buildPersonalBaseline(points), [points]);
  const elevated = comparisons.filter((comparison) => comparison.status === "elevated");
  const learning = comparisons.every((comparison) => comparison.status === "learning");
  const partial = !learning
    && comparisons.some((comparison) => comparison.status === "learning");
  const overall = elevated.length > 0
    ? "elevated"
    : learning
      ? "learning"
      : partial
        ? "partial"
        : "typical";

  return (
    <section className={`panel personal-baseline${compact ? " is-compact" : ""}`} aria-labelledby="personal-baseline-title">
      <header>
        <span className={`personal-baseline__status is-${overall}`}>
          {elevated.length > 0 ? <Activity size={18} /> : <Sparkles size={18} />}
        </span>
        <div>
          <span className="eyebrow">{t("history:baseline.eyebrow")}</span>
          <h3 id="personal-baseline-title">
            {t(`history:baseline.${overall}.title`)}
          </h3>
          <p>{t(`history:baseline.${overall}.description`, {
            count: elevated.length,
          })}</p>
        </div>
      </header>
      <div className="personal-baseline__metrics">
        {comparisons.map((comparison) => (
          <BaselineMetric comparison={comparison} key={comparison.metric} />
        ))}
      </div>
    </section>
  );
}

function BaselineMetric({
  comparison,
}: {
  comparison: PersonalBaselineComparison;
}) {
  const { t } = useAppTranslation();
  const Icon = comparison.metric === "cpu"
    ? Cpu
    : comparison.metric === "memory"
      ? MemoryStick
      : comparison.metric === "disk"
        ? Database
        : comparison.metric === "network"
          ? Network
          : comparison.metric === "temperature"
            ? Thermometer
            : BatteryMedium;
  const value = comparison.current === null
    ? t("common:unavailable")
    : comparison.metric === "cpu" || comparison.metric === "memory"
      ? `${comparison.current.toFixed(0)}%`
      : comparison.metric === "temperature"
        ? `${comparison.current.toFixed(1)} °C`
        : comparison.metric === "battery"
          ? `${comparison.current.toFixed(1)}%/h`
      : formatRate(comparison.current);
  const delta = comparison.changePercent === null
    ? t("history:baseline.collecting")
    : t("history:baseline.change", {
        value: Math.abs(comparison.changePercent).toFixed(0),
        direction: t(comparison.changePercent >= 0
          ? "history:baseline.higher"
          : "history:baseline.lower"),
      });
  return (
    <div className={`is-${comparison.status}`}>
      <Icon size={15} />
      <span>
        <small>{t(`history:baseline.metric.${comparison.metric}`)}</small>
        <strong>{value}</strong>
      </span>
      <span className="personal-baseline__evidence">
        <em>{delta}</em>
        <small>
          {t("history:baseline.coverage", {
            days: comparison.distinctDayCount,
            count: comparison.sampleCount,
          })}
        </small>
      </span>
    </div>
  );
}
