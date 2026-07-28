import {
  Activity,
  Clock3,
  Cpu,
  Database,
  MemoryStick,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  applicationImpactHistoryForDisplay,
  applicationImpactHistoryInRange,
  applicationImpactPointScore,
  summarizeApplicationImpactHistory,
  type ApplicationImpactHistoryPoint,
  type ApplicationImpactHistoryRangeHours,
} from "../applicationImpactHistory";
import type { ApplicationImpactHistoryStorageStatus } from "../hooks/useApplicationImpactHistory";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { formatBytes, formatPercent, formatRate } from "../utils";

export function ApplicationImpactHistoryPanel({
  points,
  enabled,
  focusAtMs = null,
  storageStatus,
  onEnabledChange,
}: {
  points: readonly ApplicationImpactHistoryPoint[];
  enabled: boolean;
  focusAtMs?: number | null;
  storageStatus: ApplicationImpactHistoryStorageStatus;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { t, i18n } = useAppTranslation();
  const [rangeHours, setRangeHours] =
    useState<ApplicationImpactHistoryRangeHours>(24);
  const [selectedAtMs, setSelectedAtMs] = useState<number | null>(null);
  const visiblePoints = useMemo(
    () => applicationImpactHistoryInRange(points, rangeHours),
    [points, rangeHours],
  );
  const applications = useMemo(
    () => summarizeApplicationImpactHistory(visiblePoints),
    [visiblePoints],
  );
  const displayPoints = useMemo(
    () => applicationImpactHistoryForDisplay(visiblePoints, rangeHours),
    [rangeHours, visiblePoints],
  );
  const selectedPoint = useMemo(
    () =>
      displayPoints.find((point) => point.bucketStartMs === selectedAtMs)
      ?? [...displayPoints].sort(
        (left, right) =>
          applicationImpactPointScore(right) - applicationImpactPointScore(left),
      )[0]
      ?? null,
    [displayPoints, selectedAtMs],
  );
  const selectedApplications = useMemo(
    () => selectedPoint
      ? summarizeApplicationImpactHistory([selectedPoint])
      : [],
    [selectedPoint],
  );
  const maximumScore = Math.max(
    1,
    ...displayPoints.map(applicationImpactPointScore),
  );

  useEffect(() => {
    if (!focusAtMs) return;
    const ageHours = Math.max(0, (Date.now() - focusAtMs) / (60 * 60 * 1_000));
    setRangeHours(ageHours <= 1 ? 1 : ageHours <= 24 ? 24 : 168);
  }, [focusAtMs]);

  useEffect(() => {
    if (!focusAtMs || displayPoints.length === 0) return;
    const closest = [...displayPoints].sort(
      (left, right) =>
        Math.abs(left.sampledAtMs - focusAtMs)
        - Math.abs(right.sampledAtMs - focusAtMs),
    )[0];
    if (closest) setSelectedAtMs(closest.bucketStartMs);
  }, [displayPoints, focusAtMs]);

  return (
    <section
      className="panel application-impact-history"
      id="application-impact-history"
      aria-labelledby="application-impact-history-title"
    >
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
        <>
          <div className="application-impact-history__timeline">
            <div className="application-impact-history__timeline-heading">
              <span><Clock3 size={13} />{t("history:applicationImpact.timeline")}</span>
              <small>{t("history:applicationImpact.timelineHint")}</small>
            </div>
            <div
              className="application-impact-history__bars"
              role="listbox"
              aria-label={t("history:applicationImpact.timeline")}
            >
              {displayPoints.map((point) => {
                const score = applicationImpactPointScore(point);
                const active = selectedPoint?.bucketStartMs === point.bucketStartMs;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={active ? "is-active" : undefined}
                    key={point.bucketStartMs}
                    title={new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                      dateStyle: rangeHours === 168 ? "short" : undefined,
                      timeStyle: "short",
                    }).format(point.sampledAtMs)}
                    onClick={() => setSelectedAtMs(point.bucketStartMs)}
                  >
                    <i style={{ height: `${Math.max(8, score / maximumScore * 100)}%` }} />
                  </button>
                );
              })}
            </div>
            {selectedPoint && selectedApplications[0] ? (
              <p className="application-impact-history__explanation">
                {t("history:applicationImpact.explanation", {
                  time: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                    dateStyle: rangeHours === 168 ? "short" : undefined,
                    timeStyle: "short",
                  }).format(selectedPoint.sampledAtMs),
                  name: selectedApplications[0].name,
                  cpu: formatPercent(selectedApplications[0].averageCpuPercent),
                  memory: formatBytes(selectedApplications[0].averageMemoryBytes),
                })}
              </p>
            ) : null}
          </div>
          <ol className="application-impact-history__list">
          {(selectedPoint ? selectedApplications : applications).slice(0, 8).map((application, index) => (
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
        </>
      )}
      <div
        className={`application-impact-history__storage is-${storageStatus.state}`}
        role={storageStatus.state === "failed" ? "alert" : "status"}
      >
        {storageStatus.state === "failed"
          ? <TriangleAlert size={13} />
          : <Database size={13} />}
        <span>
          {storageStatus.state === "loading"
            ? t("history:applicationImpact.storageLoading")
            : storageStatus.state === "failed"
              ? t("history:applicationImpact.storageFailed")
              : t("history:applicationImpact.storageReady", {
                size: formatBytes(storageStatus.byteSize),
                time: storageStatus.lastSavedAtMs
                  ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                    timeStyle: "short",
                  }).format(storageStatus.lastSavedAtMs)
                  : t("history:applicationImpact.storagePending"),
              })}
        </span>
      </div>
      <small className="application-impact-history__boundary">
        <ShieldCheck size={12} />{t("history:applicationImpact.boundary")}
      </small>
    </section>
  );
}
