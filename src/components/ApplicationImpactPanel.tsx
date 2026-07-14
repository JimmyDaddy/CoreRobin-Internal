import { AppWindow, ArrowRight, ChevronDown, ChevronUp, Search, ShieldCheck } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  applicationImpactLevel,
  applicationPrimaryResource,
  sortApplications,
  type ApplicationSortKey,
} from "../applicationImpact";
import type { ApplicationImpact } from "../diagnosis";
import { formatBytes, formatPercent, formatRate } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";

interface ApplicationImpactPanelProps {
  applications: readonly ApplicationImpact[];
  totalMemoryBytes: number;
  selectedIdentity: string | null;
  compact?: boolean;
  onSelect: (application: ApplicationImpact) => void;
  onViewAll?: () => void;
  onOpenProfessionalDetails?: (application: ApplicationImpact) => void;
}

const SORT_KEYS: ApplicationSortKey[] = ["impact", "cpu", "memory", "disk"];

export function ApplicationImpactPanel({
  applications,
  totalMemoryBytes,
  selectedIdentity,
  compact = false,
  onSelect,
  onViewAll,
  onOpenProfessionalDetails,
}: ApplicationImpactPanelProps) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<ApplicationSortKey>("impact");
  const [query, setQuery] = useState("");
  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = normalizedQuery
      ? applications.filter(({ name }) =>
          name.toLocaleLowerCase().includes(normalizedQuery))
      : applications;
    const sorted = sortApplications(filtered, sortKey, totalMemoryBytes);
    return compact ? sorted.slice(0, 5) : sorted;
  }, [applications, compact, query, sortKey, totalMemoryBytes]);

  return (
    <section
      className={`panel application-impact${compact ? " application-impact--compact" : ""}`}
      aria-labelledby={compact ? "application-impact-overview-title" : "application-impact-title"}
    >
      <header className="application-impact__header">
        <div>
          <span className="eyebrow">{t("applications.kicker")}</span>
          <h2 id={compact ? "application-impact-overview-title" : "application-impact-title"}>
            {compact ? t("applications.overviewTitle") : t("applications.title")}
          </h2>
          <p>{t("applications.description")}</p>
        </div>
        {compact && onViewAll ? (
          <button className="application-impact__view-all" type="button" onClick={onViewAll}>
            {t("applications.viewAll")}<ArrowRight size={14} />
          </button>
        ) : null}
      </header>

      {!compact ? (
        <div className="application-impact__toolbar">
          <label className="application-impact__search">
            <Search size={14} />
            <span className="sr-only">{t("applications.search")}</span>
            <input
              type="search"
              value={query}
              placeholder={t("applications.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="application-impact__sort" role="group" aria-label={t("applications.sortLabel")}>
            {SORT_KEYS.map((key) => (
              <button
                className={sortKey === key ? "is-active" : ""}
                type="button"
                key={key}
                aria-pressed={sortKey === key}
                onClick={() => setSortKey(key)}
              >
                {t(`applications.sort.${key}`)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="application-impact__list">
        {visibleApplications.map((application) => {
          const selected = !compact && selectedIdentity !== null &&
            application.memberIdentities.includes(selectedIdentity);
          const impact = applicationImpactLevel(application, totalMemoryBytes);
          const primaryResource = applicationPrimaryResource(
            application,
            totalMemoryBytes,
          );
          const primaryValue = primaryResource === "cpu"
            ? formatPercent(application.cpuPercent)
            : primaryResource === "memory"
              ? formatBytes(application.memoryBytes)
              : primaryResource === "disk"
                ? formatRate(application.diskBytesPerSecond)
                : null;
          return (
            <Fragment key={application.id}>
              <button
                className={`application-impact-row${selected ? " is-selected" : ""}`}
                type="button"
                aria-expanded={!compact ? selected : undefined}
                aria-pressed={selected}
                onClick={() => onSelect(application)}
              >
                <ApplicationAvatar application={application} className="application-impact-row__avatar" />
                <span className="application-impact-row__identity">
                  <strong>{application.name}</strong>
                  <small>
                    {application.systemComponent ? (
                      <><ShieldCheck size={11} />{t("applications.systemComponent")}</>
                    ) : (
                      <><AppWindow size={11} />{t("applications.processCount", { count: application.processCount })}</>
                    )}
                  </small>
                </span>
                <span className="application-impact-row__metrics">
                  <span><small>CPU</small><strong>{formatPercent(application.cpuPercent)}</strong></span>
                  <span><small>{t("applications.memory")}</small><strong>{formatBytes(application.memoryBytes)}</strong></span>
                  <span><small>{t("applications.disk")}</small><strong>{formatRate(application.diskBytesPerSecond)}</strong></span>
                </span>
                <span className={`application-impact-row__level resource-usage resource-usage--${impact}`}>
                  {t(`applications.level.${impact}`)}
                </span>
                {compact ? (
                  <ArrowRight className="application-impact-row__arrow" size={15} />
                ) : selected ? (
                  <ChevronUp className="application-impact-row__arrow" size={15} />
                ) : (
                  <ChevronDown className="application-impact-row__arrow" size={15} />
                )}
              </button>
              {!compact && selected ? (
                <div className="application-impact-selection" role="status">
                  <div>
                    <strong>{t("applications.selected.title", { name: application.name })}</strong>
                    <span>{t(`applications.selected.${primaryResource}`, { value: primaryValue })}</span>
                    <small className={application.systemComponent ? "is-warning" : ""}>
                      <ShieldCheck size={12} />
                      {application.systemComponent
                        ? t("applications.selected.systemSafety")
                        : t("applications.selected.appSafety")}
                    </small>
                  </div>
                  {onOpenProfessionalDetails ? (
                    <button type="button" onClick={() => onOpenProfessionalDetails(application)}>
                      {t("applications.selected.professionalDetails")}<ArrowRight size={14} />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {visibleApplications.length === 0 ? (
          <div className="application-impact__empty">
            <AppWindow size={20} />
            <strong>{t("applications.empty")}</strong>
          </div>
        ) : null}
      </div>

      <footer className="application-impact__footer">
        <ShieldCheck size={13} />
        <span>{t("applications.safety")}</span>
      </footer>
    </section>
  );
}
