import {
  AlertTriangle,
  AppWindow,
  ArchiveRestore,
  Boxes,
  Code2,
  Download,
  Eye,
  FileArchive,
  FolderOpen,
  FolderSearch,
  HardDrive,
  LockKeyhole,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  getCleanupScanAccess,
  openCleanupFullDiskAccessSettings,
  revealCleanupApplicationBundle,
} from "../api";
import type {
  CleanupLocationKind,
  CleanupScan,
  CleanupScanAccess,
  CleanupScanProgress,
  CommandError,
} from "../types";
import type { CleanupDeletionTargetSnapshot, CleanupSnapshotStatus } from "../cleanupScanStore";
import { findUnusedApplications, unusedApplicationDays } from "../cleanupApplications";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, normalizeCommandError } from "../utils";
import { CleanupSpaceMap } from "./CleanupSpaceMap";

interface CleanupAssistantProps {
  snapshot: CleanupScan | null;
  error: CommandError | null;
  loading: boolean;
  cancelling: boolean;
  progress: CleanupScanProgress | null;
  snapshotStatus: CleanupSnapshotStatus;
  onScan: () => void;
  onCancel: () => void;
  onDeletionApplied: (
    targets: readonly CleanupDeletionTargetSnapshot[],
    invalidateSnapshot?: boolean,
  ) => Promise<void>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
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
  progress,
  snapshotStatus,
  onScan,
  onCancel,
  onDeletionApplied,
  onUserActionStart,
  onUserActionComplete,
}: CleanupAssistantProps) {
  const { t, i18n } = useAppTranslation();
  const [accessGuideOpen, setAccessGuideOpen] = useState(false);
  const [scanAccess, setScanAccess] = useState<CleanupScanAccess | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [openingAccessSettings, setOpeningAccessSettings] = useState(false);
  const [revealingApplication, setRevealingApplication] = useState(false);
  const [waitingForAccess, setWaitingForAccess] = useState(false);
  const [accessError, setAccessError] = useState<CommandError | null>(null);
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

  const checkScanAccess = useCallback(async (startWhenReady: boolean) => {
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
        setAccessGuideOpen(false);
        setWaitingForAccess(false);
        if (startWhenReady) onScan();
      } else {
        setAccessGuideOpen(true);
      }
    } catch (caughtError) {
      setScanAccess(null);
      setAccessError(normalizeCommandError(caughtError));
      setAccessGuideOpen(true);
    } finally {
      accessCheckInFlight.current = false;
      setCheckingAccess(false);
    }
  }, [loading, onScan]);

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
    if (loading) {
      onCancel();
      return;
    }
    void checkScanAccess(true);
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
    setAccessGuideOpen(false);
    setWaitingForAccess(false);
    setAccessError(null);
    onScan();
  };

  return (
    <section className={`panel cleanup-assistant${loading && !snapshot ? " is-scanning" : ""}`} aria-labelledby="cleanup-title">
      <header className="cleanup-assistant__header">
        <span className="cleanup-assistant__icon" aria-hidden="true">
          <ScanSearch size={20} />
        </span>
        <div>
          <span className="eyebrow">{t("cleanup:kicker")}</span>
          <h2 id="cleanup-title">{t("cleanup:title")}</h2>
          <p>{t("cleanup:description")}</p>
        </div>
        <button
          className="button button--secondary cleanup-assistant__scan"
          type="button"
          disabled={cancelling || checkingAccess}
          onClick={requestScan}
        >
          {loading
            ? cancelling ? <RefreshCw className="is-spinning" size={15} /> : <Square size={13} />
            : checkingAccess ? <RefreshCw className="is-spinning" size={15} /> : <ScanSearch size={15} />}
          {checkingAccess
            ? t("cleanup:access.checking")
            : loading
              ? cancelling ? t("cleanup:cancelling") : t("cleanup:cancelScan")
            : snapshot
              ? t("cleanup:scanAgain")
              : t("cleanup:startScan")}
        </button>
      </header>

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

      {loading && progress ? (
        <div className="cleanup-progress" role="status" aria-live="polite">
          <div className="cleanup-progress__indicator"><i /></div>
          <div className="cleanup-progress__content">
            <span><RefreshCw className="is-spinning" size={15} /></span>
            <div>
              <strong>{t("cleanup:progress.scanningLocation", { location: progressLocation })}</strong>
              <details>
                <summary>{t("cleanup:progress.showPath")}</summary>
                <code title={progress.currentPath}>{progress.currentPath}</code>
              </details>
            </div>
          </div>
          <dl>
            <div><dt>{t("cleanup:progress.entries")}</dt><dd>{progress.scannedEntryCount.toLocaleString(i18n.resolvedLanguage)}</dd></div>
            <div><dt>{t("cleanup:progress.discovered")}</dt><dd>{formatBytes(progress.discoveredBytes)}</dd></div>
            <div><dt>{t("cleanup:progress.elapsed")}</dt><dd>{Math.max(0.1, progress.elapsedMs / 1_000).toFixed(1)}s</dd></div>
          </dl>
        </div>
      ) : !snapshot && !error && !accessGuideOpen ? (
        <div className="cleanup-assistant__intro">
          <Eye size={18} />
          <div>
            <strong>{t("cleanup:readOnlyTitle")}</strong>
            <span>{t("cleanup:readOnlyDescription")}</span>
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

          <CleanupSpaceMap
            snapshot={snapshot}
            snapshotStatus={snapshotStatus}
            onDeletionApplied={onDeletionApplied}
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
                      <span><AppWindow size={16} /></span>
                      <div>
                        <strong>{application.name}</strong>
                        <small>{t("cleanup:applications.lastUsed", {
                          date: new Date(application.lastUsedAtMs ?? 0).toLocaleDateString(i18n.resolvedLanguage),
                          days: inactiveDays ?? 0,
                        })}</small>
                      </div>
                      <strong>{formatBytes(application.sizeBytes)}</strong>
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
