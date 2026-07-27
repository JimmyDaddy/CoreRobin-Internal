import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { startupApplicationIconSource } from "../applicationIcon";

import {
  createStartupManagementLease,
  executeStartupManagement,
  releaseStartupManagementLease,
} from "../api";
import type { ApplicationImpact } from "../diagnosis";
import type { StartupImpactMeasurement } from "../startupImpact";
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
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, formatPercent, normalizeCommandError } from "../utils";
import { StartupActionDialog } from "./StartupActionDialog";
import { ApplicationAvatar } from "./ApplicationAvatar";

interface StartupExplorerProps {
  variant?: "professional" | "guided";
  snapshot: StartupItemsSnapshot | null;
  error: CommandError | null;
  loading: boolean;
  applications: readonly ApplicationImpact[];
  totalMemoryBytes: number;
  impactMeasurements?: readonly StartupImpactMeasurement[];
  onRefresh: () => void | Promise<void>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}

export function StartupExplorer({
  variant = "professional",
  snapshot,
  error,
  loading,
  applications,
  totalMemoryBytes,
  impactMeasurements = [],
  onRefresh,
  onUserActionStart,
  onUserActionComplete,
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
    const actionRecordId = onUserActionStart?.({
      kind: action === "enable" ? "startup_enable" : "startup_disable",
      targetName: actionItem.name,
      targetCount: 1,
    }) ?? null;
    let actionRecorded = false;
    setSubmitting(true);
    setActionError(null);
    try {
      const result = await executeStartupManagement({ leaseId: lease.id });
      leaseRef.current = null;
      if (actionRecordId) {
        onUserActionComplete?.(actionRecordId, {
          status: "succeeded",
          verification: "verified",
          targetCount: 1,
        });
        actionRecorded = true;
      }
      setOutcome({ name: actionItem.name, enabled: result.enabled });
      requestIdRef.current += 1;
      setActionItem(null);
      setAction(null);
      setLease(null);
      await onRefresh();
    } catch (caughtError) {
      if (actionRecordId && !actionRecorded) {
        onUserActionComplete?.(actionRecordId, {
          status: "failed",
          verification: "not_confirmed",
          targetCount: 1,
        });
      }
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
        <div className="panel startup-error" role="alert">
          <AlertTriangle size={17} />
          <span>{error.message}</span>
          <button className="button button--secondary" type="button" onClick={onRefresh}>
            <RefreshCw size={14} />{t("common:retry")}
          </button>
        </div>
      ) : null}

      {outcome ? (
        <div className="panel startup-outcome" role="status">
          <CheckCircle2 size={16} />
          <span>{t(outcome.enabled ? "startup:outcome.enabled" : "startup:outcome.disabled", { name: outcome.name })}</span>
          <button type="button" onClick={() => setOutcome(null)}>{t("common:close")}</button>
        </div>
      ) : null}

      {variant === "professional" ? (
        <StartupImpactPanel measurements={impactMeasurements} applications={applications} />
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

function StartupImpactPanel({
  measurements,
  applications,
}: {
  measurements: readonly StartupImpactMeasurement[];
  applications: readonly ApplicationImpact[];
}) {
  const { t, i18n } = useAppTranslation();
  const latest = measurements[0];
  const runtimeApplications = new Map(
    applications.map((application) => [application.name.toLocaleLowerCase(), application]),
  );
  return (
    <section className="panel startup-impact" aria-labelledby="startup-impact-title">
      <header>
        <div><span className="eyebrow">{t("startup:impact.eyebrow")}</span><h3 id="startup-impact-title">{t("startup:impact.title")}</h3><p>{t("startup:impact.description")}</p></div>
        {latest ? <time>{new Date(latest.launchedAtMs).toLocaleString(i18n.resolvedLanguage)}</time> : null}
      </header>
      {latest ? (
        <>
          <div className="startup-impact__summary">
            <span><strong>{latest.settledAfterMs === null ? "—" : `${Math.ceil(latest.settledAfterMs / 1_000)}s`}</strong>{t("startup:impact.settleTime")}</span>
            <span><strong>{formatPercent(latest.peakCpuPercent)}</strong>{t("startup:impact.peakCpu")}</span>
            <span><strong>{formatBytes(latest.peakDiskBytesPerSecond)}/s</strong>{t("startup:impact.peakDisk")}</span>
            <span><strong>{latest.sampleCount}</strong>{t("startup:impact.samples")}</span>
          </div>
          {latest.applications.length > 0 ? <ol className="startup-impact__apps">{latest.applications.map((application) => {
            const runtimeApplication = runtimeApplications.get(application.name.toLocaleLowerCase());
            return (
              <li key={application.name}>
                <ApplicationAvatar
                  name={application.name}
                  source={runtimeApplication ? { process: runtimeApplication.iconProcess } : null}
                  className="startup-impact-avatar"
                />
                <strong>{application.name}</strong>
                <span>{formatPercent(application.peakCpuPercent)}</span>
                <small>{formatBytes(application.peakMemoryBytes)}</small>
              </li>
            );
          })}</ol> : null}
          <small>{t("startup:impact.boundary")}</small>
        </>
      ) : <div className="startup-impact__empty"><Rocket size={20} /><p>{t("startup:impact.empty")}</p></div>}
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
  const iconSource = application
    ? { process: application.iconProcess } as const
    : startupApplicationIconSource(item);
  return (
    <article className={`startup-item is-${advice}${guided ? " is-guided" : ""}`}>
      <ApplicationAvatar
        name={item.name}
        source={iconSource}
        className="startup-item__avatar"
      />
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
