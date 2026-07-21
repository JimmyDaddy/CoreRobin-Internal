import {
  AlertTriangle,
  ArchiveRestore,
  AppWindow,
  Check,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  PackageX,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import "./ApplicationUninstallAssistant.css";

import {
  cancelCleanupDelete,
  createCleanupDeleteLease,
  executeCleanupDelete,
  getApplicationUninstallPlan,
  getInstalledApplications,
  releaseCleanupDeleteLease,
  revealPath,
} from "../api";
import type { CleanupMapNode } from "../cleanupMap";
import {
  applyRefreshedCleanupTargets,
  cleanupLeaseCanExecute,
} from "../cleanupDeleteFreshness";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { normalizeLanguage } from "../language";
import type {
  ApplicationArtifactKind,
  ApplicationInventorySnapshot,
  ApplicationUninstallArtifact,
  ApplicationUninstallPlan,
  CleanupDeleteLease,
  CleanupDeleteMode,
  CleanupDeleteProgress,
  CommandError,
  InstalledApplication,
} from "../types";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, normalizeCommandError } from "../utils";
import { CleanupDeleteDialog } from "./CleanupDeleteDialog";
import { ApplicationAvatar } from "./ApplicationAvatar";

interface ApplicationUninstallAssistantProps {
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}

interface UninstallOutcome {
  applicationName: string;
  deletedCount: number;
  deletedBytes: number;
  failedCount: number;
  cancelled: boolean;
  mode: CleanupDeleteMode;
  applicationRemoved: boolean;
}

interface RemovedApplicationState {
  mode: CleanupDeleteMode;
  failedCount: number;
}

const removedApplicationsForSession = new Map<string, RemovedApplicationState>();

export function ApplicationUninstallAssistant({
  onUserActionStart,
  onUserActionComplete,
}: ApplicationUninstallAssistantProps) {
  const { t, i18n } = useAppTranslation();
  const language = normalizeLanguage(i18n.resolvedLanguage);
  const [inventory, setInventory] = useState<ApplicationInventorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CommandError | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [plan, setPlan] = useState<ApplicationUninstallPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [selectedArtifacts, setSelectedArtifacts] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<UninstallOutcome | null>(null);
  const [removedApplications, setRemovedApplications] = useState<Map<string, RemovedApplicationState>>(
    () => new Map(removedApplicationsForSession),
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogItems, setDialogItems] = useState<CleanupMapNode[]>([]);
  const [deleteLease, setDeleteLease] = useState<CleanupDeleteLease | null>(null);
  const deleteLeaseRef = useRef<CleanupDeleteLease | null>(null);
  const [deleteMode, setDeleteMode] = useState<CleanupDeleteMode>("trash");
  const [deletePreparing, setDeletePreparing] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteCancelling, setDeleteCancelling] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<CleanupDeleteProgress | null>(null);
  const [deleteError, setDeleteError] = useState<CommandError | null>(null);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const deleteRequestIdRef = useRef(0);
  const latestEvidenceAtRef = useRef(0);
  const inventoryRequestIdRef = useRef(0);

  const refreshInventory = useCallback(async (forceRefresh = false) => {
    const requestId = inventoryRequestIdRef.current + 1;
    inventoryRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const next = await getInstalledApplications(language, forceRefresh);
      if (inventoryRequestIdRef.current !== requestId) return null;
      setInventory(next);
      if (forceRefresh) {
        removedApplicationsForSession.clear();
        setRemovedApplications(new Map());
      } else {
        const availablePaths = new Set(next.applications.map((application) => application.path));
        for (const path of removedApplicationsForSession.keys()) {
          if (!availablePaths.has(path)) removedApplicationsForSession.delete(path);
        }
        setRemovedApplications(new Map(removedApplicationsForSession));
      }
      setSelectedPath((current) => current && next.applications.some((app) => app.path === current) ? current : null);
      return next;
    } catch (caughtError) {
      if (inventoryRequestIdRef.current === requestId) {
        setError(normalizeCommandError(caughtError));
      }
      return null;
    } finally {
      if (inventoryRequestIdRef.current === requestId) setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    let disposed = false;
    void refreshInventory(false).then((next) => {
      if (!disposed && next?.refreshRecommended) void refreshInventory(true);
    });
    return () => {
      disposed = true;
    };
  }, [refreshInventory]);

  useEffect(() => () => {
    const lease = deleteLeaseRef.current;
    if (lease) void releaseCleanupDeleteLease({ leaseId: lease.id });
  }, []);

  const applications = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return inventory?.applications ?? [];
    return (inventory?.applications ?? []).filter((application) =>
      application.name.toLocaleLowerCase().includes(normalized)
      || application.bundleId?.toLocaleLowerCase().includes(normalized)
      || application.path.toLocaleLowerCase().includes(normalized));
  }, [inventory, query]);

  const totalSize = useMemo(
    () => (inventory?.applications ?? []).reduce(
      (sum, application) => sum + (removedApplications.has(application.path) ? 0 : application.sizeBytes),
      0,
    ),
    [inventory, removedApplications],
  );

  const installedApplicationCount = useMemo(
    () => (inventory?.applications ?? []).filter((application) => !removedApplications.has(application.path)).length,
    [inventory, removedApplications],
  );

  const selectedSize = useMemo(() => plan?.artifacts
    .filter((artifact) => selectedArtifacts.has(artifact.path))
    .reduce((sum, artifact) => sum + artifact.allocatedSizeBytes, 0) ?? 0,
  [plan, selectedArtifacts]);

  const selectApplication = async (application: InstalledApplication) => {
    if (removedApplications.has(application.path)) return;
    setSelectedPath(application.path);
    setPlan(null);
    setOutcome(null);
    if (!application.uninstallable) return;
    setPlanning(true);
    setError(null);
    try {
      const next = await getApplicationUninstallPlan(application.path, language);
      setPlan(next);
      setSelectedArtifacts(new Set(next.artifacts.map((artifact) => artifact.path)));
      latestEvidenceAtRef.current = next.sampledAtMs;
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError));
    } finally {
      setPlanning(false);
    }
  };

  const closeDeleteDialog = useCallback(() => {
    deleteRequestIdRef.current += 1;
    const lease = deleteLeaseRef.current;
    deleteLeaseRef.current = null;
    if (lease) void releaseCleanupDeleteLease({ leaseId: lease.id });
    setDialogOpen(false);
    setDialogItems([]);
    setDeleteLease(null);
    setDeletePreparing(false);
    setDeleteSubmitting(false);
    setDeleteCancelling(false);
    setDeleteProgress(null);
    setDeleteError(null);
    setDeleteAcknowledged(false);
  }, []);

  const prepareDeleteLease = async (
    items: readonly CleanupMapNode[],
    sampledAtMs: number,
    mode: CleanupDeleteMode,
  ) => {
    if (!plan?.application.bundleId) return;
    const requestId = deleteRequestIdRef.current + 1;
    deleteRequestIdRef.current = requestId;
    const previousLease = deleteLeaseRef.current;
    deleteLeaseRef.current = null;
    if (previousLease) void releaseCleanupDeleteLease({ leaseId: previousLease.id });
    setDeleteLease(null);
    setDeletePreparing(true);
    setDeleteError(null);
    setDeleteAcknowledged(false);
    try {
      const lease = await createCleanupDeleteLease({
        paths: items.flatMap((item) => item.path ? [item.path] : []),
        scanSampledAtMs: sampledAtMs,
        expectedTargets: items.flatMap((item) => item.path ? [{
          path: item.path,
          logicalSizeBytes: item.logicalSizeBytes,
          allocatedSizeBytes: item.allocatedSizeBytes,
          itemCount: item.itemCount,
        }] : []),
        mode,
        applicationUninstall: {
          applicationPath: plan.application.path,
          bundleId: plan.application.bundleId,
        },
      });
      if (deleteRequestIdRef.current !== requestId) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        return;
      }
      const refreshedItems = applyRefreshedCleanupTargets(items, lease.refreshedTargets);
      if (!refreshedItems) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        throw {
          code: "cleanup_refresh_incomplete",
          message: "CoreRobin could not match every refreshed uninstall target by path.",
        };
      }
      latestEvidenceAtRef.current = lease.refreshedAtMs;
      setDialogItems(refreshedItems);
      if (lease.executable) deleteLeaseRef.current = lease;
      setDeleteLease(lease);
    } catch (caughtError) {
      if (deleteRequestIdRef.current === requestId) {
        setDeleteError(normalizeCommandError(caughtError));
      }
    } finally {
      if (deleteRequestIdRef.current === requestId) setDeletePreparing(false);
    }
  };

  const openDeleteDialog = async () => {
    if (!plan?.application.bundleId) return;
    const items = plan.artifacts
      .filter((artifact) => selectedArtifacts.has(artifact.path))
      .map((artifact) => artifactToCleanupNode(artifact, t(`applications:uninstall.artifacts.${artifact.kind}`)));
    if (items.length === 0) return;
    setDeleteMode("trash");
    setDialogItems(items);
    setDialogOpen(true);
    setDeleteLease(null);
    deleteLeaseRef.current = null;
    setDeleteProgress(null);
    setDeleteError(null);
    setDeleteAcknowledged(false);
    await prepareDeleteLease(items, plan.sampledAtMs, "trash");
  };

  const confirmUninstall = async () => {
    const lease = deleteLeaseRef.current;
    if (!lease || !cleanupLeaseCanExecute(lease) || lease.mode !== deleteMode || !deleteAcknowledged || deleteSubmitting || !plan) return;
    const applicationName = plan.application.name;
    const applicationPath = plan.application.path;
    const completedMode = deleteMode;
    const actionRecordId = onUserActionStart?.({
      kind: "cleanup_delete",
      targetName: applicationName,
      targetCount: dialogItems.length,
    }) ?? null;
    setDeleteSubmitting(true);
    setDeleteCancelling(false);
    setDeleteError(null);
    setDeleteProgress({
      phase: "preparing",
      processedEntryCount: 0,
      totalEntryCount: 0,
      completedTargetCount: 0,
      totalTargetCount: dialogItems.length,
      currentPath: dialogItems[0]?.path ?? "",
      deletedBytes: 0,
    });
    try {
      const result = await executeCleanupDelete({ leaseId: lease.id }, setDeleteProgress);
      deleteLeaseRef.current = null;
      const applicationRemoved = result.deleted.some((item) => item.path === applicationPath);
      setOutcome({
        applicationName,
        deletedCount: result.deleted.length,
        deletedBytes: result.deletedBytes,
        failedCount: result.failed.length,
        cancelled: result.cancelled,
        mode: completedMode,
        applicationRemoved,
      });
      if (applicationRemoved) {
        removedApplicationsForSession.set(applicationPath, {
          mode: completedMode,
          failedCount: result.failed.length,
        });
        setRemovedApplications(new Map(removedApplicationsForSession));
      }
      if (actionRecordId) {
        onUserActionComplete?.(actionRecordId, {
          status: result.cancelled
            ? "cancelled"
            : result.failed.length > 0
              ? result.deleted.length > 0 ? "partial" : "failed"
              : "succeeded",
          verification: "verified",
          targetCount: dialogItems.length,
          affectedBytes: result.deletedBytes,
          failedCount: result.failed.length,
        });
      }
      closeDeleteDialog();
      setPlan(null);
      setSelectedPath(applicationRemoved ? applicationPath : null);
    } catch (caughtError) {
      deleteLeaseRef.current = null;
      setDeleteLease(null);
      setDeleteError(normalizeCommandError(caughtError));
      if (actionRecordId) {
        onUserActionComplete?.(actionRecordId, {
          status: "failed",
          verification: "not_confirmed",
          targetCount: dialogItems.length,
        });
      }
    } finally {
      setDeleteSubmitting(false);
      setDeleteCancelling(false);
    }
  };

  const cancelUninstall = async () => {
    if (!deleteSubmitting || deleteCancelling) return;
    setDeleteCancelling(true);
    try {
      const requested = await cancelCleanupDelete();
      if (!requested) setDeleteCancelling(false);
    } catch (caughtError) {
      setDeleteError(normalizeCommandError(caughtError));
      setDeleteCancelling(false);
    }
  };

  const changeDeleteMode = (mode: CleanupDeleteMode) => {
    setDeleteMode(mode);
    void prepareDeleteLease(dialogItems, latestEvidenceAtRef.current, mode);
  };

  const selectedApplication = inventory?.applications.find((application) => application.path === selectedPath) ?? null;
  const selectedRemoval = selectedPath ? removedApplications.get(selectedPath) ?? null : null;

  return (
    <section className="application-uninstall" aria-labelledby="application-uninstall-title" aria-busy={loading}>
      <header className="application-uninstall__hero">
        <span className="application-uninstall__hero-icon"><PackageX size={24} /></span>
        <div>
          <span className="eyebrow">{t("applications:uninstall.kicker")}</span>
          <h2 id="application-uninstall-title">{t("applications:uninstall.title")}</h2>
          <p>{t("applications:uninstall.description")}</p>
        </div>
        <button className="button button--secondary" type="button" disabled={loading} onClick={() => void refreshInventory(true)}>
          <RefreshCw className={loading ? "is-spinning" : undefined} size={15} />
          {t("applications:uninstall.refresh")}
        </button>
      </header>

      {loading && !inventory ? (
        <div className="application-uninstall__scan-stage" role="status" aria-live="polite">
          <div className="application-uninstall__scan-visual" aria-hidden="true">
            <i className="application-uninstall__scan-ring is-outer" />
            <i className="application-uninstall__scan-ring is-inner" />
            <span className="application-uninstall__scan-core"><ScanSearch size={27} /></span>
            <span className="application-uninstall__scan-node is-app"><AppWindow size={16} /></span>
            <span className="application-uninstall__scan-node is-size"><HardDrive size={16} /></span>
            <span className="application-uninstall__scan-node is-identity"><ShieldCheck size={16} /></span>
          </div>
          <div className="application-uninstall__scan-copy">
            <span className="eyebrow">{t("applications:uninstall.scanKicker")}</span>
            <strong>{t("applications:uninstall.scanning")}</strong>
            <p>{t("applications:uninstall.scanningHint")}</p>
            <span className="application-uninstall__scan-progress" aria-hidden="true"><i /></span>
            <small><ShieldCheck size={14} />{t("applications:uninstall.localOnly")}</small>
          </div>
          <div className="application-uninstall__scan-skeleton" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <span key={index} style={{ "--scan-delay": `${index * 140}ms` } as CSSProperties}>
                <i /><b /><em />
              </span>
            ))}
          </div>
        </div>
      ) : !inventory?.platformSupported ? (
        <div className="application-uninstall__unsupported">
          <AlertTriangle size={20} />
          <div><strong>{t("applications:uninstall.unsupportedTitle")}</strong><p>{t("applications:uninstall.unsupportedDescription")}</p></div>
        </div>
      ) : (
        <>
          <div className="application-uninstall__summary">
            <span><AppWindow size={16} /><strong>{installedApplicationCount}</strong>{t("applications:uninstall.applicationUnit")}</span>
            <span><HardDrive size={16} /><strong>{formatBytes(totalSize)}</strong>{t("applications:uninstall.installedSize")}</span>
            <small className={loading ? "is-refreshing" : undefined}>
              {loading ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}
              {loading
                ? t("applications:uninstall.scanning")
                : inventory?.cached
                  ? t("applications:uninstall.cachedInventory", {
                      time: new Date(inventory.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, {
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })
                  : t("applications:uninstall.localOnly")}
            </small>
          </div>

          {outcome ? (
            <div className={`application-uninstall__outcome${outcome.failedCount > 0 || outcome.cancelled ? " is-warning" : ""}`} role="status">
              <Check size={17} />
              <span>{t(outcome.failedCount > 0 || outcome.cancelled
                ? "applications:uninstall.outcomePartial"
                : outcome.applicationRemoved
                  ? outcome.mode === "trash"
                    ? "applications:uninstall.outcomeMovedToTrash"
                    : "applications:uninstall.outcomeDeletedPermanently"
                  : "applications:uninstall.outcomeComplete", {
                name: outcome.applicationName,
                count: outcome.deletedCount,
                size: formatBytes(outcome.deletedBytes),
              })}</span>
            </div>
          ) : null}

          {error ? <p className="application-uninstall__error" role="alert">{t(`applications:uninstall.errors.${error.code}`, { defaultValue: error.message })}</p> : null}

          <div className="application-uninstall__workspace">
            <div className="application-uninstall__catalog">
              <label className="application-uninstall__search">
                <Search size={15} />
                <span className="sr-only">{t("applications:uninstall.search")}</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("applications:uninstall.searchPlaceholder")} />
              </label>
              {applications.length === 0 ? (
                <p className="application-uninstall__empty">{t("applications:uninstall.empty")}</p>
              ) : (
                <ul className="application-uninstall__list">
                  {applications.map((application) => {
                    const removed = removedApplications.get(application.path);
                    const removedLabel = removed
                      ? t(`applications:uninstall.removed.${removed.mode}`)
                      : null;
                    return (
                    <li key={application.path}>
                      <button
                        className={`${selectedPath === application.path ? "is-selected" : ""}${removed ? " is-removed" : ""}`.trim() || undefined}
                        type="button"
                        disabled={Boolean(removed)}
                        aria-label={removedLabel ? `${application.name} · ${removedLabel}` : undefined}
                        onClick={() => void selectApplication(application)}
                      >
                        <ApplicationAvatar
                          name={application.name}
                          source={{ applicationPath: application.path }}
                          className="application-uninstall__avatar"
                        />
                        <div><strong>{application.name}</strong><small>{application.bundleId ?? application.path}</small></div>
                        {removed ? (
                          <b className={`application-uninstall__removed-badge is-${removed.mode}`}>
                            {removed.mode === "trash" ? <ArchiveRestore size={11} /> : <Trash2 size={11} />}
                            {removedLabel}
                          </b>
                        ) : <b>{formatBytes(application.sizeBytes)}</b>}
                        {removed ? (
                          <em className="is-removed">{t(`applications:uninstall.removed.${removed.mode}Description`)}</em>
                        ) : !application.uninstallable ? (
                          <em>{t(`applications:uninstall.unavailable.${application.unavailableReason}`, { defaultValue: t("applications:uninstall.unavailable.generic") })}</em>
                        ) : null}
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <aside className="application-uninstall__plan">
              {planning ? (
                <div className="application-uninstall__loading"><LoaderCircle className="is-spinning" size={18} />{t("applications:uninstall.preparingPlan")}</div>
              ) : plan ? (
                <>
                  <header>
                    <ApplicationAvatar
                      name={plan.application.name}
                      source={{ applicationPath: plan.application.path }}
                      className="application-uninstall__avatar is-large"
                    />
                    <div><span className="eyebrow">{t("applications:uninstall.planKicker")}</span><h3>{plan.application.name}</h3><code>{plan.application.path}</code></div>
                    <button className="icon-button" type="button" title={t("applications:uninstall.reveal")} aria-label={t("applications:uninstall.reveal")} onClick={() => void revealPath(plan.application.path)}><FolderOpen size={16} /></button>
                  </header>
                  <p className="application-uninstall__plan-note"><ShieldCheck size={15} />{t("applications:uninstall.planBoundary")}</p>
                  <fieldset className="application-uninstall__artifacts">
                    <legend>{t("applications:uninstall.foundItems")}</legend>
                    {plan.artifacts.map((artifact) => {
                      const checked = selectedArtifacts.has(artifact.path);
                      return (
                        <label key={artifact.path}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={artifact.required}
                            onChange={() => setSelectedArtifacts((current) => {
                              const next = new Set(current);
                              if (checked) next.delete(artifact.path);
                              else next.add(artifact.path);
                              return next;
                            })}
                          />
                          <span><strong>{t(`applications:uninstall.artifacts.${artifact.kind}`)}</strong><code>{artifact.path}</code></span>
                          <b>{formatBytes(artifact.allocatedSizeBytes)}</b>
                          {artifact.required ? <em>{t("applications:uninstall.required")}</em> : null}
                        </label>
                      );
                    })}
                  </fieldset>
                  {plan.skippedPaths.length > 0 ? (
                    <details className="application-uninstall__skipped">
                      <summary><AlertTriangle size={14} />{t("applications:uninstall.skipped", { count: plan.skippedPaths.length })}</summary>
                      <p>{t("applications:uninstall.skippedDescription")}</p>
                      {plan.skippedPaths.map((path) => <code key={path}>{path}</code>)}
                    </details>
                  ) : null}
                  <footer>
                    <div><strong>{formatBytes(selectedSize)}</strong><small>{t("applications:uninstall.selectedSize", { count: selectedArtifacts.size })}</small></div>
                    <button className="button button--danger" type="button" onClick={() => void openDeleteDialog()}>
                      <PackageX size={15} />{t("applications:uninstall.review", { name: plan.application.name })}
                    </button>
                  </footer>
                </>
              ) : selectedApplication && selectedRemoval ? (
                <div className={`application-uninstall__removed-panel is-${selectedRemoval.mode}`} role="status">
                  <div className="application-uninstall__removed-visual" aria-hidden="true">
                    <i /><i /><i />
                    <ApplicationAvatar
                      name={selectedApplication.name}
                      source={{ applicationPath: selectedApplication.path }}
                      className="application-uninstall__avatar is-large"
                    />
                    <span>{selectedRemoval.mode === "trash" ? <ArchiveRestore size={22} /> : <Trash2 size={22} />}</span>
                  </div>
                  <strong>{selectedApplication.name}</strong>
                  <em>{t(`applications:uninstall.removed.${selectedRemoval.mode}`)}</em>
                  <p>{t(`applications:uninstall.removed.${selectedRemoval.mode}Description`)}</p>
                  {selectedRemoval.failedCount > 0 ? <small>{t("applications:uninstall.removed.partial")}</small> : null}
                  <button className="button button--secondary" type="button" disabled={loading} onClick={() => void refreshInventory(true)}>
                    <RefreshCw className={loading ? "is-spinning" : undefined} size={14} />
                    {t("applications:uninstall.refresh")}
                  </button>
                </div>
              ) : selectedApplication && !selectedApplication.uninstallable ? (
                <div className="application-uninstall__selection-empty"><AlertTriangle size={22} /><strong>{t("applications:uninstall.cannotPrepare")}</strong><p>{t(`applications:uninstall.unavailable.${selectedApplication.unavailableReason}`, { defaultValue: t("applications:uninstall.unavailable.generic") })}</p></div>
              ) : (
                <div className="application-uninstall__selection-empty"><PackageX size={24} /><strong>{t("applications:uninstall.selectTitle")}</strong><p>{t("applications:uninstall.selectDescription")}</p></div>
              )}
            </aside>
          </div>
        </>
      )}

      {dialogOpen ? (
        <CleanupDeleteDialog
          title={t("applications:uninstall.dialogTitle", { name: plan?.application.name ?? "" })}
          description={t("applications:uninstall.dialogDescription")}
          items={dialogItems}
          lease={deleteLease}
          preparing={deletePreparing}
          submitting={deleteSubmitting}
          cancelling={deleteCancelling}
          progress={deleteProgress}
          error={deleteError}
          mode={deleteMode}
          deleteAcknowledged={deleteAcknowledged}
          onModeChange={changeDeleteMode}
          onDeleteAcknowledgedChange={setDeleteAcknowledged}
          onCancel={closeDeleteDialog}
          onCancelExecution={() => void cancelUninstall()}
          onRefresh={() => void prepareDeleteLease(dialogItems, latestEvidenceAtRef.current, deleteMode)}
          onConfirm={() => void confirmUninstall()}
          progressVariant="application"
        />
      ) : null}
    </section>
  );
}

function artifactToCleanupNode(artifact: ApplicationUninstallArtifact, name: string): CleanupMapNode {
  return {
    id: `application-uninstall:${artifact.path}`,
    name,
    path: artifact.path,
    sizeBytes: artifact.allocatedSizeBytes,
    logicalSizeBytes: artifact.logicalSizeBytes,
    allocatedSizeBytes: artifact.allocatedSizeBytes,
    itemCount: artifact.itemCount,
    safety: "review",
    kind: artifact.itemCount > 1 ? "folder" : "file",
    deletionProtected: false,
    protectionReason: null,
    hasChildren: artifact.itemCount > 1,
    children: [],
  };
}


export const APPLICATION_ARTIFACT_KINDS = [
  "application",
  "application_support",
  "cache",
  "preferences",
  "saved_state",
  "container",
  "web_data",
  "http_storage",
  "cookies",
  "logs",
  "launch_agent",
] as const satisfies readonly ApplicationArtifactKind[];
