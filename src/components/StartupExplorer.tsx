import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  createStartupManagementLease,
  executeStartupManagement,
  releaseStartupManagementLease,
} from "../api";
import type { ApplicationImpact } from "../diagnosis";
import {
  filterStartupItems,
  startupAdvice,
  startupImpactLevel,
  startupRuntimeApplication,
} from "../startupItems";
import type {
  CommandError,
  StartupItem,
  StartupItemsSnapshot,
  StartupManagementAction,
  StartupManagementLease,
} from "../types";
import { formatBytes, formatPercent, normalizeCommandError } from "../utils";
import { StartupActionDialog } from "./StartupActionDialog";

interface StartupExplorerProps {
  variant?: "professional" | "guided";
  snapshot: StartupItemsSnapshot | null;
  error: CommandError | null;
  loading: boolean;
  applications: readonly ApplicationImpact[];
  totalMemoryBytes: number;
  onRefresh: () => void | Promise<void>;
}

export function StartupExplorer({
  variant = "professional",
  snapshot,
  error,
  loading,
  applications,
  totalMemoryBytes,
  onRefresh,
}: StartupExplorerProps) {
  const { t, i18n } = useAppTranslation();
  const [filter, setFilter] = useState<"review" | "all" | "system">("review");
  const [query, setQuery] = useState("");
  const [actionItem, setActionItem] = useState<StartupItem | null>(null);
  const [action, setAction] = useState<StartupManagementAction | null>(null);
  const [lease, setLease] = useState<StartupManagementLease | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<CommandError | null>(null);
  const [outcome, setOutcome] = useState<{ name: string; enabled: boolean } | null>(null);
  const leaseRef = useRef<StartupManagementLease | null>(null);
  const requestIdRef = useRef(0);
  const items = snapshot?.items ?? [];
  const visible = useMemo(
    () => filterStartupItems(
      items,
      variant === "guided" ? "review" : filter,
      variant === "guided" ? "" : query,
    ).slice(0, variant === "guided" ? 8 : 100),
    [filter, items, query, variant],
  );
  const reviewCount = items.filter((item) => startupAdvice(item) === "review").length;
  const systemCount = items.filter((item) => item.system).length;

  const closeActionDialog = useCallback(() => {
    requestIdRef.current += 1;
    const currentLease = leaseRef.current;
    leaseRef.current = null;
    if (currentLease) {
      void releaseStartupManagementLease({ leaseId: currentLease.id }).catch(() => undefined);
    }
    setActionItem(null);
    setAction(null);
    setLease(null);
    setPreparing(false);
    setSubmitting(false);
    setActionError(null);
  }, []);

  useEffect(() => () => {
    requestIdRef.current += 1;
    const currentLease = leaseRef.current;
    if (currentLease) {
      void releaseStartupManagementLease({ leaseId: currentLease.id });
    }
  }, []);

  const openActionDialog = async (item: StartupItem) => {
    if (item.managementStatus !== "available") return;
    const nextAction: StartupManagementAction = item.enabled ? "disable" : "enable";
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setActionItem(item);
    setAction(nextAction);
    setLease(null);
    leaseRef.current = null;
    setPreparing(true);
    setSubmitting(false);
    setActionError(null);
    setOutcome(null);
    try {
      const nextLease = await createStartupManagementLease({
        itemId: item.id,
        action: nextAction,
      });
      if (requestIdRef.current !== requestId) {
        await releaseStartupManagementLease({ leaseId: nextLease.id });
        return;
      }
      leaseRef.current = nextLease;
      setLease(nextLease);
    } catch (caughtError) {
      if (requestIdRef.current === requestId) {
        setActionError(normalizeCommandError(caughtError));
      }
    } finally {
      if (requestIdRef.current === requestId) setPreparing(false);
    }
  };

  const confirmAction = async () => {
    if (!actionItem || !action || !lease || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const result = await executeStartupManagement({ leaseId: lease.id });
      leaseRef.current = null;
      setOutcome({ name: actionItem.name, enabled: result.enabled });
      requestIdRef.current += 1;
      setActionItem(null);
      setAction(null);
      setLease(null);
      await onRefresh();
    } catch (caughtError) {
      leaseRef.current = null;
      setLease(null);
      setActionError(normalizeCommandError(caughtError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={`startup-explorer${variant === "guided" ? " startup-explorer--guided" : ""}`} aria-labelledby="startup-title">
      {variant === "professional" ? <header className="panel startup-hero">
        <span className="startup-hero__icon"><Rocket size={20} /></span>
        <div>
          <span className="eyebrow">{t("startup:eyebrow")}</span>
          <h2 id="startup-title">{t("startup:title")}</h2>
          <p>{t("startup:description")}</p>
        </div>
        <button className="button button--secondary" type="button" disabled={loading} onClick={onRefresh}>
          <RefreshCw className={loading ? "is-spinning" : undefined} size={14} />
          {loading ? t("startup:scanning") : t("common:refresh")}
        </button>
      </header> : (
        <header className="startup-guided-header">
          <div><span className="eyebrow">{t("startup:guided.kicker")}</span><h2 id="startup-title">{t("startup:guided.title")}</h2><p>{t("startup:guided.description")}</p></div>
          <button className="button button--secondary" type="button" disabled={loading} onClick={onRefresh}><RefreshCw className={loading ? "is-spinning" : undefined} size={14} />{loading ? t("startup:scanning") : t("common:refresh")}</button>
        </header>
      )}

      {error ? (
        <div className="panel startup-error" role="alert"><AlertTriangle size={17} /><span>{error.message}</span></div>
      ) : null}

      {outcome ? (
        <div className="panel startup-outcome" role="status">
          <CheckCircle2 size={16} />
          <span>{t(outcome.enabled ? "startup:outcome.enabled" : "startup:outcome.disabled", { name: outcome.name })}</span>
          <button type="button" onClick={() => setOutcome(null)}>{t("common:close")}</button>
        </div>
      ) : null}

      {!snapshot && loading ? (
        <div className="panel startup-loading"><RefreshCw className="is-spinning" size={20} /><strong>{t("startup:loadingTitle")}</strong><span>{t("startup:loadingDescription")}</span></div>
      ) : snapshot ? (
        <>
          {variant === "professional" ? <section className="startup-summary" aria-label={t("startup:summary")}>
            <article className="panel is-review"><strong>{reviewCount}</strong><span>{t("startup:reviewCount")}</span><small>{t("startup:reviewHint")}</small></article>
            <article className="panel"><strong>{items.length - systemCount}</strong><span>{t("startup:thirdPartyCount")}</span><small>{t("startup:thirdPartyHint")}</small></article>
            <article className="panel is-system"><strong>{systemCount}</strong><span>{t("startup:systemCount")}</span><small>{t("startup:systemHint")}</small></article>
          </section> : (
            <section className={`startup-guided-summary${reviewCount > 0 ? " has-items" : ""}`}>
              {reviewCount > 0 ? <Rocket size={20} /> : <CheckCircle2 size={20} />}
              <div><strong>{reviewCount > 0 ? t("startup:guided.found", { count: reviewCount }) : t("startup:guided.clear")}</strong><span>{reviewCount > 0 ? t("startup:guided.foundDescription") : t("startup:guided.clearDescription")}</span></div>
            </section>
          )}

          <section className="panel startup-list" aria-labelledby="startup-list-title">
            {variant === "professional" ? <header>
              <div><span className="eyebrow">{t("startup:inventory")}</span><h3 id="startup-list-title">{t("startup:listTitle")}</h3></div>
              <span>{new Date(snapshot.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" })}</span>
            </header> : null}
            {variant === "professional" ? <div className="startup-toolbar">
              <div className="startup-filters" role="group" aria-label={t("startup:filters")}>
                {(["review", "all", "system"] as const).map((value) => (
                  <button type="button" className={filter === value ? "is-active" : ""} aria-pressed={filter === value} key={value} onClick={() => setFilter(value)}>{t(`startup:filter.${value}`)}</button>
                ))}
              </div>
              <label className="startup-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("startup:search")} /></label>
            </div> : null}
            {visible.length > 0 ? (
              <div className="startup-items">
                {visible.map((item) => (
                  <StartupItemRow
                    key={item.id}
                    item={item}
                    applications={applications}
                    totalMemoryBytes={totalMemoryBytes}
                    guided={variant === "guided"}
                    onManage={() => void openActionDialog(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="startup-empty"><CheckCircle2 size={20} /><strong>{t("startup:emptyTitle")}</strong><span>{t("startup:emptyDescription")}</span></div>
            )}
            <footer>
              <ShieldCheck size={14} />
              <span>{t(snapshot.managementAvailable ? "startup:managementBoundary" : "startup:readOnlyBoundary")}</span>
              {snapshot.unreadableLocationCount > 0 ? <em>{t("startup:unreadable", { count: snapshot.unreadableLocationCount })}</em> : null}
            </footer>
          </section>
        </>
      ) : null}
      {actionItem && action ? (
        <StartupActionDialog
          item={actionItem}
          action={action}
          lease={lease}
          preparing={preparing}
          submitting={submitting}
          error={actionError}
          onCancel={closeActionDialog}
          onConfirm={() => void confirmAction()}
        />
      ) : null}
    </section>
  );
}

function StartupItemRow({
  item,
  applications,
  totalMemoryBytes,
  guided,
  onManage,
}: {
  item: StartupItem;
  applications: readonly ApplicationImpact[];
  totalMemoryBytes: number;
  guided: boolean;
  onManage: () => void;
}) {
  const { t } = useAppTranslation();
  const advice = startupAdvice(item);
  const application = startupRuntimeApplication(item, applications);
  const impact = startupImpactLevel(item, application, totalMemoryBytes);
  return (
    <article className={`startup-item is-${advice}${guided ? " is-guided" : ""}`}>
      <span className="startup-item__icon" aria-hidden="true">
        {advice === "system" ? <ShieldCheck size={16} /> : advice === "disabled" ? <CircleOff size={16} /> : <Rocket size={16} />}
      </span>
      <div className="startup-item__identity">
        <strong>{item.name}</strong>
        <span>{item.publisher ?? t("startup:publisherUnknown")} · {t(`startup:source.${item.source}`)}</span>
      </div>
      <div className="startup-item__meaning">
        <strong>{t(`startup:advice.${advice}.title`)}</strong>
        <span>{t(`startup:advice.${advice}.description`)}</span>
      </div>
      <div className={`startup-item__impact is-${impact}`}>
        <strong>{t(`startup:impact.${impact}.title`)}</strong>
        <span>
          {application
            ? t("startup:impact.running", {
                cpu: formatPercent(application.cpuPercent),
                memory: formatBytes(application.memoryBytes),
              })
            : t("startup:impact.notMatched")}
        </span>
      </div>
      <div className="startup-item__controls">
        <span className={`startup-item__state is-${item.enabled ? "enabled" : "disabled"}`}><i />{t(item.enabled ? "startup:enabled" : "startup:disabled")}</span>
        {item.managementStatus === "available" ? (
          <button type="button" onClick={onManage}>
            {t(item.enabled ? "startup:actions.disable" : "startup:actions.enable")}
          </button>
        ) : (
          <small>{t(`startup:managementStatus.${item.managementStatus}`)}</small>
        )}
      </div>
      {!guided ? <details>
        <summary>{t("startup:technicalDetails")}</summary>
        <code title={item.command ?? item.path}>{item.command ?? item.path}</code>
      </details> : null}
    </article>
  );
}
