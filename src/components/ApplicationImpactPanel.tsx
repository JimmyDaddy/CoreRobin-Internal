import { AppWindow, ArrowRight, ChevronDown, ChevronUp, Search, ShieldCheck } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  applicationImpactLevel,
  applicationPrimaryResource,
  sortApplications,
  reconcileApplicationOrder,
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
  const { t } = useAppTranslation();
  const [sortKey, setSortKey] = useState<ApplicationSortKey>("impact");
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [page, setPage] = useState(0);
  const [order, setOrder] = useState(() => sortApplications(applications, "impact", totalMemoryBytes).map(({ id }) => id));
  useEffect(() => {
    setOrder((current) => {
      const next = reconcileApplicationOrder(current, applications, totalMemoryBytes, false);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [applications, totalMemoryBytes]);
  const reorder = (key = sortKey) => {
    setSortKey(key);
    setOrder(sortApplications(applications, key, totalMemoryBytes).map(({ id }) => id));
    setPage(0);
  };
  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const byId = new Map(applications.map((application) => [application.id, application]));
    const filtered = order.map((id) => byId.get(id)).filter((application): application is ApplicationImpact => Boolean(application))
      .filter((application) => (!normalizedQuery || application.name.toLocaleLowerCase().includes(normalizedQuery))
        && (showSystem || normalizedQuery || (application.kind
          ? !["system", "unknown"].includes(application.kind) : !application.systemComponent)));
    const sorted = compact ? sortApplications(filtered, sortKey, totalMemoryBytes) : filtered;
    return compact ? sorted.slice(0, 5) : sorted;
  }, [applications, compact, query, sortKey, totalMemoryBytes, order, showSystem]);
  const pageCount = Math.max(1, Math.ceil(visibleApplications.length / 24));
  const currentPage = Math.min(page, pageCount - 1);
  const pageApplications = compact ? visibleApplications : visibleApplications.slice(currentPage * 24, (currentPage + 1) * 24);

  return (
    <section
      className={`panel application-impact${compact ? " application-impact--compact" : ""}`}
      aria-labelledby={compact ? "application-impact-overview-title" : "application-impact-title"}
    >
      <header className="application-impact__header">
        <div>
          <span className="eyebrow">{t("applications:kicker")}</span>
          <h2 id={compact ? "application-impact-overview-title" : "application-impact-title"}>
            {compact ? t("applications:overviewTitle") : t("applications:title")}
          </h2>
          <p>{t("applications:description")}</p>
        </div>
        {compact && onViewAll ? (
          <button className="application-impact__view-all" type="button" onClick={onViewAll}>
            {t("applications:viewAll")}<ArrowRight size={14} />
          </button>
        ) : null}
      </header>

      {!compact ? (
        <div className="application-impact__toolbar">
          <label className="application-impact__search">
            <Search size={14} />
            <span className="sr-only">{t("applications:search")}</span>
            <input
              type="search"
              value={query}
              placeholder={t("applications:searchPlaceholder")}
              onChange={(event) => { setQuery(event.target.value); setPage(0); }}
            />
          </label>
          <div className="application-impact__sort" role="group" aria-label={t("applications:sortLabel")}>
            {SORT_KEYS.map((key) => (
              <button
                className={sortKey === key ? "is-active" : ""}
                type="button"
                key={key}
                aria-pressed={sortKey === key}
                onClick={() => reorder(key)}
              >
                {t(`applications:sort.${key}`)}
              </button>
            ))}
            <button type="button" onClick={() => reorder()}>{t("applications:experience.reorder")}</button>
          </div>
          <label><input type="checkbox" checked={showSystem} onChange={(event) => { setShowSystem(event.target.checked); setPage(0); }} />{t("applications:experience.showSystem")}</label>
        </div>
      ) : null}

      <div className="application-impact__list">
        {pageApplications.map((application) => {
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
                <ApplicationAvatar
                  name={application.name}
                  source={{ process: application.iconProcess }}
                  className="application-impact-row__avatar"
                />
                <span className="application-impact-row__identity">
                  <strong>{application.name}</strong>
                  <small>
                    {application.kind && application.kind !== "user" ? (
                      <><ShieldCheck size={11} />{application.kind === "system" ? t("applications:systemComponent") : t(`applications:experience.${application.kind}`)}</>
                    ) : application.systemComponent ? (
                      <><ShieldCheck size={11} />{t("applications:systemComponent")}</>
                    ) : (
                      <><AppWindow size={11} />{t("applications:processCount", { count: application.processCount })}</>
                    )}
                  </small>
                </span>
                <span className="application-impact-row__metrics">
                  <span><small>CPU</small><strong>{formatPercent(application.cpuPercent)}</strong></span>
                  <span><small>{t("applications:memory")}</small><strong>{formatBytes(application.memoryBytes)}</strong></span>
                  <span><small>{t("applications:disk")}</small><strong>{formatRate(application.diskBytesPerSecond)}</strong></span>
                </span>
                <span className={`application-impact-row__level resource-usage resource-usage--${impact}`}>
                  {t(`applications:level.${impact}`)}
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
                    <strong>{t("applications:selected.title", { name: application.name })}</strong>
                    <span>{primaryResource === "balanced"
                      ? t("applications:selected.balanced")
                      : t(`applications:selected.${primaryResource}`, { value: primaryValue ?? "" })}</span>
                    <small className={application.systemComponent ? "is-warning" : ""}>
                      <ShieldCheck size={12} />
                      {application.systemComponent
                        ? t("applications:selected.systemSafety")
                        : t("applications:selected.appSafety")}
                    </small>
                  </div>
                  {onOpenProfessionalDetails ? (
                    <button type="button" onClick={() => onOpenProfessionalDetails(application)}>
                      {t("applications:selected.professionalDetails")}<ArrowRight size={14} />
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
            <strong>{t("applications:empty")}</strong>
          </div>
        ) : null}
      </div>

      {!compact && pageCount > 1 ? <nav className="application-impact__pagination">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("applications:experience.previous")}</button>
        <span>{t("applications:experience.page", { page: currentPage + 1, total: pageCount })}</span>
        <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("applications:experience.next")}</button>
      </nav> : null}

      <footer className="application-impact__footer">
        <ShieldCheck size={13} />
        <span>{t("applications:safety")}</span>
      </footer>
    </section>
  );
}
