import {
  AppWindow,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Gauge,
  LoaderCircle,
  Power,
  RefreshCw,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import { sortApplications } from "../applicationImpact";
import {
  dailyApplicationSummary,
  type DailyRecheck,
} from "../dailyExperience";
import type { ApplicationImpact } from "../diagnosis";
import { formatBytes, formatPercent, formatRate } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { Button } from "./Button";

interface DailyApplicationsProps {
  applications: readonly ApplicationImpact[];
  totalMemoryBytes: number;
  sampledAtMs: number;
  preparingAction: boolean;
  recheck: DailyRecheck | null;
  onRefresh: () => Promise<DailyApplicationSnapshot>;
  onRequestClose: (identity: string, name: string) => void;
}

export interface DailyApplicationSnapshot {
  applications: readonly ApplicationImpact[];
  totalMemoryBytes: number;
  sampledAtMs: number;
}

export function DailyApplications({
  applications,
  totalMemoryBytes,
  sampledAtMs,
  preparingAction,
  recheck,
  onRefresh,
  onRequestClose,
}: DailyApplicationsProps) {
  const { t, i18n } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedApplicationId, setExpandedApplicationId] = useState<string | null>(null);
  const [applicationSnapshot, setApplicationSnapshot] = useState<DailyApplicationSnapshot>(() => ({
    applications: [...applications],
    totalMemoryBytes,
    sampledAtMs,
  }));

  const refreshSnapshot = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await onRefresh();
      setApplicationSnapshot({
        ...next,
        applications: [...next.applications],
      });
      setExpandedApplicationId((current) =>
        next.applications.some(({ id }) => id === current) ? current : null,
      );
    } finally {
      setRefreshing(false);
    }
  };

  const ordered = useMemo(() => {
    return sortedUserApplications(
      applicationSnapshot.applications,
      applicationSnapshot.totalMemoryBytes,
    );
  }, [applicationSnapshot]);
  const noteworthy = ordered.filter((application) => {
    const impact = dailyApplicationSummary(
      application,
      applicationSnapshot.totalMemoryBytes,
    ).impact;
    return impact === "moderate" || impact === "high" || impact === "critical";
  }).slice(0, 3);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = (showAll ? ordered : noteworthy)
    .filter(({ name }) => !normalized || name.toLocaleLowerCase().includes(normalized))
    .slice(0, showAll ? 40 : 3);

  return (
    <section className="daily-applications" aria-labelledby="daily-applications-title">
      <header className="daily-page-hero daily-applications__hero">
        <span className="daily-page-hero__icon"><AppWindow size={22} /></span>
        <div>
          <span className="eyebrow">{t("daily:applications.kicker")}</span>
          <h1 id="daily-applications-title">{t("daily:applications.title")}</h1>
          <p>{t("daily:applications.description")}</p>
        </div>
        <Button variant="secondary" disabled={refreshing} onClick={() => void refreshSnapshot()}>
          <RefreshCw className={refreshing ? "is-spinning" : undefined} size={14} />{t(refreshing ? "daily:applications.refreshing" : "daily:applications.refresh")}
        </Button>
      </header>

      {recheck ? (
        <div className="daily-recheck" role="status">
          <Gauge size={17} />
          <div><strong>{t("daily:recheck.title")}</strong><span>{t(`daily:recheck.${recheck.outcome}`)}</span></div>
          <small>{new Date(recheck.checkedAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" })}</small>
        </div>
      ) : null}

      <div className="daily-applications__snapshot">
        <span>{noteworthy.length > 0 ? <Gauge size={18} /> : <CheckCircle2 size={18} />}</span>
        <div>
          <strong>{t(noteworthy.length > 0 ? "daily:applications.snapshotFound" : "daily:applications.snapshotClear", { count: noteworthy.length })}</strong>
          <small>{t("daily:applications.snapshotTime", { time: new Date(applicationSnapshot.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" }) })}</small>
        </div>
      </div>

      {showAll ? (
        <label className="daily-search daily-applications__search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("daily:applications.search")} />
        </label>
      ) : null}

      {visible.length > 0 ? (
        <div className="daily-application-list">
          {visible.map((application) => {
            const selected = expandedApplicationId === application.id;
            const summary = dailyApplicationSummary(
              application,
              applicationSnapshot.totalMemoryBytes,
            );
            return (
              <article className={`daily-application is-${summary.impact}${selected ? " is-selected" : ""}`} key={application.id}>
                <button className="daily-application__summary" type="button" aria-expanded={selected} onClick={() => setExpandedApplicationId(selected ? null : application.id)}>
                  <ApplicationAvatar application={application} className="daily-application__avatar" />
                  <span className="daily-application__identity">
                    <strong>{application.name}</strong>
                    <small><AppWindow size={11} />{t("daily:applications.ordinary")}</small>
                  </span>
                  <span className="daily-application__meaning">
                    <strong>{t(`daily:applications.level.${summary.impact}`)}</strong>
                    <small>{t(`daily:applications.reason.${summary.primaryResource}`, { name: application.name })}</small>
                  </span>
                  {selected ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {selected ? (
                  <div className="daily-application__details">
                    <details className="daily-evidence">
                      <summary><Gauge size={14} />{t("daily:applications.viewEvidence")}</summary>
                      <div className="daily-application__evidence">
                        <span><small>{t("daily:applications.evidence.cpu")}</small><strong>{formatPercent(application.cpuPercent)}</strong></span>
                        <span><small>{t("daily:applications.evidence.memory")}</small><strong>{formatBytes(application.memoryBytes)}</strong></span>
                        <span><small>{t("daily:applications.evidence.disk")}</small><strong>{formatRate(application.diskBytesPerSecond)}</strong></span>
                      </div>
                    </details>
                    {application.actionIdentity ? (
                      <Button variant="primary" disabled={preparingAction} onClick={() => onRequestClose(application.actionIdentity!, application.name)}>
                        {preparingAction ? <LoaderCircle className="is-spinning" size={14} /> : <Power size={14} />}
                        {t("daily:applications.requestClose", { name: application.name })}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : !showAll ? (
        <div className="daily-applications__calm"><CheckCircle2 size={23} /><strong>{t("daily:applications.calmTitle")}</strong><span>{t("daily:applications.calmDescription")}</span></div>
      ) : (
        <div className="daily-list-empty"><AppWindow size={22} /><strong>{t("daily:applications.empty")}</strong></div>
      )}

      <button className="daily-applications__all" type="button" onClick={() => {
        setShowAll((current) => !current);
        setQuery("");
        setExpandedApplicationId(null);
      }}>
        {t(showAll ? "daily:applications.hideAll" : "daily:applications.showAll", { count: ordered.length })}
        {showAll ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
    </section>
  );
}

function sortedUserApplications(
  applications: readonly ApplicationImpact[],
  totalMemoryBytes: number,
) {
  return sortApplications(applications, "impact", totalMemoryBytes)
    .filter(({ systemComponent }) => !systemComponent);
}
