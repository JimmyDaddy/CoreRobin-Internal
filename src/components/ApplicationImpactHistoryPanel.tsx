import { Activity, Cpu, Database, MemoryStick, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import {
  applicationImpactHistoryInRange,
  summarizeApplicationImpactHistory,
  type ApplicationImpactHistoryPoint,
  type ApplicationImpactHistoryRangeHours,
} from "../applicationImpactHistory";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { formatBytes, formatPercent, formatRate } from "../utils";

export function ApplicationImpactHistoryPanel({
  points,
  enabled,
  onEnabledChange,
}: {
  points: readonly ApplicationImpactHistoryPoint[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { t } = useAppTranslation();
  const [rangeHours, setRangeHours] =
    useState<ApplicationImpactHistoryRangeHours>(24);
  const visiblePoints = useMemo(
    () => applicationImpactHistoryInRange(points, rangeHours),
    [points, rangeHours],
  );
  const applications = useMemo(
    () => summarizeApplicationImpactHistory(visiblePoints),
    [visiblePoints],
  );

  return (
    <section className="panel application-impact-history" aria-labelledby="application-impact-history-title">
      <header>
        <div>
          <span className="eyebrow">{t("history:applicationImpact.eyebrow")}</span>
          <h3 id="application-impact-history-title">
            <Activity size={17} />{t("history:applicationImpact.title")}
          </h3>
          <p>{t("history:applicationImpact.description")}</p>
        </div>
        <label className="settings-switch">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <span>{t("history:applicationImpact.enable")}</span>
        </label>
      </header>
      <div className="application-impact-history__ranges" role="group" aria-label={t("history:applicationImpact.range")}>
        {([1, 24, 168] as const).map((hours) => (
          <button
            type="button"
            className={rangeHours === hours ? "is-active" : undefined}
            aria-pressed={rangeHours === hours}
            key={hours}
            onClick={() => setRangeHours(hours)}
          >
            {t(`history:applicationImpact.hours${hours}`)}
          </button>
        ))}
      </div>
      {!enabled ? (
        <div className="application-impact-history__empty">
          <ShieldCheck size={20} />
          <strong>{t("history:applicationImpact.disabledTitle")}</strong>
          <span>{t("history:applicationImpact.disabledDescription")}</span>
        </div>
      ) : applications.length === 0 ? (
        <div className="application-impact-history__empty">
          <Activity size={20} />
          <strong>{t("history:applicationImpact.learningTitle")}</strong>
          <span>{t("history:applicationImpact.learningDescription")}</span>
        </div>
      ) : (
        <ol className="application-impact-history__list">
          {applications.slice(0, 8).map((application, index) => (
            <li key={application.applicationId}>
              <span className="application-impact-history__rank">{index + 1}</span>
              <strong>{application.name}</strong>
              <span><Cpu size={13} />{formatPercent(application.averageCpuPercent)}</span>
              <span><MemoryStick size={13} />{formatBytes(application.averageMemoryBytes)}</span>
              <span><Database size={13} />{formatRate(application.averageDiskBytesPerSecond)}</span>
              <small>{t("history:applicationImpact.peakCpu", {
                value: formatPercent(application.peakCpuPercent),
              })}</small>
            </li>
          ))}
        </ol>
      )}
      <small className="application-impact-history__boundary">
        <ShieldCheck size={12} />{t("history:applicationImpact.boundary")}
      </small>
    </section>
  );
}
