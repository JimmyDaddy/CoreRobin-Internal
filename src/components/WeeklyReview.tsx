import {
  BellRing,
  CalendarDays,
  CheckCircle2,
  CircleGauge,
  TrendingDown,
  TriangleAlert,
} from "lucide-react";
import { useMemo } from "react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import type { NetworkQualityHistoryPoint } from "../networkQualityHistory";
import type { ResourceAlertEvent } from "../resourceAlerts";
import type { HistoryPoint } from "../types";
import type { UserActionRecord } from "../userActionHistory";
import { formatPercent } from "../utils";
import { buildWeeklyReview } from "../weeklyReview";
import "./WeeklyReview.css";

export function WeeklyReview({
  points,
  alerts,
  networkQualityPoints,
  actions,
  notificationEnabled,
  notificationsAvailable,
  onNotificationEnabledChange,
}: {
  points: readonly HistoryPoint[];
  alerts: readonly ResourceAlertEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actions: readonly UserActionRecord[];
  notificationEnabled: boolean;
  notificationsAvailable: boolean;
  onNotificationEnabledChange: (enabled: boolean) => void;
}) {
  const { t, i18n } = useAppTranslation();
  const review = useMemo(() => buildWeeklyReview({
    points,
    alerts,
    networkQualityPoints,
    actions,
  }), [actions, alerts, networkQualityPoints, points]);
  const todayDifference = review.today.anomalyCount - review.yesterday.anomalyCount;

  return (
    <section className="weekly-review" aria-labelledby="weekly-review-title">
      <header>
        <span><CalendarDays size={19} /></span>
        <div>
          <small>{t("daily:weekly.kicker")}</small>
          <h2 id="weekly-review-title">{t("daily:weekly.title")}</h2>
          <p>{t("daily:weekly.description")}</p>
        </div>
        <label className="weekly-review__notification">
          <input
            type="checkbox"
            role="switch"
            checked={notificationEnabled}
            disabled={!notificationsAvailable}
            onChange={(event) => onNotificationEnabledChange(event.target.checked)}
          />
          <BellRing size={13} />
          <span>{t("daily:weekly.notification")}</span>
        </label>
      </header>

      <div className="weekly-review__periods">
        <PeriodCard
          label={t("daily:weekly.today")}
          anomalies={review.today.anomalyCount}
          actions={review.today.completedActionCount}
          improvements={review.today.observedImprovementCount}
          cpu={review.today.averageCpuPercent}
          memory={review.today.averageMemoryPercent}
        />
        <PeriodCard
          label={t("daily:weekly.yesterday")}
          anomalies={review.yesterday.anomalyCount}
          actions={review.yesterday.completedActionCount}
          improvements={review.yesterday.observedImprovementCount}
          cpu={review.yesterday.averageCpuPercent}
          memory={review.yesterday.averageMemoryPercent}
        />
        <PeriodCard
          label={t("daily:weekly.sevenDays")}
          anomalies={review.sevenDays.anomalyCount}
          actions={review.sevenDays.completedActionCount}
          improvements={review.sevenDays.observedImprovementCount}
          cpu={review.sevenDays.averageCpuPercent}
          memory={review.sevenDays.averageMemoryPercent}
        />
      </div>

      <div className="weekly-review__comparison">
        <TriangleAlert size={15} />
        <p>
          <strong>{t("daily:weekly.comparisonTitle")}</strong>
          <span>{todayDifference === 0
            ? t("daily:weekly.comparison.same", {
                count: review.today.anomalyCount,
              })
            : todayDifference < 0
              ? t("daily:weekly.comparison.fewer", {
                  count: Math.abs(todayDifference),
                })
              : t("daily:weekly.comparison.more", {
                  count: todayDifference,
                })}</span>
        </p>
        <small>{t("daily:weekly.coverage", {
          days: review.dataDayCount,
          average: review.sevenDayDailyAverageAnomalies.toFixed(1),
        })}</small>
      </div>

      <section className="weekly-review__improvements">
        <header>
          <TrendingDown size={15} />
          <strong>{t("daily:weekly.improvementsTitle")}</strong>
        </header>
        {review.improvements.length > 0 ? (
          <ol>
            {review.improvements.slice(0, 5).map(({ record, metrics }) => (
              <li key={record.id}>
                <CheckCircle2 size={14} />
                <span>
                  <strong>{record.targetName ?? t(`history:actions.kind.${record.kind}`)}</strong>
                  <small>{t("daily:weekly.improvementObserved", {
                    metrics: metrics
                      .map((metric) => t(`daily:review.metricNames.${metric}`))
                      .join(" · "),
                    time: new Date(record.completedAtMs ?? record.startedAtMs)
                      .toLocaleString(i18n.resolvedLanguage),
                  })}</small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="weekly-review__empty">
            <CircleGauge size={15} />{t("daily:weekly.noImprovements")}
          </p>
        )}
      </section>
      {!notificationsAvailable ? (
        <small className="weekly-review__notification-hint">
          {t("daily:weekly.notificationUnavailable")}
        </small>
      ) : null}
    </section>
  );
}

function PeriodCard({
  label,
  anomalies,
  actions,
  improvements,
  cpu,
  memory,
}: {
  label: string;
  anomalies: number;
  actions: number;
  improvements: number;
  cpu: number | null;
  memory: number | null;
}) {
  const { t } = useAppTranslation();
  return (
    <article>
      <strong>{label}</strong>
      <dl>
        <div><dt>{t("daily:weekly.anomalies")}</dt><dd>{anomalies}</dd></div>
        <div><dt>{t("daily:weekly.actions")}</dt><dd>{actions}</dd></div>
        <div><dt>{t("daily:weekly.improvements")}</dt><dd>{improvements}</dd></div>
      </dl>
      <small>{t("daily:weekly.averages", {
        cpu: cpu === null ? "—" : formatPercent(cpu),
        memory: memory === null ? "—" : formatPercent(memory),
      })}</small>
    </article>
  );
}
