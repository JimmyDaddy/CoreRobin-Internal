import {
  ArrowRight,
  CheckCircle2,
  CircleGauge,
  History,
  Network,
  Sparkles,
} from "lucide-react";
import { useMemo } from "react";
import type { ReactNode } from "react";

import type { ApplicationImpactHistoryPoint } from "../applicationImpactHistory";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { NetworkQualityHistoryPoint } from "../networkQualityHistory";
import type { ResourceAlertEvent } from "../resourceAlerts";
import {
  buildTodayReview,
  type TodayActionResult,
} from "../todayReview";
import type { HistoryPoint } from "../types";
import type {
  UserActionKind,
  UserActionRecord,
} from "../userActionHistory";
import { formatPercent } from "../utils";
import { Button } from "./Button";
import "./TodayReview.css";

export function TodayReview({
  points,
  applicationImpactPoints,
  alertEvents,
  networkQualityPoints,
  actionRecords,
  onOpenAction,
}: {
  points: readonly HistoryPoint[];
  applicationImpactPoints: readonly ApplicationImpactHistoryPoint[];
  alertEvents: readonly ResourceAlertEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actionRecords: readonly UserActionRecord[];
  onOpenAction: (kind: UserActionKind) => void;
}) {
  const { t } = useAppTranslation();
  const review = useMemo(() => buildTodayReview({
    points,
    applicationImpactPoints,
    alerts: alertEvents,
    networkQualityPoints,
    actions: actionRecords,
  }), [
    actionRecords,
    alertEvents,
    applicationImpactPoints,
    networkQualityPoints,
    points,
  ]);

  return (
    <section
      className={`today-review is-${review.status}`}
      aria-labelledby="today-review-title"
    >
      <header className="today-review__header">
        <span className="today-review__mark"><Sparkles size={20} /></span>
        <div>
          <small>{t("daily:review.kicker")}</small>
          <h2 id="today-review-title">{t("daily:review.title")}</h2>
          <p>{t("daily:review.description")}</p>
        </div>
        <strong className="today-review__status">
          {t(`daily:review.status.${review.status}`, {
            count: review.activeCount,
          })}
        </strong>
      </header>

      <div className="today-review__metrics">
        <ReviewMetric
          icon={<CircleGauge size={16} />}
          label={t("daily:review.metrics.events")}
          value={review.eventCount}
        />
        <ReviewMetric
          icon={<CheckCircle2 size={16} />}
          label={t("daily:review.metrics.resolved")}
          value={review.resolvedCount}
        />
        <ReviewMetric
          icon={<History size={16} />}
          label={t("daily:review.metrics.actions")}
          value={review.completedActionCount}
        />
        <ReviewMetric
          icon={<Network size={16} />}
          label={t("daily:review.metrics.network")}
          value={review.networkEventCount}
        />
      </div>

      {review.leadingApplicationName ? (
        <p className="today-review__evidence">
          <CircleGauge size={15} />
          {t("daily:review.evidence", {
            name: review.leadingApplicationName,
            cpu: formatPercent(review.peakCpuPercent),
            memory: formatPercent(review.peakMemoryPercent),
          })}
        </p>
      ) : null}

      <section className="today-review__results" aria-labelledby="today-review-results-title">
        <header>
          <div>
            <strong id="today-review-results-title">
              {t("daily:review.resultsTitle")}
            </strong>
            <small>{t("daily:review.resultsDescription")}</small>
          </div>
        </header>
        {review.actionResults.length > 0 ? (
          <div className="today-review__result-list">
            {review.actionResults.map((result) => (
              <ActionResult
                key={result.record.id}
                result={result}
                onOpen={() => onOpenAction(result.record.kind)}
              />
            ))}
          </div>
        ) : (
          <p className="today-review__empty">
            <CheckCircle2 size={17} />
            {t("daily:review.noResults")}
          </p>
        )}
      </section>
    </section>
  );
}

function ReviewMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <span>
      {icon}
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function ActionResult({
  result,
  onOpen,
}: {
  result: TodayActionResult;
  onOpen: () => void;
}) {
  const { t } = useAppTranslation();
  const effect = result.effect === "not_applicable"
    ? t(`history:actions.verification.${result.record.verification}`)
    : t(`history:replay.actionImpact.${result.effect}`);
  return (
    <article className={`is-${result.record.status}`}>
      <span><CheckCircle2 size={15} /></span>
      <div>
        <small>{t(`history:actions.kind.${result.record.kind}`)}</small>
        <strong>
          {result.record.targetName
            ?? t("history:actions.target.application")}
        </strong>
        <p>{effect}</p>
      </div>
      <Button variant="plain" onClick={onOpen}>
        {t("daily:review.open")}<ArrowRight size={12} />
      </Button>
    </article>
  );
}
