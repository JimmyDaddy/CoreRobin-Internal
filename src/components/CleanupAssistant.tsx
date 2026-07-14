import {
  AlertTriangle,
  AppWindow,
  ArchiveRestore,
  Boxes,
  Code2,
  Download,
  Eye,
  FileArchive,
  Files,
  FolderSearch,
  PieChart,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  CleanupLocationKind,
  CleanupScan,
  CleanupScanProgress,
  CommandError,
} from "../types";
import type { CleanupSnapshotStatus } from "../cleanupScanStore";
import { findUnusedApplications, unusedApplicationDays } from "../cleanupApplications";
import { formatBytes } from "../utils";
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
}: CleanupAssistantProps) {
  const { t, i18n } = useTranslation();
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
    : t("cleanup.progress.locations.personal");
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

  return (
    <section className={`panel cleanup-assistant${loading && !snapshot ? " is-scanning" : ""}`} aria-labelledby="cleanup-title">
      <header className="cleanup-assistant__header">
        <span className="cleanup-assistant__icon" aria-hidden="true">
          <ScanSearch size={20} />
        </span>
        <div>
          <span className="eyebrow">{t("cleanup.kicker")}</span>
          <h2 id="cleanup-title">{t("cleanup.title")}</h2>
          <p>{t("cleanup.description")}</p>
        </div>
        <button
          className="button button--secondary cleanup-assistant__scan"
          type="button"
          disabled={cancelling}
          onClick={loading ? onCancel : onScan}
        >
          {loading ? (cancelling ? <RefreshCw className="is-spinning" size={15} /> : <Square size={13} />) : <ScanSearch size={15} />}
          {loading
            ? cancelling ? t("cleanup.cancelling") : t("cleanup.cancelScan")
            : snapshot
              ? t("cleanup.scanAgain")
              : t("cleanup.startScan")}
        </button>
      </header>

      {loading && progress ? (
        <div className="cleanup-progress" role="status" aria-live="polite">
          <div className="cleanup-progress__indicator"><i /></div>
          <div className="cleanup-progress__content">
            <span><RefreshCw className="is-spinning" size={15} /></span>
            <div>
              <strong>{t("cleanup.progress.scanningLocation", { location: progressLocation })}</strong>
              <span>{t("cleanup.progress.title")}</span>
              <details>
                <summary>{t("cleanup.progress.showPath")}</summary>
                <code title={progress.currentPath}>{progress.currentPath}</code>
              </details>
            </div>
          </div>
          <dl>
            <div><dt>{t("cleanup.progress.entries")}</dt><dd>{progress.scannedEntryCount.toLocaleString(i18n.resolvedLanguage)}</dd></div>
            <div><dt>{t("cleanup.progress.discovered")}</dt><dd>{formatBytes(progress.discoveredBytes)}</dd></div>
            <div><dt>{t("cleanup.progress.elapsed")}</dt><dd>{Math.max(0.1, progress.elapsedMs / 1_000).toFixed(1)}s</dd></div>
          </dl>
          <p>{t("cleanup.progress.indeterminate")}</p>
        </div>
      ) : !snapshot && !error ? (
        <div className="cleanup-assistant__intro">
          <Eye size={18} />
          <div>
            <strong>{t("cleanup.readOnlyTitle")}</strong>
            <span>{t("cleanup.readOnlyDescription")}</span>
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
              <small>{t("cleanup.progress.foundSpace")}</small>
              <strong>{formatBytes(progress.discoveredBytes)}</strong>
            </div>
          </div>

          <div className="cleanup-scan-stage__story">
            <span className="eyebrow">{t("cleanup.progress.stageKicker")}</span>
            <h3 id="cleanup-scan-stage-title">{t("cleanup.progress.stageTitle")}</h3>
            <p>{t("cleanup.progress.stageDescription")}</p>
            <ol>
              <li className="is-active">
                <span><Files size={16} /></span>
                <div><strong>{t("cleanup.progress.steps.measure.title")}</strong><small>{t("cleanup.progress.steps.measure.description", { location: progressLocation })}</small></div>
                <i />
              </li>
              <li>
                <span><ShieldCheck size={16} /></span>
                <div><strong>{t("cleanup.progress.steps.classify.title")}</strong><small>{t("cleanup.progress.steps.classify.description")}</small></div>
              </li>
              <li>
                <span><PieChart size={16} /></span>
                <div><strong>{t("cleanup.progress.steps.map.title")}</strong><small>{t("cleanup.progress.steps.map.description")}</small></div>
              </li>
            </ol>
            <div className="cleanup-scan-stage__reassurance">
              <ShieldCheck size={16} />
              <div><strong>{t("cleanup.progress.reassuranceTitle")}</strong><span>{t("cleanup.progress.reassuranceDescription")}</span></div>
            </div>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="cleanup-assistant__error" role="alert">
          <AlertTriangle size={17} />
          <div><strong>{t("cleanup.failed")}</strong><span>{error.message}</span></div>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <div className="cleanup-assistant__summary">
            <span><ArchiveRestore size={17} /></span>
            <div>
              <small>{t("cleanup.reclaimableEstimate")}</small>
              <strong>{formatBytes(reclaimableBytes)}</strong>
              <em>{t("cleanup.estimateBoundary")}</em>
            </div>
            <div className="cleanup-assistant__scan-meta">
              <span className="cleanup-assistant__retained">{t("cleanup.snapshot.retained")}</span>
              <span>{t("cleanup.entriesScanned", { count: snapshot.scannedEntryCount })}</span>
              <span>{t("cleanup.scanDuration", { seconds: Math.max(0.1, snapshot.durationMs / 1_000).toFixed(1) })}</span>
              <span>{new Date(snapshot.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>

          <CleanupSpaceMap snapshot={snapshot} snapshotStatus={snapshotStatus} />

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
                      <strong>{t(`cleanup.locations.${location.kind}.title`)}</strong>
                      <small>{t(`cleanup.locations.${location.kind}.description`)}</small>
                    </div>
                    <em className={`is-${location.safety}`}>
                      {t(`cleanup.safety.${location.safety}`)}
                    </em>
                  </header>
                  <div className="cleanup-location__value">
                    <strong>{location.available ? formatBytes(location.sizeBytes) : "—"}</strong>
                    <span>{location.available ? t("cleanup.itemCount", { count: location.itemCount }) : t("cleanup.unavailable")}</span>
                  </div>
                  <code title={location.paths.join("\n")}>
                    {location.paths[0] ?? t("cleanup.pathUnavailable")}
                    {location.paths.length > 1 ? t("cleanup.morePaths", { count: location.paths.length - 1 }) : ""}
                  </code>
                </article>
              );
            })}
          </div>

          <section className="cleanup-applications" aria-labelledby="cleanup-applications-title">
            <header>
              <div>
                <span className="eyebrow">{t("cleanup.applications.kicker")}</span>
                <h3 id="cleanup-applications-title">{t("cleanup.applications.title")}</h3>
              </div>
              <span>{t("cleanup.applications.boundary")}</span>
            </header>
            {!snapshot.applicationInventoryAvailable ? (
              <div className="cleanup-applications__empty">{t("cleanup.applications.unavailable")}</div>
            ) : unusedApplications.length > 0 ? (
              <ol>
                {unusedApplications.map((application) => {
                  const inactiveDays = unusedApplicationDays(application, snapshot.sampledAtMs);
                  return (
                    <li key={application.path} title={application.path}>
                      <span><AppWindow size={16} /></span>
                      <div>
                        <strong>{application.name}</strong>
                        <small>{t("cleanup.applications.lastUsed", {
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
              <div className="cleanup-applications__empty">{t("cleanup.applications.none")}</div>
            )}
            {snapshot.applicationInventoryAvailable && unknownApplicationUseCount > 0 ? (
              <footer>{t("cleanup.applications.unknownExcluded", { count: unknownApplicationUseCount })}</footer>
            ) : null}
          </section>

          <section className="cleanup-largest" aria-labelledby="cleanup-largest-title">
            <header>
              <div>
                <span className="eyebrow">{t("cleanup.reviewFirst")}</span>
                <h3 id="cleanup-largest-title">{t("cleanup.largestFiles")}</h3>
              </div>
              <span>{t("cleanup.largeFileBoundary")}</span>
            </header>
            {snapshot.largestFiles.length > 0 ? (
              <ol>
                {snapshot.largestFiles.map((file) => (
                  <li key={file.path}>
                    <span><FileArchive size={15} /></span>
                    <div><strong>{file.name}</strong><code title={file.path}>{file.path}</code></div>
                    <small>{file.modifiedAtMs === null ? t("common.unknown") : new Date(file.modifiedAtMs).toLocaleDateString(i18n.resolvedLanguage)}</small>
                    <strong>{formatBytes(file.sizeBytes)}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="cleanup-largest__empty">{t("cleanup.noLargeFiles")}</div>
            )}
          </section>

          {snapshot.unreadableEntryCount > 0 ? (
            <div className="cleanup-assistant__notice">
              <AlertTriangle size={14} />
              <div>
                <strong>{t("cleanup.unreadable", { count: snapshot.unreadableEntryCount })}</strong>
                <span>{t("cleanup.fullDiskAccessHint")}</span>
                {snapshot.unreadablePaths.length > 0 ? (
                  <code title={snapshot.unreadablePaths.join("\n")}>{snapshot.unreadablePaths.join(" · ")}</code>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <footer className="cleanup-assistant__footer">
        <ShieldCheck size={14} />
        <span>{t("cleanup.safetyBoundary")}</span>
      </footer>
    </section>
  );
}

function cleanupProgressLocation(
  path: string,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const normalized = path.toLowerCase();
  if (normalized === "/applications" || normalized.endsWith("/applications")) {
    return t("cleanup.progress.locations.applications");
  }
  if (normalized.includes("downloads")) return t("cleanup.progress.locations.downloads");
  if (normalized.includes(".trash") || normalized.includes("/trash/")) return t("cleanup.progress.locations.trash");
  if (normalized.includes("library/caches")) return t("cleanup.progress.locations.appCache");
  if (/\/(\.cache|\.cargo|\.npm|\.pnpm|\.yarn|\.gradle|\.m2|\.bun|\.rustup)(\/|$)/.test(normalized)
    || normalized.includes("library/developer")
    || normalized.includes("library/pnpm")) {
    return t("cleanup.progress.locations.developerCache");
  }
  if (normalized.startsWith("~/.") || normalized.includes("/.")) return t("cleanup.progress.locations.hiddenData");
  return t("cleanup.progress.locations.personal");
}
