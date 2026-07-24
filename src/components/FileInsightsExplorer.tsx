import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock3,
  Copy,
  FileArchive,
  FileCheck2,
  Files,
  Fingerprint,
  FolderSearch,
  Hash,
  Radio,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  cancelCleanupDelete,
  createCleanupDeleteLease,
  executeCleanupDelete,
  releaseCleanupDeleteLease,
  setCleanupDeleteLeaseMode,
} from "../api";
import {
  applyRefreshedCleanupTargets,
  buildCleanupDeleteLeaseRequest,
  cleanupLeaseCanExecute,
} from "../cleanupDeleteFreshness";
import type { CleanupMapNode } from "../cleanupMap";
import type { CleanupDeletionTargetSnapshot } from "../cleanupScanStore";
import type { FileInsightsSnapshotStatus } from "../fileInsightsStore";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type {
  CleanupDeleteFailure,
  CleanupDeleteLease,
  CleanupDeleteMode,
  CleanupDeleteProgress,
  CommandError,
  DuplicateFileGroup,
  FileInsightFile,
  FileInsightsProgress,
  FileInsightsScan,
} from "../types";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, normalizeCommandError } from "../utils";
import { CleanupDeleteDialog } from "./CleanupDeleteDialog";
import { PathActions } from "./PathActions";
import "./FileInsightsExplorer.css";

interface FileInsightsLauncherProps {
  scan: FileInsightsScan | null;
  snapshotStatus?: FileInsightsSnapshotStatus;
  loading: boolean;
  onOpen: () => void;
}

interface FileInsightsExplorerProps {
  scan: FileInsightsScan | null;
  snapshotStatus?: FileInsightsSnapshotStatus;
  progress: FileInsightsProgress | null;
  loading: boolean;
  error: string | null;
  onRun: () => void;
  onCancel: () => void;
  onBack: () => void;
  onFilesRemoved?: (paths: readonly string[]) => void;
  onDeletionApplied?: (
    targets: readonly CleanupDeletionTargetSnapshot[],
    invalidateSnapshot?: boolean,
  ) => Promise<void>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}

interface DuplicateProcessingOutcome {
  deletedCount: number;
  deletedBytes: number;
  failed: CleanupDeleteFailure[];
  cancelled: boolean;
}

type ResultView = "duplicates" | "old";
const DUPLICATE_GROUP_SCROLL_THRESHOLD = 5;

export function FileInsightsLauncher({
  scan,
  snapshotStatus = "current",
  loading,
  onOpen,
}: FileInsightsLauncherProps) {
  const { t } = useAppTranslation();
  const reclaimableBytes = scan?.duplicateGroups.reduce(
    (total, group) => total + group.reclaimableBytes,
    0,
  ) ?? 0;

  return (
    <button className="file-insights-launcher" type="button" onClick={onOpen}>
      <span className="file-insights-launcher__visual" aria-hidden="true">
        <i /><i />
        <Files size={19} />
      </span>
      <span className="file-insights-launcher__copy">
        <small>{t("cleanup:fileInsights.workspaceKicker")}</small>
        <strong>{t("cleanup:fileInsights.title")}</strong>
        <span>{t("cleanup:fileInsights.launcherDescription")}</span>
      </span>
      {loading ? (
        <span className="file-insights-launcher__status is-running">
          <ScanSearch size={14} />{t("cleanup:fileInsights.running")}
        </span>
      ) : scan ? (
        <span className="file-insights-launcher__status is-ready">
          <strong>{formatBytes(reclaimableBytes)}</strong>
          <small>{fileInsightsFreshnessLabel(snapshotStatus, t)} · {t("cleanup:fileInsights.possibleSavings")}</small>
        </span>
      ) : (
        <span className="file-insights-launcher__status">
          {t("cleanup:fileInsights.openWorkspace")}<ArrowLeft size={14} />
        </span>
      )}
    </button>
  );
}

export function FileInsightsExplorer({
  scan,
  snapshotStatus = "current",
  progress,
  loading,
  error,
  onRun,
  onCancel,
  onBack,
  onFilesRemoved,
  onDeletionApplied,
  onUserActionStart,
  onUserActionComplete,
}: FileInsightsExplorerProps) {
  const { t } = useAppTranslation();
  const [resultView, setResultView] = useState<ResultView>("duplicates");
  const [selectedGroupDigests, setSelectedGroupDigests] = useState<Set<string>>(() => new Set());
  const [keptPathByDigest, setKeptPathByDigest] = useState<Map<string, string>>(() => new Map());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteDialogItems, setDeleteDialogItems] = useState<CleanupMapNode[]>([]);
  const [deleteLease, setDeleteLease] = useState<CleanupDeleteLease | null>(null);
  const [deletePreparing, setDeletePreparing] = useState(false);
  const [deleteModeSwitching, setDeleteModeSwitching] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteCancelling, setDeleteCancelling] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<CleanupDeleteProgress | null>(null);
  const [deleteError, setDeleteError] = useState<CommandError | null>(null);
  const [deleteMode, setDeleteMode] = useState<CleanupDeleteMode>("trash");
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [processingOutcome, setProcessingOutcome] = useState<DuplicateProcessingOutcome | null>(null);
  const deleteLeaseRef = useRef<CleanupDeleteLease | null>(null);
  const deleteRequestIdRef = useRef(0);
  const reclaimableBytes = scan?.duplicateGroups.reduce(
    (total, group) => total + group.reclaimableBytes,
    0,
  ) ?? 0;
  const selectedDuplicateFiles = useMemo(() => scan?.duplicateGroups.flatMap((group) => {
    if (!selectedGroupDigests.has(group.digest)) return [];
    const keptPath = keptPathByDigest.get(group.digest) ?? group.files[0]?.path;
    return group.files.filter((file) => file.path !== keptPath);
  }) ?? [], [keptPathByDigest, scan, selectedGroupDigests]);
  const selectedDuplicateBytes = selectedDuplicateFiles.reduce(
    (total, file) => total + file.allocatedSizeBytes,
    0,
  );

  useEffect(() => {
    if (scan && scan.duplicateGroups.length === 0 && scan.longUnmodifiedFiles.length > 0) {
      setResultView("old");
    }
  }, [scan]);

  useEffect(() => {
    setSelectedGroupDigests(new Set());
    setKeptPathByDigest(new Map(
      scan?.duplicateGroups.flatMap((group) => group.files[0]
        ? [[group.digest, group.files[0].path] as const]
        : []) ?? [],
    ));
    setProcessingOutcome(null);
  }, [scan?.sampledAtMs]);

  useEffect(() => () => {
    deleteRequestIdRef.current += 1;
    const lease = deleteLeaseRef.current;
    if (lease) void releaseCleanupDeleteLease({ leaseId: lease.id });
  }, []);

  const closeDeleteDialog = useCallback(() => {
    deleteRequestIdRef.current += 1;
    const lease = deleteLeaseRef.current;
    deleteLeaseRef.current = null;
    if (lease) void releaseCleanupDeleteLease({ leaseId: lease.id });
    setDeleteDialogOpen(false);
    setDeleteDialogItems([]);
    setDeleteLease(null);
    setDeletePreparing(false);
    setDeleteModeSwitching(false);
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
    const requestId = deleteRequestIdRef.current + 1;
    deleteRequestIdRef.current = requestId;
    const previousLease = deleteLeaseRef.current;
    deleteLeaseRef.current = null;
    if (previousLease) void releaseCleanupDeleteLease({ leaseId: previousLease.id });
    setDeleteLease(null);
    setDeletePreparing(true);
    setDeleteModeSwitching(false);
    setDeleteError(null);
    setDeleteAcknowledged(false);
    try {
      const lease = await createCleanupDeleteLease(
        buildCleanupDeleteLeaseRequest(items, sampledAtMs, mode),
      );
      if (deleteRequestIdRef.current !== requestId) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        return;
      }
      const refreshedItems = applyRefreshedCleanupTargets(items, lease.refreshedTargets);
      if (!refreshedItems) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        throw {
          code: "cleanup_refresh_incomplete",
          message: "CoreRobin could not match every refreshed duplicate file by path.",
        };
      }
      setDeleteDialogItems(refreshedItems);
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

  const changeDeleteMode = async (mode: CleanupDeleteMode) => {
    if (mode === deleteMode || deleteSubmitting || deleteModeSwitching) return;
    const previousMode = deleteMode;
    const lease = deleteLeaseRef.current;
    setDeleteMode(mode);
    setDeleteAcknowledged(false);
    setDeleteError(null);
    if (!lease || !cleanupLeaseCanExecute(lease)) return;

    const requestId = deleteRequestIdRef.current + 1;
    deleteRequestIdRef.current = requestId;
    setDeleteModeSwitching(true);
    try {
      const updatedLease = await setCleanupDeleteLeaseMode({ leaseId: lease.id, mode });
      if (deleteRequestIdRef.current !== requestId) return;
      deleteLeaseRef.current = updatedLease;
      setDeleteLease(updatedLease);
    } catch (caughtError) {
      if (deleteRequestIdRef.current === requestId) {
        setDeleteMode(previousMode);
        setDeleteError(normalizeCommandError(caughtError));
      }
    } finally {
      if (deleteRequestIdRef.current === requestId) setDeleteModeSwitching(false);
    }
  };

  const openProcessingDialog = async () => {
    if (!scan || selectedDuplicateFiles.length === 0) return;
    const items = selectedDuplicateFiles.map(fileInsightToCleanupNode);
    setDeleteMode("trash");
    setDeleteDialogItems(items);
    setDeleteDialogOpen(true);
    setDeleteLease(null);
    deleteLeaseRef.current = null;
    setDeletePreparing(false);
    setDeleteModeSwitching(false);
    setDeleteSubmitting(false);
    setDeleteCancelling(false);
    setDeleteProgress(null);
    setDeleteError(null);
    setDeleteAcknowledged(false);
    setProcessingOutcome(null);
    await prepareDeleteLease(items, scan.sampledAtMs, "trash");
  };

  const confirmProcessing = async () => {
    const lease = deleteLeaseRef.current;
    if (!lease || lease.mode !== deleteMode || !cleanupLeaseCanExecute(lease) || !deleteAcknowledged || deleteSubmitting || deleteModeSwitching) return;
    const actionRecordId = onUserActionStart?.({
      kind: "cleanup_delete",
      targetName: t("cleanup:fileInsights.processing.actionName"),
      targetCount: deleteDialogItems.length,
    }) ?? null;
    let actionRecorded = false;
    setDeleteSubmitting(true);
    setDeleteCancelling(false);
    setDeleteProgress({
      phase: "preparing",
      processedEntryCount: 0,
      totalEntryCount: 0,
      completedTargetCount: 0,
      totalTargetCount: deleteDialogItems.length,
      currentPath: deleteDialogItems[0]?.path ?? "",
      deletedBytes: 0,
    });
    setDeleteError(null);
    try {
      const result = await executeCleanupDelete({ leaseId: lease.id }, setDeleteProgress);
      deleteLeaseRef.current = null;
      setDeleteLease(null);
      const deletedByPath = new Map(result.deleted.map((item) => [item.path, item.deletedBytes]));
      const deletedPaths = new Set(deletedByPath.keys());
      const deletedItems = deleteDialogItems.filter(
        (item): item is CleanupMapNode & { path: string } => item.path !== null && deletedPaths.has(item.path),
      );
      const deletionTargets = deletedItems.map<CleanupDeletionTargetSnapshot>((item) => ({
        path: item.path,
        logicalSizeBytes: item.logicalSizeBytes,
        allocatedSizeBytes: deletedByPath.get(item.path) ?? item.allocatedSizeBytes,
        itemCount: item.itemCount,
      }));
      const uncertainPaths = new Set([
        ...(result.interruptedPath ? [result.interruptedPath] : []),
        ...result.failed.map((failure) => failure.path),
      ]);
      setProcessingOutcome({
        deletedCount: result.deleted.length,
        deletedBytes: result.deletedBytes,
        failed: result.failed,
        cancelled: result.cancelled,
      });
      if (actionRecordId) {
        onUserActionComplete?.(actionRecordId, {
          status: result.cancelled
            ? "cancelled"
            : result.failed.length > 0
              ? result.deleted.length > 0 ? "partial" : "failed"
              : "succeeded",
          verification: "verified",
          targetCount: deleteDialogItems.length,
          affectedBytes: result.deletedBytes,
          failedCount: result.failed.length,
        });
        actionRecorded = true;
      }
      onFilesRemoved?.([...deletedPaths]);
      await onDeletionApplied?.(deletionTargets, uncertainPaths.size > 0);
      closeDeleteDialog();
    } catch (caughtError) {
      if (actionRecordId && !actionRecorded) {
        onUserActionComplete?.(actionRecordId, {
          status: "failed",
          verification: "not_confirmed",
          targetCount: deleteDialogItems.length,
        });
      }
      deleteLeaseRef.current = null;
      setDeleteLease(null);
      setDeleteError(normalizeCommandError(caughtError));
    } finally {
      setDeleteSubmitting(false);
      setDeleteCancelling(false);
    }
  };

  const cancelProcessing = async () => {
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

  const toggleGroup = (digest: string) => {
    setProcessingOutcome(null);
    setSelectedGroupDigests((current) => {
      const next = new Set(current);
      if (next.has(digest)) next.delete(digest);
      else next.add(digest);
      return next;
    });
  };

  const keepFile = (digest: string, path: string) => {
    setProcessingOutcome(null);
    setKeptPathByDigest((current) => new Map(current).set(digest, path));
  };

  return (
    <section className="panel file-insights-page" aria-labelledby="file-insights-page-title">
      <header className="file-insights-page__header">
        <button className="file-insights-page__back" type="button" onClick={onBack}>
          <ArrowLeft size={15} />{t("cleanup:fileInsights.back")}
        </button>
        <span className="file-insights-page__icon" aria-hidden="true"><Fingerprint size={20} /></span>
        <div>
          <span className="eyebrow">{t("cleanup:fileInsights.workspaceKicker")}</span>
          <h2 id="file-insights-page-title">{t("cleanup:fileInsights.title")}</h2>
          <p>{t("cleanup:fileInsights.description")}</p>
        </div>
        <button
          className={`button ${loading ? "button--secondary" : "button--primary"} file-insights-page__action`}
          type="button"
          onClick={loading ? onCancel : onRun}
        >
          {loading ? <Square size={13} /> : <ScanSearch size={15} />}
          {loading
            ? t("cleanup:fileInsights.cancel")
            : scan
              ? t("cleanup:fileInsights.scanAgain")
              : t("cleanup:fileInsights.scan")}
        </button>
      </header>

      {error ? (
        <div className="file-insights-page__notice is-error" role="alert">
          <AlertTriangle size={16} /><span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <FileInsightsLoading progress={progress} />
      ) : scan ? (
        <FileInsightsResults
          scan={scan}
          snapshotStatus={snapshotStatus}
          reclaimableBytes={reclaimableBytes}
          resultView={resultView}
          onResultViewChange={setResultView}
          selectedGroupDigests={selectedGroupDigests}
          keptPathByDigest={keptPathByDigest}
          selectedDuplicateCount={selectedDuplicateFiles.length}
          selectedDuplicateBytes={selectedDuplicateBytes}
          processingOutcome={processingOutcome}
          onToggleGroup={toggleGroup}
          onKeepFile={keepFile}
          onOpenProcessing={() => void openProcessingDialog()}
        />
      ) : (
        <div className="file-insights-welcome">
          <div className="file-insights-welcome__copy">
            <span className="file-insights-welcome__badge"><ShieldCheck size={14} />{t("cleanup:fileInsights.localOnly")}</span>
            <h3>{t("cleanup:fileInsights.welcomeTitle")}</h3>
            <p>{t("cleanup:fileInsights.welcomeDescription")}</p>
            <button className="button button--primary" type="button" onClick={onRun}>
              <ScanSearch size={16} />{t("cleanup:fileInsights.scan")}
            </button>
            <small>{t("cleanup:fileInsights.empty")}</small>
          </div>
          <div className="file-insights-welcome__visual" aria-hidden="true">
            <span className="file-insights-welcome__glow" />
            <span className="file-insights-welcome__sheet is-back"><FileArchive size={18} /></span>
            <span className="file-insights-welcome__sheet is-middle"><Copy size={19} /></span>
            <span className="file-insights-welcome__sheet is-front"><Fingerprint size={24} /></span>
            <span className="file-insights-welcome__scan-line" />
            <i className="is-one" /><i className="is-two" /><i className="is-three" />
          </div>
          <div className="file-insights-welcome__scope">
            <span><FolderSearch size={14} />{t("cleanup:fileInsights.scopeTitle")}</span>
            <div>
              {(["desktop", "documents", "downloads", "movies", "music", "pictures"] as const).map((location) => (
                <small key={location}>{t(`cleanup:fileInsights.scope.${location}`)}</small>
              ))}
            </div>
          </div>
          <div className="file-insights-welcome__steps">
            <span><b>01</b><strong>{t("cleanup:fileInsights.steps.filterTitle")}</strong><small>{t("cleanup:fileInsights.steps.filterDescription")}</small></span>
            <span><b>02</b><strong>{t("cleanup:fileInsights.steps.hashTitle")}</strong><small>{t("cleanup:fileInsights.steps.hashDescription")}</small></span>
            <span><b>03</b><strong>{t("cleanup:fileInsights.steps.reviewTitle")}</strong><small>{t("cleanup:fileInsights.steps.reviewDescription")}</small></span>
          </div>
        </div>
      )}
      {deleteDialogOpen ? (
        <CleanupDeleteDialog
          title={t("cleanup:fileInsights.processing.dialogTitle")}
          description={t("cleanup:fileInsights.processing.dialogDescription")}
          items={deleteDialogItems}
          lease={deleteLease}
          preparing={deletePreparing}
          modeSwitching={deleteModeSwitching}
          submitting={deleteSubmitting}
          cancelling={deleteCancelling}
          progress={deleteProgress}
          error={deleteError}
          mode={deleteMode}
          deleteAcknowledged={deleteAcknowledged}
          onModeChange={(mode) => void changeDeleteMode(mode)}
          onDeleteAcknowledgedChange={setDeleteAcknowledged}
          onCancel={closeDeleteDialog}
          onCancelExecution={() => void cancelProcessing()}
          onRefresh={() => {
            if (deleteLease) void prepareDeleteLease(deleteDialogItems, deleteLease.refreshedAtMs, deleteMode);
          }}
          onConfirm={() => void confirmProcessing()}
        />
      ) : null}
    </section>
  );
}

function FileInsightsLoading({ progress }: { progress: FileInsightsProgress | null }) {
  const { t, i18n } = useAppTranslation();
  const phase = progress?.phase ?? "discovering";
  const scanned = progress?.scannedEntryCount ?? 0;
  const candidates = progress?.candidateFileCount ?? 0;
  const hashed = progress?.hashedFileCount ?? 0;

  return (
    <div className="file-insights-loading" role="status" aria-live="polite">
      <div className="file-insights-scanner" aria-hidden="true">
        <span className="file-insights-scanner__halo" />
        <span className="file-insights-scanner__ring is-outer" />
        <span className="file-insights-scanner__ring is-inner" />
        <span className="file-insights-scanner__sweep" />
        <span className="file-insights-scanner__file is-one"><FileArchive size={16} /></span>
        <span className="file-insights-scanner__file is-two"><Copy size={15} /></span>
        <span className="file-insights-scanner__file is-three"><FileCheck2 size={15} /></span>
        <span className="file-insights-scanner__center"><Fingerprint size={27} /><i /></span>
      </div>

      <div className="file-insights-loading__story">
        <span className="file-insights-loading__eyebrow"><Sparkles size={13} />{t("cleanup:fileInsights.loadingKicker")}</span>
        <h3>{t(`cleanup:fileInsights.phase.${phase}`)}</h3>
        <p>{t(`cleanup:fileInsights.phaseDescription.${phase}`)}</p>
        <div className="file-insights-loading__phases" aria-label={t("cleanup:fileInsights.phaseLabel")}>
          <span className="is-complete"><CheckCircle2 size={13} />{t("cleanup:fileInsights.phase.discovering")}</span>
          <i />
          <span className={phase === "hashing" ? "is-active" : undefined}><Hash size={13} />{t("cleanup:fileInsights.phase.hashing")}</span>
        </div>
        {progress?.currentPath ? (
          <code title={progress.currentPath}>{progress.currentPath}</code>
        ) : null}
      </div>

      <dl className="file-insights-loading__metrics">
        <div><dt>{t("cleanup:fileInsights.metrics.scanned")}</dt><dd>{scanned.toLocaleString(i18n.resolvedLanguage)}</dd></div>
        <div><dt>{t("cleanup:fileInsights.metrics.candidates")}</dt><dd>{candidates.toLocaleString(i18n.resolvedLanguage)}</dd></div>
        <div><dt>{t("cleanup:fileInsights.metrics.hashed")}</dt><dd>{hashed.toLocaleString(i18n.resolvedLanguage)}</dd></div>
      </dl>
      <small className="file-insights-loading__privacy"><ShieldCheck size={13} />{t("cleanup:fileInsights.loadingPrivacy")}</small>
    </div>
  );
}

interface FileInsightsResultsProps {
  scan: FileInsightsScan;
  snapshotStatus: FileInsightsSnapshotStatus;
  reclaimableBytes: number;
  resultView: ResultView;
  onResultViewChange: (view: ResultView) => void;
  selectedGroupDigests: ReadonlySet<string>;
  keptPathByDigest: ReadonlyMap<string, string>;
  selectedDuplicateCount: number;
  selectedDuplicateBytes: number;
  processingOutcome: DuplicateProcessingOutcome | null;
  onToggleGroup: (digest: string) => void;
  onKeepFile: (digest: string, path: string) => void;
  onOpenProcessing: () => void;
}

function FileInsightsResults({
  scan,
  snapshotStatus,
  reclaimableBytes,
  resultView,
  onResultViewChange,
  selectedGroupDigests,
  keptPathByDigest,
  selectedDuplicateCount,
  selectedDuplicateBytes,
  processingOutcome,
  onToggleGroup,
  onKeepFile,
  onOpenProcessing,
}: FileInsightsResultsProps) {
  const { t, i18n } = useAppTranslation();

  return (
    <div className="file-insights-results">
      <section className="file-insights-results__hero">
        <div className="file-insights-results__complete">
          <span><CheckCircle2 size={17} /></span>
          <div>
            <small>{t("cleanup:fileInsights.completeKicker")}</small>
            <h3>{t("cleanup:fileInsights.completeTitle")}</h3>
            <span className={`file-insights-results__freshness is-${snapshotStatus}`}>
              {snapshotStatus === "current" ? <Radio size={11} /> : <Clock3 size={11} />}
              {fileInsightsFreshnessLabel(snapshotStatus, t)}
              <time dateTime={new Date(scan.sampledAtMs).toISOString()}>
                {new Date(scan.sampledAtMs).toLocaleString(i18n.resolvedLanguage, {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </span>
            <p>{t("cleanup:fileInsights.completeDescription")}</p>
          </div>
        </div>
        <div className="file-insights-results__saving">
          <span aria-hidden="true"><Sparkles size={16} /></span>
          <div><small>{t("cleanup:fileInsights.possibleSavings")}</small><strong>{formatBytes(reclaimableBytes)}</strong></div>
        </div>
        <dl>
          <div><dt>{t("cleanup:fileInsights.metrics.scanned")}</dt><dd>{scan.scannedEntryCount.toLocaleString(i18n.resolvedLanguage)}</dd></div>
          <div><dt>{t("cleanup:fileInsights.duplicateGroups")}</dt><dd>{scan.duplicateGroups.length.toLocaleString(i18n.resolvedLanguage)}</dd></div>
          <div><dt>{t("cleanup:fileInsights.oldFiles")}</dt><dd>{scan.longUnmodifiedFiles.length.toLocaleString(i18n.resolvedLanguage)}</dd></div>
          <div><dt>{t("cleanup:fileInsights.duration")}</dt><dd>{Math.max(0.1, scan.durationMs / 1_000).toFixed(1)}s</dd></div>
        </dl>
      </section>

      {scan.truncated ? (
        <div className="file-insights-page__notice"><AlertTriangle size={15} /><span>{t("cleanup:fileInsights.truncated")}</span></div>
      ) : null}

      <nav className="file-insights-results__tabs" aria-label={t("cleanup:fileInsights.resultNavigation")}>
        <button className={resultView === "duplicates" ? "is-active" : undefined} type="button" onClick={() => onResultViewChange("duplicates")}>
          <Copy size={15} /><span>{t("cleanup:fileInsights.duplicates")}</span><b>{scan.duplicateGroups.length}</b>
        </button>
        <button className={resultView === "old" ? "is-active" : undefined} type="button" onClick={() => onResultViewChange("old")}>
          <CalendarClock size={15} /><span>{t("cleanup:fileInsights.longUnmodified")}</span><b>{scan.longUnmodifiedFiles.length}</b>
        </button>
      </nav>

      <div
        className="file-insights-results__content"
        role="region"
        aria-label={t("cleanup:fileInsights.resultNavigation")}
        tabIndex={0}
      >
        {resultView === "duplicates" ? (
          scan.duplicateGroups.length > 0 ? (
            <div className="duplicate-groups">
              <DuplicateProcessingBar
                selectedCount={selectedDuplicateCount}
                selectedBytes={selectedDuplicateBytes}
                outcome={processingOutcome}
                onOpenProcessing={onOpenProcessing}
              />
              {scan.duplicateGroups.map((group, index) => (
                <DuplicateGroupCard
                  group={group}
                  index={index}
                  selected={selectedGroupDigests.has(group.digest)}
                  keptPath={keptPathByDigest.get(group.digest) ?? group.files[0]?.path ?? ""}
                  onToggle={() => onToggleGroup(group.digest)}
                  onKeep={(path) => onKeepFile(group.digest, path)}
                  key={group.digest}
                />
              ))}
            </div>
          ) : <FileInsightsEmpty icon={<Copy size={22} />} text={t("cleanup:fileInsights.noDuplicates")} />
        ) : scan.longUnmodifiedFiles.length > 0 ? (
          <div className="file-insights-old-files">
            {scan.longUnmodifiedFiles.map((file, index) => (
              <FileInsightRow file={file} index={index} kind="old" key={file.path} />
            ))}
          </div>
        ) : <FileInsightsEmpty icon={<CalendarClock size={22} />} text={t("cleanup:fileInsights.noOldFiles")} />}
      </div>
      <small className="file-insights-results__boundary"><ShieldCheck size={13} />{t("cleanup:fileInsights.boundary")}</small>
    </div>
  );
}

function DuplicateProcessingBar({
  selectedCount,
  selectedBytes,
  outcome,
  onOpenProcessing,
}: {
  selectedCount: number;
  selectedBytes: number;
  outcome: DuplicateProcessingOutcome | null;
  onOpenProcessing: () => void;
}) {
  const { t } = useAppTranslation();
  const outcomeKey = outcome?.cancelled
    ? "cancelled"
    : outcome && outcome.failed.length > 0
      ? "partial"
      : "completed";
  return (
    <aside className={`duplicate-processing${selectedCount > 0 ? " has-selection" : ""}`}>
      <span className="duplicate-processing__icon" aria-hidden="true">
        {selectedCount > 0 ? <Trash2 size={17} /> : <ShieldCheck size={17} />}
      </span>
      <div className="duplicate-processing__copy">
        <strong>{selectedCount > 0
          ? t("cleanup:fileInsights.processing.summary", { count: selectedCount, size: formatBytes(selectedBytes) })
          : t("cleanup:fileInsights.processing.emptySelection")}</strong>
        <small>{t("cleanup:fileInsights.processing.selectionHint")}</small>
        {outcome ? (
          <em className={`is-${outcomeKey}`} role="status">
            {t(`cleanup:fileInsights.processing.${outcomeKey}`, {
              count: outcome.deletedCount,
              deletedCount: outcome.deletedCount,
              failedCount: outcome.failed.length,
              size: formatBytes(outcome.deletedBytes),
            })}
          </em>
        ) : null}
      </div>
      <button
        className="button button--primary duplicate-processing__action"
        type="button"
        disabled={selectedCount === 0}
        onClick={onOpenProcessing}
      >
        <ShieldCheck size={14} />{t("cleanup:fileInsights.processing.review")}
      </button>
    </aside>
  );
}

function DuplicateGroupCard({
  group,
  index,
  selected,
  keptPath,
  onToggle,
  onKeep,
}: {
  group: DuplicateFileGroup;
  index: number;
  selected: boolean;
  keptPath: string;
  onToggle: () => void;
  onKeep: (path: string) => void;
}) {
  const { t } = useAppTranslation();
  const scrollable = group.files.length > DUPLICATE_GROUP_SCROLL_THRESHOLD;
  return (
    <article className={`duplicate-group${selected ? " is-selected" : ""}`}>
      <header>
        <span className="duplicate-group__index">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <small>{t("cleanup:fileInsights.groupLabel")}</small>
          <h3 title={group.files[0]?.name}>{group.files[0]?.name ?? t("common:unknown")}</h3>
        </div>
        <span className="duplicate-group__copies"><Copy size={13} />{t("cleanup:fileInsights.copies", { count: group.files.length })}</span>
        <div className="duplicate-group__saving">
          <small>{t("cleanup:fileInsights.groupSavings")}</small>
          <strong>{formatBytes(group.reclaimableBytes)}</strong>
        </div>
        <button
          className="duplicate-group__toggle"
          type="button"
          aria-pressed={selected}
          onClick={onToggle}
        >
          {selected ? <CheckCircle2 size={14} /> : <Circle size={14} />}
          {t(selected
            ? "cleanup:fileInsights.processing.selectedGroup"
            : "cleanup:fileInsights.processing.selectGroup")}
        </button>
      </header>
      <div
        className={`duplicate-group__files${scrollable ? " is-scrollable" : ""}`}
        role={scrollable ? "region" : undefined}
        aria-label={scrollable
          ? `${group.files[0]?.name ?? t("common:unknown")} · ${t("cleanup:fileInsights.copies", { count: group.files.length })}`
          : undefined}
        tabIndex={scrollable ? 0 : undefined}
      >
        {group.files.map((file, fileIndex) => (
          <FileInsightRow
            file={file}
            index={fileIndex}
            kind="duplicate"
            selectedForProcessing={selected}
            kept={file.path === keptPath}
            onKeep={() => onKeep(file.path)}
            key={file.path}
          />
        ))}
      </div>
    </article>
  );
}

function fileInsightsFreshnessLabel(
  status: FileInsightsSnapshotStatus,
  t: ReturnType<typeof useAppTranslation>["t"],
): string {
  return status === "current"
    ? t("app:live")
    : status === "cached"
      ? t("cleanup:map.freshness.cached")
      : t("cleanup:map.freshness.expired");
}

function FileInsightRow({
  file,
  index,
  kind,
  selectedForProcessing = false,
  kept = false,
  onKeep,
}: {
  file: FileInsightFile;
  index: number;
  kind: "duplicate" | "old";
  selectedForProcessing?: boolean;
  kept?: boolean;
  onKeep?: () => void;
}) {
  const { t, i18n } = useAppTranslation();
  const planned = kind === "duplicate" && selectedForProcessing && !kept;
  return (
    <article className={`file-insights-file${kept ? " is-kept" : planned ? " is-planned" : ""}`}>
      <span className={`file-insights-file__icon is-${kind}`} aria-hidden="true">
        {kind === "duplicate" ? <FileArchive size={16} /> : <CalendarClock size={16} />}
      </span>
      <div className="file-insights-file__identity">
        <span>{kind === "duplicate" ? t("cleanup:fileInsights.copyIndex", { count: index + 1 }) : t("cleanup:fileInsights.oldFileLabel")}</span>
        <strong title={file.name}>{file.name}</strong>
        <code title={file.path}>{file.path}</code>
      </div>
      <div className="file-insights-file__meta">
        <strong>{formatBytes(file.sizeBytes)}</strong>
        <small>{file.modifiedAtMs === null
          ? t("common:unknown")
          : new Date(file.modifiedAtMs).toLocaleDateString(i18n.resolvedLanguage)}</small>
      </div>
      {kind === "duplicate" ? (
        <button
          className="file-insights-file__keep"
          type="button"
          role="radio"
          aria-checked={kept}
          aria-label={t("cleanup:fileInsights.processing.keepFile", { name: file.name })}
          onClick={onKeep}
        >
          {kept ? <CheckCircle2 size={13} /> : <Circle size={13} />}
          <span>{t(kept
            ? "cleanup:fileInsights.processing.kept"
            : planned
              ? "cleanup:fileInsights.processing.planned"
              : "cleanup:fileInsights.processing.keep")}</span>
        </button>
      ) : null}
      <PathActions path={file.path} compact />
    </article>
  );
}

function fileInsightToCleanupNode(file: FileInsightFile): CleanupMapNode {
  return {
    id: `file-insight:${file.path}`,
    name: file.name,
    path: file.path,
    sizeBytes: file.allocatedSizeBytes,
    logicalSizeBytes: file.logicalSizeBytes,
    allocatedSizeBytes: file.allocatedSizeBytes,
    itemCount: 1,
    safety: "review",
    kind: "file",
    deletionProtected: false,
    protectionReason: null,
    hasChildren: false,
    children: [],
  };
}

function FileInsightsEmpty({ icon, text }: { icon: ReactNode; text: string }) {
  const { t } = useAppTranslation();
  return (
    <div className="file-insights-results__empty">
      <span>{icon}</span>
      <strong>{t("cleanup:fileInsights.emptyResultTitle")}</strong>
      <p>{text}</p>
    </div>
  );
}
