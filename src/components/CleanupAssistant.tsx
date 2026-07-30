import {
  AlertTriangle,
  ArchiveRestore,
  ArrowRight,
  Boxes,
  Code2,
  Download,
  FileArchive,
  FolderOpen,
  FolderSearch,
  HardDrive,
  LockKeyhole,
  Plus,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadRecentCleanupTargets,
  saveRecentCleanupTarget,
} from "../cleanupScanTargets";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  getCleanupScanAccess,
  openCleanupFullDiskAccessSettings,
  revealCleanupApplicationBundle,
} from "../api";
import type { FileInsightsScanController } from "../hooks/useFileInsightsScan";
import type {
  CleanupLocationKind,
  CleanupScan,
  CleanupScanAccess,
  CleanupScanJobPhase,
  CleanupScanProgress,
  CleanupScanTarget,
  CommandError,
  VolumeSnapshot,
} from "../types";
import type { CleanupDeletionTargetSnapshot, CleanupSnapshotStatus } from "../cleanupScanStore";
import type { CleanupScanGrowthComparison } from "../cleanupScanHistory";
import { findUnusedApplications, unusedApplicationDays } from "../cleanupApplications";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, normalizeCommandError } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { Button } from "./Button";
import {
  CleanupSpaceMap,
  type CleanupSpaceMapCommand,
} from "./CleanupSpaceMap";
import { FileInsightsExplorer, FileInsightsLauncher } from "./FileInsightsExplorer";
import { PathActions } from "./PathActions";
import "./CleanupAssistant.css";

const LIMITED_SCAN_PREFERENCE_KEY =
  "core-robin.cleanup.prefer-accessible-scan.v1";
type CleanupSpaceMapCommandInput =
  CleanupSpaceMapCommand extends infer Command
    ? Command extends { id: number }
      ? Omit<Command, "id">
      : never
    : never;

interface CleanupAssistantProps {
  snapshot: CleanupScan | null;
  error: CommandError | null;
  loading: boolean;
  cancelling: boolean;
  phase: CleanupScanJobPhase | null;
  progress: CleanupScanProgress | null;
  snapshotStatus: CleanupSnapshotStatus;
  growthComparison?: CleanupScanGrowthComparison | null;
  volumes?: readonly VolumeSnapshot[];
  onScan: (target?: CleanupScanTarget) => void;
  onCancel: () => void;
  onDeletionApplied: (
    targets: readonly CleanupDeletionTargetSnapshot[],
    invalidateSnapshot?: boolean,
  ) => Promise<void>;
  onSubtreeRetained: (subtree: CleanupScan["root"]) => Promise<void>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
  fileInsights: FileInsightsScanController;
  onOpenApplications: () => void;
}

const LOCATION_ICONS = {
  downloads: Download,
  trash: Trash2,
  app_cache: Boxes,
  developer_cache: Code2,
  hidden_data: FolderSearch,
} satisfies Record<CleanupLocationKind, typeof Download>;

export function CleanupAssistant({
  snapshot,
  error,
  loading,
  cancelling,
  phase,
  progress,
  snapshotStatus,
  growthComparison = null,
  volumes = [],
  onScan,
  onCancel,
  onDeletionApplied,
  onSubtreeRetained,
  onUserActionStart,
  onUserActionComplete,
  fileInsights,
  onOpenApplications,
}: CleanupAssistantProps) {
  const { t, i18n } = useAppTranslation();
  const [accessGuideOpen, setAccessGuideOpen] = useState(false);
  const [scanAccess, setScanAccess] = useState<CleanupScanAccess | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [openingAccessSettings, setOpeningAccessSettings] = useState(false);
  const [revealingApplication, setRevealingApplication] = useState(false);
  const [waitingForAccess, setWaitingForAccess] = useState(false);
  const [accessError, setAccessError] = useState<CommandError | null>(null);
  const [preferAccessibleScan, setPreferAccessibleScan] = useState(
    readAccessibleScanPreference,
  );
  const [activeWorkspace, setActiveWorkspace] = useState<"space" | "files">("space");
  const [selectedTarget, setSelectedTarget] = useState<CleanupScanTarget>(
    () => snapshot
      ? { targetKind: snapshot.targetKind, targetPath: snapshot.targetPath }
      : { targetKind: "system_disk", targetPath: null },
  );
  const [recentTargets, setRecentTargets] = useState(loadRecentCleanupTargets);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [mapCommand, setMapCommand] =
    useState<CleanupSpaceMapCommand | null>(null);
  const mapCommandIdRef = useRef(0);
  const accessCheckInFlight = useRef(false);
  const reclaimableBytes = useMemo(
    () => snapshot?.locations.reduce(
      (total, location) =>
        location.available && location.safety === "reclaimable"
          ? total + location.sizeBytes
          : total,
      0,
    ) ?? 0,
    [snapshot],
  );
  const progressLocation = progress
    ? cleanupProgressLocation(progress.currentPath, t)
    : t("cleanup:progress.locations.personal");
  const unusedApplications = useMemo(
    () => snapshot
      ? findUnusedApplications(snapshot.installedApplications, snapshot.sampledAtMs)
      : [],
    [snapshot],
  );
  const unknownApplicationUseCount = useMemo(
    () => snapshot?.installedApplications.filter((application) => application.lastUsedAtMs === null).length ?? 0,
    [snapshot],
  );
  const applicationBundleUnavailable = scanAccess?.applicationBundleAvailable === false;
  const scanStalled = phase === "stalled";
  const scanPaused = phase === "paused";
  const pristine = !snapshot && !loading && !error && !accessGuideOpen;
  const selectableVolumes = useMemo(
    () => volumes.filter((volume) => volume.mountPoint !== "/"),
    [volumes],
  );

  useEffect(() => {
    if (!snapshot) return;
    setSelectedTarget({
      targetKind: snapshot.targetKind,
      targetPath: snapshot.targetPath,
    });
  }, [snapshot]);

  const startSelectedScan = useCallback(() => {
    if (selectedTarget.targetKind !== "system_disk") {
      setRecentTargets(saveRecentCleanupTarget(selectedTarget));
    }
    onScan(selectedTarget);
  }, [onScan, selectedTarget]);

  const checkScanAccess = useCallback(async (
    startWhenReady: boolean,
    allowAccessibleFallback = false,
  ) => {
    if (accessCheckInFlight.current || loading) return;
    accessCheckInFlight.current = true;
    setCheckingAccess(true);
    setAccessError(null);
    try {
      const access = await getCleanupScanAccess();
      setScanAccess(access);
      const ready = !access.fullDiskAccessRecommended ||
        access.fullDiskAccess === "granted" ||
        access.fullDiskAccess === "not_required";
      if (ready) {
        setPreferAccessibleScan(false);
        writeAccessibleScanPreference(false);
        setAccessGuideOpen(false);
        setWaitingForAccess(false);
        if (startWhenReady) startSelectedScan();
      } else if (startWhenReady && allowAccessibleFallback) {
        setAccessGuideOpen(false);
        setWaitingForAccess(false);
        startSelectedScan();
      } else {
        setAccessGuideOpen(true);
      }
    } catch (caughtError) {
      setScanAccess(null);
      if (startWhenReady && allowAccessibleFallback) {
        setAccessGuideOpen(false);
        setWaitingForAccess(false);
        startSelectedScan();
      } else {
        setAccessError(normalizeCommandError(caughtError));
        setAccessGuideOpen(true);
      }
    } finally {
      accessCheckInFlight.current = false;
      setCheckingAccess(false);
    }
  }, [loading, startSelectedScan]);

  useEffect(() => {
    if (!waitingForAccess) return;
    const recheckWhenVisible = () => {
      if (document.visibilityState === "visible") void checkScanAccess(true);
    };
    window.addEventListener("focus", recheckWhenVisible);
    document.addEventListener("visibilitychange", recheckWhenVisible);
    return () => {
      window.removeEventListener("focus", recheckWhenVisible);
      document.removeEventListener("visibilitychange", recheckWhenVisible);
    };
  }, [checkScanAccess, waitingForAccess]);

  const requestScan = () => {
    if (scanStalled) {
      startSelectedScan();
      return;
    }
    if (loading && !scanStalled) {
      onCancel();
      return;
    }
    if (selectedTarget.targetKind === "system_disk") {
      void checkScanAccess(true, preferAccessibleScan);
      return;
    }
    startSelectedScan();
  };

  const openAccessSettings = async () => {
    if (openingAccessSettings || scanAccess?.applicationBundleAvailable === false) return;
    setOpeningAccessSettings(true);
    setAccessError(null);
    try {
      await openCleanupFullDiskAccessSettings();
      setWaitingForAccess(true);
    } catch (caughtError) {
      setAccessError(normalizeCommandError(caughtError));
    } finally {
      setOpeningAccessSettings(false);
    }
  };

  const revealApplication = async () => {
    if (revealingApplication || !scanAccess?.applicationBundleAvailable) return;
    setRevealingApplication(true);
    setAccessError(null);
    try {
      await revealCleanupApplicationBundle();
    } catch (caughtError) {
      setAccessError(normalizeCommandError(caughtError));
    } finally {
      setRevealingApplication(false);
    }
  };

  const scanAccessibleAreas = () => {
    setPreferAccessibleScan(true);
    writeAccessibleScanPreference(true);
    setAccessGuideOpen(false);
    setWaitingForAccess(false);
    setAccessError(null);
    startSelectedScan();
  };

  const chooseFolder = async () => {
    if (selectingFolder || loading) return;
    setSelectingFolder(true);
    setAccessError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("cleanup:targets.chooseFolderTitle"),
      });
      if (typeof selected !== "string" || selected.length === 0) return;
      const target: CleanupScanTarget = {
        targetKind: "folder",
        targetPath: selected,
      };
      setSelectedTarget(target);
      setRecentTargets(saveRecentCleanupTarget(target));
    } catch (caughtError) {
      setAccessError(normalizeCommandError(caughtError));
    } finally {
      setSelectingFolder(false);
    }
  };

  const selectTarget = (target: CleanupScanTarget) => {
    if (loading) return;
    setSelectedTarget(target);
  };

  const sendMapCommand = (
    command: CleanupSpaceMapCommandInput,
  ) => {
    const id = mapCommandIdRef.current + 1;
    mapCommandIdRef.current = id;
    setMapCommand({ ...command, id } as CleanupSpaceMapCommand);
    window.requestAnimationFrame(() => {
      document.getElementById("cleanup-space-map")?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  if (activeWorkspace === "files") {
    return (
      <FileInsightsExplorer
        scan={fileInsights.snapshot}
        snapshotStatus={fileInsights.snapshotStatus}
        progress={fileInsights.progress}
        loading={fileInsights.loading}
        error={fileInsights.error}
        onRun={() => void fileInsights.scan()}
        onCancel={() => void fileInsights.cancel()}
        onBack={() => setActiveWorkspace("space")}
        onFilesRemoved={fileInsights.removePaths}
        onDeletionApplied={onDeletionApplied}
        onUserActionStart={onUserActionStart}
        onUserActionComplete={onUserActionComplete}
      />
    );
  }

  return (
    <section className={`panel cleanup-assistant${loading && !snapshot ? " is-scanning" : ""}${pristine ? " is-pristine" : ""}`} aria-labelledby="cleanup-title">
      <header className="cleanup-assistant__header">
        <span className="cleanup-assistant__icon" aria-hidden="true">
          <ScanSearch size={20} />
        </span>
        <div>
          <span className="eyebrow">{t("cleanup:kicker")}</span>
          <h2 id="cleanup-title">{t("cleanup:title")}</h2>
          <p>{t("cleanup:description")}</p>
        </div>
        {!pristine ? (
          <button
            className="button button--secondary cleanup-assistant__scan"
            type="button"
            disabled={cancelling || checkingAccess}
            onClick={requestScan}
          >
            {scanStalled
              ? <RefreshCw size={15} />
              : loading
              ? cancelling ? <RefreshCw className="is-spinning" size={15} /> : <Square size={13} />
              : checkingAccess ? <RefreshCw className="is-spinning" size={15} /> : <ScanSearch size={15} />}
            {checkingAccess
              ? t("cleanup:access.checking")
              : scanStalled
                ? t("cleanup:restartScan")
                : loading
                ? cancelling ? t("cleanup:cancelling") : t("cleanup:cancelScan")
                : snapshot
                  ? t("cleanup:scanAgain")
                  : t("cleanup:startScan")}
          </button>
        ) : null}
      </header>

      <section className="cleanup-targets" aria-labelledby="cleanup-targets-title">
        <div className="cleanup-targets__heading">
          <div>
            <span className="eyebrow">{t("cleanup:targets.kicker")}</span>
            <h3 id="cleanup-targets-title">{t("cleanup:targets.title")}</h3>
          </div>
          <span className="cleanup-targets__current" title={selectedTarget.targetPath ?? undefined}>
            {targetLabel(selectedTarget, volumes, t)}
          </span>
        </div>
        <div className="cleanup-targets__choices">
          <button
            className={selectedTarget.targetKind === "system_disk" ? "is-selected" : undefined}
            type="button"
            disabled={loading}
            onClick={() => selectTarget({ targetKind: "system_disk", targetPath: null })}
          >
            <HardDrive size={15} />
            <span>{t("cleanup:targets.systemDisk")}</span>
          </button>
          {selectableVolumes.map((volume) => (
            <button
              className={selectedTarget.targetKind === "volume" && selectedTarget.targetPath === volume.mountPoint ? "is-selected" : undefined}
              key={volume.mountPoint}
              type="button"
              disabled={loading}
              title={volume.mountPoint}
              onClick={() => selectTarget({ targetKind: "volume", targetPath: volume.mountPoint })}
            >
              <ArchiveRestore size={15} />
              <span>{volume.name || volume.mountPoint}</span>
              {volume.removable ? <small>{t("cleanup:targets.removable")}</small> : null}
            </button>
          ))}
          <button
            className={selectedTarget.targetKind === "folder" && !recentTargets.some((target) => target.targetPath === selectedTarget.targetPath) ? "is-selected" : undefined}
            type="button"
            disabled={loading || selectingFolder}
            onClick={() => void chooseFolder()}
          >
            {selectingFolder ? <RefreshCw className="is-spinning" size={15} /> : <FolderOpen size={15} />}
            <span>{t("cleanup:targets.chooseFolder")}</span>
          </button>
        </div>
        {recentTargets.length > 0 ? (
          <div className="cleanup-targets__recent">
            <span>{t("cleanup:targets.recent")}</span>
            {recentTargets.map((target) => (
              <button
                className={selectedTarget.targetKind === target.targetKind && selectedTarget.targetPath === target.targetPath ? "is-selected" : undefined}
                key={`${target.targetKind}:${target.targetPath}`}
                type="button"
                disabled={loading}
                title={target.targetPath ?? undefined}
                onClick={() => selectTarget(target)}
              >
                {targetBasename(target.targetPath)}
              </button>
            ))}
          </div>
        ) : null}
        {selectedTarget.targetKind !== "system_disk" ? (
          <p className="cleanup-targets__notice">
            <ShieldCheck size={13} />
            {t("cleanup:targets.readOnlyNotice")}
          </p>
        ) : null}
      </section>

      {accessGuideOpen && !loading ? (
        <section className="cleanup-access-guide" aria-labelledby="cleanup-access-title">
          <button
            className="cleanup-access-guide__close"
            type="button"
            aria-label={t("common:close")}
            onClick={() => {
              setAccessGuideOpen(false);
              setWaitingForAccess(false);
            }}
          >
            <X size={15} />
          </button>
          <div className="cleanup-access-guide__visual" aria-hidden="true">
            <span><HardDrive size={32} /></span>
            <i><LockKeyhole size={17} /></i>
          </div>
          <div className="cleanup-access-guide__content">
            <span className="eyebrow">{t("cleanup:access.kicker")}</span>
            <h3 id="cleanup-access-title">{t("cleanup:access.title")}</h3>
            <p>{t("cleanup:access.description")}</p>
            <ol>
              <li><b>1</b><span>{t("cleanup:access.steps.open")}</span></li>
              <li><b>2</b><span>{t("cleanup:access.steps.add")}</span></li>
              <li><b>3</b><span>{t("cleanup:access.steps.return")}</span></li>
            </ol>
            {scanAccess?.applicationBundleAvailable === false ? (
              <div className="cleanup-access-guide__status is-unknown" role="status">
                <AlertTriangle size={14} />
                <span><strong>{t("cleanup:access.bundleMissingTitle")}</strong>{t("cleanup:access.bundleMissingDescription")}</span>
              </div>
            ) : waitingForAccess ? (
              <div className="cleanup-access-guide__status is-waiting" role="status">
                <RefreshCw className={checkingAccess ? "is-spinning" : undefined} size={14} />
                <span>{t(checkingAccess ? "cleanup:access.checkingReturn" : "cleanup:access.waiting")}</span>
              </div>
            ) : scanAccess?.fullDiskAccess === "unknown" ? (
              <div className="cleanup-access-guide__status is-unknown" role="status">
                <AlertTriangle size={14} />
                <span>{t("cleanup:access.unknown")}</span>
              </div>
            ) : null}
            {accessError ? (
              <div className="cleanup-access-guide__error" role="alert">
                <AlertTriangle size={14} />
                <span>{accessError.message}</span>
              </div>
            ) : null}
            <div className="cleanup-access-guide__actions">
              <button
                className={`button ${applicationBundleUnavailable ? "button--secondary" : "button--primary"}`}
                type="button"
                disabled={openingAccessSettings || applicationBundleUnavailable}
                onClick={() => void openAccessSettings()}
              >
                {openingAccessSettings ? <RefreshCw className="is-spinning" size={14} /> : <Settings2 size={14} />}
                {t(scanAccess?.applicationBundleAvailable === false
                  ? "cleanup:access.bundleRequired"
                  : waitingForAccess
                    ? "cleanup:access.openAgain"
                    : "cleanup:access.openSettings")}
              </button>
              {scanAccess?.applicationBundleAvailable ? (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={revealingApplication}
                  title={scanAccess.applicationBundlePath ?? undefined}
                  onClick={() => void revealApplication()}
                >
                  {revealingApplication ? <RefreshCw className="is-spinning" size={14} /> : <FolderOpen size={14} />}
                  {t("cleanup:access.revealApp")}
                </button>
              ) : null}
              {waitingForAccess ? (
                <button className="button button--secondary" type="button" disabled={checkingAccess} onClick={() => void checkScanAccess(true)}>
                  <ShieldCheck size={14} />{t("cleanup:access.checkAgain")}
                </button>
              ) : null}
              <button
                className={`button cleanup-access-guide__limited ${applicationBundleUnavailable ? "button--primary is-primary-action" : "button--secondary"}`}
                type="button"
                onClick={scanAccessibleAreas}
              >
                <ScanSearch size={14} />
                {t("cleanup:access.continueLimited")}
              </button>
            </div>
            <small>{t("cleanup:access.privacy")}</small>
          </div>
        </section>
      ) : null}

      {pristine ? (
        <section className="cleanup-empty-state" aria-labelledby="cleanup-empty-title">
          <div className="cleanup-empty-state__visual" aria-hidden="true">
            <div className="cleanup-empty-state__orbit is-outer" />
            <div className="cleanup-empty-state__orbit is-inner" />
            <div className="cleanup-empty-state__sweep" />
            <span className="cleanup-empty-state__node is-download"><Download size={17} /></span>
            <span className="cleanup-empty-state__node is-cache"><Boxes size={17} /></span>
            <span className="cleanup-empty-state__node is-developer"><Code2 size={17} /></span>
            <span className="cleanup-empty-state__core"><HardDrive size={32} /><i /></span>
          </div>

          <div className="cleanup-empty-state__content">
            <h3 id="cleanup-empty-title">{t("cleanup:readOnlyTitle")}</h3>
            <p>{t("cleanup:readOnlyDescription")}</p>
            <ul aria-label={t("cleanup:description")}>
              {(["downloads", "app_cache", "developer_cache"] as const).map((kind) => {
                const Icon = LOCATION_ICONS[kind];
                return <li key={kind}><Icon size={14} />{t(`cleanup:locations.${kind}.title`)}</li>;
              })}
            </ul>
            <Button
              variant="primary"
              className="cleanup-empty-state__action"
              disabled={checkingAccess}
              onClick={requestScan}
            >
              {checkingAccess ? <RefreshCw className="is-spinning" size={16} /> : <ScanSearch size={16} />}
              {t(checkingAccess ? "cleanup:access.checking" : "cleanup:startScan")}
            </Button>
          </div>
        </section>
      ) : loading && progress ? (
        <div className="cleanup-progress" role="status" aria-live="polite">
          <div className="cleanup-progress__indicator"><i /></div>
          <div className="cleanup-progress__content">
            <span><RefreshCw className="is-spinning" size={15} /></span>
            <div>
              <strong>
                {t(
                  scanStalled
                    ? "cleanup:progress.stalled"
                    : scanPaused
                      ? "cleanup:progress.paused"
                      : "cleanup:progress.scanningLocation",
                  { location: progressLocation },
                )}
              </strong>
            </div>
          </div>
          <dl>
            <div><dt>{t("cleanup:progress.entries")}</dt><dd>{progress.scannedEntryCount.toLocaleString(i18n.resolvedLanguage)}</dd></div>
            <div><dt>{t("cleanup:progress.discovered")}</dt><dd>{formatBytes(progress.discoveredBytes)}</dd></div>
            <div><dt>{t("cleanup:progress.elapsed")}</dt><dd>{Math.max(0.1, progress.elapsedMs / 1_000).toFixed(1)}s</dd></div>
          </dl>
        </div>
      ) : null}

      {scanStalled ? (
        <div className="cleanup-assistant__error is-recoverable" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>{t("cleanup:progress.stalledTitle")}</strong>
            <span>{t("cleanup:progress.stalledDescription")}</span>
          </div>
        </div>
      ) : null}

      {loading && progress && !snapshot ? (
        <section className="cleanup-scan-stage" aria-labelledby="cleanup-scan-stage-title">
          <div className="cleanup-scan-orbit" aria-hidden="true">
            <div className="cleanup-scan-orbit__halo" />
            <div className="cleanup-scan-orbit__ring is-outer" />
            <div className="cleanup-scan-orbit__ring is-middle" />
            <div className="cleanup-scan-orbit__ring is-inner" />
            <div className="cleanup-scan-orbit__sweep" />
            <i className="is-one" /><i className="is-two" /><i className="is-three" />
            <div className="cleanup-scan-orbit__center">
              <Sparkles size={19} />
              <small>{t("cleanup:progress.foundSpace")}</small>
              <strong>{formatBytes(progress.discoveredBytes)}</strong>
            </div>
          </div>

          <div className="cleanup-scan-stage__story">
            <h3 id="cleanup-scan-stage-title">{t("cleanup:progress.stageKicker")}</h3>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="cleanup-assistant__error" role="alert">
          <AlertTriangle size={17} />
          <div><strong>{t("cleanup:failed")}</strong><span>{error.message}</span></div>
        </div>
      ) : null}

      {snapshot ? (
        <FileInsightsLauncher
          scan={fileInsights.snapshot}
          snapshotStatus={fileInsights.snapshotStatus}
          loading={fileInsights.loading}
          onOpen={() => setActiveWorkspace("files")}
        />
      ) : null}

      {snapshot && preferAccessibleScan ? (
        <div className="cleanup-assistant__limited-notice" role="status">
          <ShieldCheck size={15} />
          <span>{t("cleanup:access.privacy")}</span>
          <button
            className="button button--plain"
            type="button"
            disabled={openingAccessSettings}
            onClick={() => void openAccessSettings()}
          >
            <Settings2 size={14} />
            {t("cleanup:access.openSettings")}
          </button>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <div className="cleanup-assistant__summary">
            <span><ArchiveRestore size={17} /></span>
            <div>
              <small>{t("cleanup:reclaimableEstimate")}</small>
              <strong>{formatBytes(reclaimableBytes)}</strong>
              <em>{t("cleanup:estimateBoundary")}</em>
            </div>
            <div className="cleanup-assistant__scan-meta">
              <span>{t("cleanup:entriesScanned", { count: snapshot.scannedEntryCount })}</span>
              <span>{new Date(snapshot.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>

          {growthComparison ? (
            <section className="cleanup-growth" aria-labelledby="cleanup-growth-title">
              <div className="cleanup-growth__headline">
                <span><Sparkles size={17} /></span>
                <div>
                  <small>{t("cleanup:growth.since", {
                    time: new Date(growthComparison.previousSampledAtMs)
                      .toLocaleString(i18n.resolvedLanguage),
                  })}</small>
                  <h3 id="cleanup-growth-title">{t("cleanup:growth.title")}</h3>
                </div>
                <strong className={growthComparison.growthBytes > 0 ? "is-growth" : "is-reduced"}>
                  {growthComparison.growthBytes > 0 ? "+" : ""}
                  {formatBytes(growthComparison.growthBytes)}
                </strong>
              </div>
              {growthComparison.fastestGrowing.length > 0 ? (
                <ol>
                  {growthComparison.fastestGrowing.map((directory) => (
                    <li key={directory.path}>
                      <FolderOpen size={14} />
                      <span title={directory.path}>{directory.name}</span>
                      <strong>+{formatBytes(directory.growthBytes)}</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{t("cleanup:growth.noGrowth")}</p>
              )}
            </section>
          ) : null}

          <CleanupSpaceMap
            snapshot={snapshot}
            snapshotStatus={snapshotStatus}
            command={mapCommand}
            onCommandHandled={(id) => {
              setMapCommand((current) => current?.id === id ? null : current);
            }}
            onDeletionApplied={onDeletionApplied}
            onSubtreeRetained={onSubtreeRetained}
            onUserActionStart={onUserActionStart}
            onUserActionComplete={onUserActionComplete}
          />

          <header className="cleanup-category-summary__heading">
            <div>
              <h3>{t("cleanup:categories.title")}</h3>
            </div>
          </header>
          <div className="cleanup-location-grid">
            {snapshot.locations.map((location) => {
              const Icon = LOCATION_ICONS[location.kind];
              return (
                <article
                  className={`cleanup-location${!location.available ? " is-unavailable" : ""}`}
                  key={location.kind}
                >
                  <header>
                    <span><Icon size={16} /></span>
                    <div>
                      <strong>{t(`cleanup:locations.${location.kind}.title`)}</strong>
                      <small>{t(`cleanup:locations.${location.kind}.description`)}</small>
                    </div>
                    <em className={`is-${location.safety}`}>
                      {t(`cleanup:safety.${location.safety}`)}
                    </em>
                  </header>
                  <div className="cleanup-location__value">
                    <strong>{location.available ? formatBytes(location.sizeBytes) : "—"}</strong>
                    <span>{location.available ? t("cleanup:itemCount", { count: location.itemCount }) : t("cleanup:unavailable")}</span>
                  </div>
                  <code title={location.paths.join("\n")}>
                    {location.paths[0] ?? t("cleanup:pathUnavailable")}
                    {location.paths.length > 1 ? t("cleanup:morePaths", { count: location.paths.length - 1 }) : ""}
                  </code>
                  {location.available && location.paths[0] ? (
                    <div className="cleanup-location__actions">
                      <PathActions path={location.paths[0]} compact />
                      <button
                        className="button button--plain"
                        type="button"
                        onClick={() => sendMapCommand({
                          type: "focusLocation",
                          locationKind: location.kind,
                        })}
                      >
                        <ArrowRight size={13} />
                        {t("cleanup:map.mode.category")}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>

          <section className="cleanup-applications" aria-labelledby="cleanup-applications-title">
            <header>
              <div>
                <span className="eyebrow">{t("cleanup:applications.kicker")}</span>
                <h3 id="cleanup-applications-title">{t("cleanup:applications.title")}</h3>
              </div>
              <span>{t("cleanup:applications.boundary")}</span>
            </header>
            {!snapshot.applicationInventoryAvailable ? (
              <div className="cleanup-applications__empty">{t("cleanup:applications.unavailable")}</div>
            ) : unusedApplications.length > 0 ? (
              <ol>
                {unusedApplications.map((application) => {
                  const inactiveDays = unusedApplicationDays(application, snapshot.sampledAtMs);
                  return (
                    <li key={application.path} title={application.path}>
                      <ApplicationAvatar
                        name={application.name}
                        source={{ applicationPath: application.path }}
                        className="cleanup-application-avatar"
                      />
                      <div>
                        <strong>{application.name}</strong>
                        <small>{t("cleanup:applications.lastUsed", {
                          date: new Date(application.lastUsedAtMs ?? 0).toLocaleDateString(i18n.resolvedLanguage),
                          days: inactiveDays ?? 0,
                        })}</small>
                      </div>
                      <strong>{formatBytes(application.sizeBytes)}</strong>
                      <button
                        className="button button--plain cleanup-applications__open"
                        type="button"
                        onClick={onOpenApplications}
                      >
                        {t("app:applications")}<ArrowRight size={13} />
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="cleanup-applications__empty">{t("cleanup:applications.none")}</div>
            )}
            {snapshot.applicationInventoryAvailable && unknownApplicationUseCount > 0 ? (
              <footer>{t("cleanup:applications.unknownExcluded", { count: unknownApplicationUseCount })}</footer>
            ) : null}
          </section>

          <section className="cleanup-largest" aria-labelledby="cleanup-largest-title">
            <header>
              <div>
                <span className="eyebrow">{t("cleanup:reviewFirst")}</span>
                <h3 id="cleanup-largest-title">{t("cleanup:largestFiles")}</h3>
              </div>
              <span>{t("cleanup:largeFileBoundary")}</span>
            </header>
            {snapshot.largestFiles.length > 0 ? (
              <ol>
                {snapshot.largestFiles.map((file) => (
                  <li key={file.path}>
                    <span><FileArchive size={15} /></span>
                    <div><strong>{file.name}</strong><code title={file.path}>{file.path}</code></div>
                    <small>{file.modifiedAtMs === null ? t("common:unknown") : new Date(file.modifiedAtMs).toLocaleDateString(i18n.resolvedLanguage)}</small>
                    <strong>{formatBytes(file.sizeBytes)}</strong>
                    <PathActions path={file.path} compact />
                    <button
                      className="button button--plain cleanup-largest__collect"
                      type="button"
                      onClick={() => sendMapCommand({
                        type: "addPath",
                        name: file.name,
                        path: file.path,
                        sizeBytes: file.sizeBytes,
                      })}
                    >
                      <Plus size={13} />
                      {t("cleanup:map.basket.title")}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="cleanup-largest__empty">{t("cleanup:noLargeFiles")}</div>
            )}
          </section>

          {snapshot.unreadableEntryCount > 0 ? (
            <div className="cleanup-assistant__notice">
              <AlertTriangle size={14} />
              <div>
                <strong>{t("cleanup:unreadable", { count: snapshot.unreadableEntryCount })}</strong>
                <span>{t("cleanup:fullDiskAccessHint")}</span>
                {snapshot.unreadablePaths.length > 0 ? (
                  <code title={snapshot.unreadablePaths.join("\n")}>{snapshot.unreadablePaths.join(" · ")}</code>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function targetLabel(
  target: CleanupScanTarget,
  volumes: readonly VolumeSnapshot[],
  t: AppTFunction,
): string {
  if (target.targetKind === "system_disk") return t("cleanup:targets.systemDisk");
  const volume = volumes.find((candidate) => candidate.mountPoint === target.targetPath);
  if (volume) return volume.name || volume.mountPoint;
  return target.targetPath ?? t("cleanup:targets.systemDisk");
}

function targetBasename(path: string | null): string {
  if (!path) return "";
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function readAccessibleScanPreference(): boolean {
  try {
    return window.localStorage.getItem(LIMITED_SCAN_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeAccessibleScanPreference(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(LIMITED_SCAN_PREFERENCE_KEY, "true");
    } else {
      window.localStorage.removeItem(LIMITED_SCAN_PREFERENCE_KEY);
    }
  } catch {
    // The preference is a convenience only; scanning remains available.
  }
}

function cleanupProgressLocation(
  path: string,
  t: AppTFunction,
) {
  const normalized = path.toLowerCase();
  if (normalized === "/applications" || normalized.endsWith("/applications")) {
    return t("cleanup:progress.locations.applications");
  }
  if (normalized.includes("downloads")) return t("cleanup:progress.locations.downloads");
  if (normalized.includes(".trash") || normalized.includes("/trash/")) return t("cleanup:progress.locations.trash");
  if (normalized.includes("library/caches")) return t("cleanup:progress.locations.appCache");
  if (/\/(\.cache|\.cargo|\.npm|\.pnpm|\.yarn|\.gradle|\.m2|\.bun|\.rustup)(\/|$)/.test(normalized)
    || normalized.includes("library/developer")
    || normalized.includes("library/pnpm")) {
    return t("cleanup:progress.locations.developerCache");
  }
  if (normalized.startsWith("~/.") || normalized.includes("/.")) return t("cleanup:progress.locations.hiddenData");
  if (normalized.startsWith("/") || /^[a-z]:[\\/]/.test(normalized)) {
    return t("cleanup:progress.locations.systemDisk");
  }
  return t("cleanup:progress.locations.personal");
}
