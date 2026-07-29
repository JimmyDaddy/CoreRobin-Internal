import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Unplug,
  Usb,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { processApplicationIconSource } from "../applicationIcon";
import "./StorageExplorer.css";
import {
  ejectRemovableVolume,
  getStorageHealth,
  openDiskUtility,
} from "../api";

import {
  sortVolumesByUsage,
  storageHistorySegments,
  storageHistoryWindow,
  topDiskProcesses,
  type StorageSeriesPoint,
} from "../storageExplorer";
import type { UsageThresholds } from "../settings";
import type {
  DiskSnapshot,
  HistoryPoint,
  ProcessRow,
  StorageHealthSnapshot,
} from "../types";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import {
  formatBytes,
  formatRate,
  normalizeCommandError,
  processIdentity,
  resourceUsageLevel,
} from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";

interface StorageExplorerProps {
  disk: DiskSnapshot;
  history: HistoryPoint[];
  processes: ProcessRow[];
  selectedIdentity: string | null;
  onSelectProcess: (process: ProcessRow) => void;
  usageThresholds: UsageThresholds;
  onOpenCleanup: () => void;
  onVolumeEjected?: () => void | Promise<void>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (
    id: string,
    input: CompleteUserActionInput,
  ) => void;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 176;
const CHART_TOP = 12;
const CHART_BOTTOM = 148;

export function StorageExplorer({
  disk,
  history,
  processes,
  selectedIdentity,
  onSelectProcess,
  usageThresholds,
  onOpenCleanup,
  onVolumeEjected,
  onUserActionStart,
  onUserActionComplete,
}: StorageExplorerProps) {
  const { t } = useAppTranslation();
  const [confirmingMountPoint, setConfirmingMountPoint] = useState<string | null>(null);
  const [ejectingMountPoint, setEjectingMountPoint] = useState<string | null>(null);
  const [ejectNotice, setEjectNotice] = useState<string | null>(null);
  const [ejectError, setEjectError] = useState<string | null>(null);
  const [storageHealth, setStorageHealth] =
    useState<StorageHealthSnapshot | null>(null);
  const [storageHealthLoading, setStorageHealthLoading] = useState(false);
  const [storageHealthError, setStorageHealthError] = useState<string | null>(null);
  const [retryingHealthMountPoint, setRetryingHealthMountPoint] =
    useState<string | null>(null);
  const [openingDiskUtility, setOpeningDiskUtility] = useState(false);
  const volumes = useMemo(
    () => sortVolumesByUsage(disk.volumes),
    [disk.volumes],
  );
  const diskProcesses = useMemo(
    () => topDiskProcesses(processes),
    [processes],
  );
  const highestUsage = volumes[0];
  const mountPointSignature = disk.volumes
    .map((volume) => volume.mountPoint)
    .sort()
    .join("\u0000");

  useEffect(() => {
    let active = true;
    const mountPoints = mountPointSignature
      ? mountPointSignature.split("\u0000")
      : [];
    if (mountPoints.length === 0) {
      setStorageHealth(null);
      return;
    }
    setStorageHealthLoading(true);
    setStorageHealthError(null);
    void getStorageHealth(mountPoints)
      .then((snapshot) => {
        if (active) setStorageHealth(snapshot);
      })
      .catch((caughtError) => {
        if (active) setStorageHealthError(normalizeCommandError(caughtError).message);
      })
      .finally(() => {
        if (active) setStorageHealthLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mountPointSignature]);

  const launchDiskUtility = async () => {
    if (openingDiskUtility) return;
    setOpeningDiskUtility(true);
    setStorageHealthError(null);
    try {
      await openDiskUtility();
    } catch (caughtError) {
      setStorageHealthError(normalizeCommandError(caughtError).message);
    } finally {
      setOpeningDiskUtility(false);
    }
  };
  const retryStorageDevice = async (mountPoint: string) => {
    if (retryingHealthMountPoint) return;
    setRetryingHealthMountPoint(mountPoint);
    setStorageHealthError(null);
    try {
      const refreshed = await getStorageHealth([mountPoint], true);
      setStorageHealth((current) => {
        if (!current || refreshed.devices.length === 0) return refreshed;
        const replacement = refreshed.devices[0]!;
        return {
          sampledAtMs: refreshed.sampledAtMs,
          devices: current.devices.map((device) =>
            device.mountPoint === mountPoint ? replacement : device
          ),
        };
      });
    } catch (caughtError) {
      setStorageHealthError(normalizeCommandError(caughtError).message);
    } finally {
      setRetryingHealthMountPoint(null);
    }
  };
  const ejectVolume = async (mountPoint: string, name: string) => {
    const actionId = onUserActionStart?.({
      kind: "volume_eject",
      targetName: name || mountPoint,
      targetCount: 1,
    });
    setEjectingMountPoint(mountPoint);
    setEjectError(null);
    setEjectNotice(null);
    try {
      await ejectRemovableVolume(mountPoint);
      if (actionId) {
        onUserActionComplete?.(actionId, {
          status: "succeeded",
          verification: "verified",
          targetCount: 1,
          failedCount: 0,
        });
      }
      setConfirmingMountPoint(null);
      setEjectNotice(t("storage:eject.success", { name: name || mountPoint }));
    } catch (caughtError) {
      if (actionId) {
        onUserActionComplete?.(actionId, {
          status: "failed",
          verification: "not_confirmed",
          targetCount: 0,
          failedCount: 1,
        });
      }
      const error = normalizeCommandError(caughtError);
      setEjectError(t(
        error.code === "volume_not_removable"
          ? "storage:eject.noLongerRemovable"
          : "storage:eject.failed",
      ));
      return;
    } finally {
      setEjectingMountPoint(null);
    }
    // The operating-system action has already completed. A transient monitor
    // refresh failure must not turn a successful eject into a false failure.
    try {
      await onVolumeEjected?.();
    } catch {
      // The next scheduled monitor sample will reconcile the visible list.
    }
  };

  return (
    <section className="storage-explorer" aria-labelledby="storage-title">
      <section className="panel storage-overview">
        <header className="storage-overview__heading">
          <div>
            <span className="eyebrow">{t("storage:local")}</span>
            <h2 id="storage-title">{t("storage:title")}</h2>
            <p>{t("storage:description")}</p>
          </div>
          <div className="storage-overview__actions">
            <span className="storage-overview__badge">
              <HardDrive size={14} />{t("storage:volumeCount", { count: volumes.length })}
            </span>
            <button className="button button--primary storage-overview__cleanup" type="button" onClick={onOpenCleanup}>
              <Sparkles size={14} />{t("storage:openCleanup")}
            </button>
          </div>
        </header>

        <div className="storage-summary" aria-label={t("storage:summary")}>
          <StorageSummaryItem
            icon={ArrowDownToLine}
            label={t("storage:currentRead")}
            value={formatRate(disk.readBytesPerSecond)}
            tone="read"
          />
          <StorageSummaryItem
            icon={ArrowUpFromLine}
            label={t("storage:currentWrite")}
            value={formatRate(disk.writeBytesPerSecond)}
            tone="write"
          />
          <StorageSummaryItem
            icon={HardDrive}
            label={t("storage:highestUsage")}
            value={
              highestUsage
                ? `${highestUsage.usagePercent.toFixed(0)}%`
                : t("storage:noVolume")
            }
            context={highestUsage?.volume.name}
            tone={highestUsage?.lowSpace ? "warning" : "capacity"}
          />
        </div>
      </section>

      <StorageThroughput history={history} disk={disk} />

      <section className="panel volume-panel" aria-labelledby="volume-title">
        <header className="storage-section-heading">
          <div>
            <span className="eyebrow">{t("storage:filesystemCapacity")}</span>
            <h2 id="volume-title">{t("storage:volumes")}</h2>
          </div>
          <span>{t("storage:sortedByUsage")}</span>
        </header>

        {ejectNotice ? <div className="volume-eject-notice" role="status">{ejectNotice}</div> : null}
        {ejectError ? <div className="volume-eject-error" role="alert"><AlertTriangle size={14} />{ejectError}</div> : null}

        {volumes.length > 0 ? (
          <div className="volume-grid">
            {volumes.map(({ volume, usedBytes, usagePercent, lowSpace }) => (
              <article
                className={`volume-card${lowSpace ? " volume-card--warning" : ""}`}
                key={`${volume.name}:${volume.mountPoint}`}
              >
                <header>
                  <span className="volume-icon" aria-hidden="true">
                    {volume.removable ? <Usb size={16} /> : <HardDrive size={16} />}
                  </span>
                  <span>
                    <strong title={volume.name}>{volume.name || t("storage:unnamedVolume")}</strong>
                    <code title={volume.mountPoint}>{volume.mountPoint}</code>
                  </span>
                  {volume.removable ? <small>{t("storage:removable")}</small> : null}
                </header>
                <div className="volume-capacity">
                  <strong>{formatBytes(usedBytes)}</strong>
                  <span>/ {formatBytes(volume.totalBytes)}</span>
                  <b className={`resource-usage resource-usage--${resourceUsageLevel(usagePercent, usageThresholds)}`}>{usagePercent.toFixed(0)}%</b>
                </div>
                <span
                  className="volume-track"
                  role="progressbar"
                  aria-label={t("storage:usedSpace", { name: volume.name || volume.mountPoint })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usagePercent)}
                >
                  <i style={{ width: `${usagePercent}%` }} />
                </span>
                <footer>
                  <span>{t("storage:available", { value: formatBytes(volume.availableBytes) })}</span>
                  {lowSpace ? (
                    <span className="volume-warning">
                      <AlertTriangle size={12} />{t("storage:lowSpace")}
                    </span>
                  ) : null}
                  {volume.removable ? (
                    <span className="volume-eject-actions">
                      {confirmingMountPoint === volume.mountPoint ? (
                        <>
                          <button
                            className="button button--secondary volume-eject-confirm"
                            type="button"
                            disabled={ejectingMountPoint !== null}
                            onClick={() => void ejectVolume(volume.mountPoint, volume.name)}
                          >
                            {ejectingMountPoint === volume.mountPoint
                              ? <LoaderCircle className="is-spinning" size={13} />
                              : <Unplug size={13} />}
                            {ejectingMountPoint === volume.mountPoint
                              ? t("storage:eject.ejecting")
                              : t("storage:eject.confirm")}
                          </button>
                          <button
                            className="icon-button volume-eject-cancel"
                            type="button"
                            disabled={ejectingMountPoint !== null}
                            aria-label={t("common:cancel")}
                            title={t("common:cancel")}
                            onClick={() => setConfirmingMountPoint(null)}
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <button
                          className="button button--secondary volume-eject"
                          type="button"
                          disabled={ejectingMountPoint !== null}
                          onClick={() => {
                            setEjectError(null);
                            setEjectNotice(null);
                            setConfirmingMountPoint(volume.mountPoint);
                          }}
                        >
                          <Unplug size={13} />{t("storage:eject.action")}
                        </button>
                      )}
                    </span>
                  ) : null}
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="storage-empty">
            <HardDrive size={20} />{t("storage:noDisplayVolumes")}
          </div>
        )}
      </section>

      <StorageHealthPanel
        snapshot={storageHealth}
        volumes={disk.volumes}
        loading={storageHealthLoading}
        error={storageHealthError}
        openingUtility={openingDiskUtility}
        retryingMountPoint={retryingHealthMountPoint}
        onOpenUtility={() => void launchDiskUtility()}
        onRetry={(mountPoint) => void retryStorageDevice(mountPoint)}
      />

      <section
        className="panel storage-process-panel"
        aria-labelledby="storage-process-title"
      >
        <header className="storage-section-heading">
          <div>
            <span className="eyebrow">{t("storage:snapshot")}</span>
            <h2 id="storage-process-title">{t("storage:topProcesses")}</h2>
          </div>
          <span>{t("storage:inspectHint")}</span>
        </header>

        {diskProcesses.length > 0 ? (
          <ol className="storage-process-list">
            {diskProcesses.map(({ process, totalBytesPerSecond }, index) => {
              const identity = processIdentity(process);
              return (
                <li key={identity}>
                  <button
                    type="button"
                    className={identity === selectedIdentity ? "is-selected" : ""}
                    aria-pressed={identity === selectedIdentity}
                    onClick={() => onSelectProcess(process)}
                  >
                    <span className="storage-process-rank">{index + 1}</span>
                    <ApplicationAvatar
                      name={process.name}
                      source={processApplicationIconSource(process)}
                      className="storage-process-avatar"
                    />
                    <span className="storage-process-name">
                      <strong>{process.name || t("common:unnamedProcess")}</strong>
                      <small>PID {process.pid}</small>
                    </span>
                    <span>
                      <small>{t("common:read")}</small>
                      <strong>{formatRate(process.diskReadBytesPerSecond)}</strong>
                    </span>
                    <span>
                      <small>{t("common:write")}</small>
                      <strong>{formatRate(process.diskWriteBytesPerSecond)}</strong>
                    </span>
                    <span className="storage-process-total">
                      <small>{t("common:total")}</small>
                      <strong>{formatRate(totalBytesPerSecond)}</strong>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="storage-empty">
            <Activity size={20} />{t("storage:waitingProcessIo")}
          </div>
        )}
      </section>
    </section>
  );
}

function StorageHealthPanel({
  snapshot,
  volumes,
  loading,
  error,
  openingUtility,
  retryingMountPoint,
  onOpenUtility,
  onRetry,
}: {
  snapshot: StorageHealthSnapshot | null;
  volumes: DiskSnapshot["volumes"];
  loading: boolean;
  error: string | null;
  openingUtility: boolean;
  retryingMountPoint: string | null;
  onOpenUtility: () => void;
  onRetry: (mountPoint: string) => void;
}) {
  const { t } = useAppTranslation();
  const risky = snapshot?.devices.some((device) =>
    device.smartStatus === "warning"
    || device.smartStatus === "failing"
    || device.inspectionError !== null) ?? false;
  return (
    <section className="panel storage-health" aria-labelledby="storage-health-title">
      <header className="storage-section-heading">
        <div>
          <span className="eyebrow">{t("storage:health.eyebrow")}</span>
          <h2 id="storage-health-title">{t("storage:health.title")}</h2>
          <p>{t("storage:health.description")}</p>
        </div>
        {risky ? (
          <button className="button button--secondary" type="button" disabled={openingUtility} onClick={onOpenUtility}>
            {openingUtility ? <LoaderCircle className="is-spinning" size={14} /> : <HardDrive size={14} />}
            {t("storage:health.openUtility")}
          </button>
        ) : null}
      </header>
      {error ? <div className="volume-eject-error" role="alert"><AlertTriangle size={14} />{error}</div> : null}
      {loading && !snapshot ? (
        <div className="storage-health__loading" role="status">
          <RefreshCw className="is-spinning" size={15} />
          {t("storage:health.loading")}
        </div>
      ) : (
        <div className="storage-health__grid">
          {(snapshot?.devices ?? []).map((device) => {
            const volume = volumes.find((candidate) => candidate.mountPoint === device.mountPoint);
            return (
              <article className={`is-${device.smartStatus}`} key={device.mountPoint}>
                <header>
                  <span>{device.smartStatus === "verified" ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}</span>
                  <div>
                    <strong>{volume?.name || device.mountPoint}</strong>
                    <code>{device.source ?? device.mountPoint}</code>
                  </div>
                  <small>{t(`storage:health.status.${device.smartStatus}`)}</small>
                </header>
                <dl>
                  <div><dt>{t("storage:health.filesystem")}</dt><dd>{device.filesystem ?? "—"}</dd></div>
                  <div><dt>{t("storage:health.mountMode")}</dt><dd>{device.readOnly === null ? "—" : t(device.readOnly ? "storage:health.readOnly" : "storage:health.readWrite")}</dd></div>
                  <div><dt>{t("storage:health.media")}</dt><dd>{device.solidState === null ? t(device.internal === false ? "storage:health.external" : "storage:health.unknownMedia") : t(device.solidState ? "storage:health.ssd" : "storage:health.hdd")}</dd></div>
                  <div><dt>{t("storage:health.purgeable")}</dt><dd>{device.purgeableBytes === null ? "—" : formatBytes(device.purgeableBytes)}</dd></div>
                </dl>
                <footer className="storage-health__device-footer">
                  <small>
                    {device.cached
                      ? t("storage:health.cached")
                      : t("storage:health.updatedNow")}
                  </small>
                  {device.inspectionError ? (
                    <>
                      <p>{t("storage:health.inspectUnavailable")}</p>
                      <button
                        className="button button--secondary"
                        type="button"
                        disabled={retryingMountPoint !== null}
                        onClick={() => onRetry(device.mountPoint)}
                      >
                        {retryingMountPoint === device.mountPoint
                          ? <LoaderCircle className="is-spinning" size={12} />
                          : <RefreshCw size={12} />}
                        {t("storage:health.retry")}
                      </button>
                    </>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      )}
      <small className="storage-health__scope">{t("storage:health.scope")}</small>
    </section>
  );
}

interface StorageSummaryItemProps {
  icon: typeof HardDrive;
  label: string;
  value: string;
  context?: string;
  tone: "read" | "write" | "capacity" | "warning";
}

function StorageSummaryItem({
  icon: Icon,
  label,
  value,
  context,
  tone,
}: StorageSummaryItemProps) {
  return (
    <div className={`storage-summary__item storage-summary__item--${tone}`}>
      <Icon size={16} aria-hidden="true" />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        {context ? <em>{context}</em> : null}
      </span>
    </div>
  );
}

function StorageThroughput({
  history,
  disk,
}: {
  history: HistoryPoint[];
  disk: DiskSnapshot;
}) {
  const { t } = useAppTranslation();
  const points = storageHistoryWindow(history);
  const readSegments = storageHistorySegments(points, "read");
  const writeSegments = storageHistorySegments(points, "write");
  const values = [...readSegments, ...writeSegments].flatMap((segment) =>
    segment.map((point) => point.value),
  );
  const maximum = Math.max(1, ...values);
  const windowEnd = points[points.length - 1]?.timestamp ?? 0;
  const windowStart = windowEnd - 5 * 60 * 1_000;
  const readPeak = Math.max(
    0,
    ...readSegments.flatMap((segment) => segment.map((point) => point.value)),
  );
  const writePeak = Math.max(
    0,
    ...writeSegments.flatMap((segment) => segment.map((point) => point.value)),
  );

  return (
    <section className="panel storage-history" aria-labelledby="storage-history-title">
      <header className="storage-section-heading">
        <div>
          <span className="eyebrow">{t("common:fiveMinutes")}</span>
          <h2 id="storage-history-title">{t("storage:throughput")}</h2>
        </div>
        <div className="storage-history__legend" aria-label={t("storage:throughputLegend")}>
          <span><i className="is-read" />{t("common:read")} {formatRate(disk.readBytesPerSecond)}</span>
          <span><i className="is-write" />{t("common:write")} {formatRate(disk.writeBytesPerSecond)}</span>
        </div>
      </header>

      {points.length < 2 ? (
        <div className="storage-history__empty">
          <span className="live-status-dot" />{t("storage:establishingBaseline")}
        </div>
      ) : (
        <>
          <svg
            className="storage-history__chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t("storage:chartLabel", {
              read: formatRate(disk.readBytesPerSecond),
              write: formatRate(disk.writeBytesPerSecond),
            })}
          >
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line
                className="storage-history__grid-line"
                key={ratio}
                x1="0"
                x2={CHART_WIDTH}
                y1={CHART_TOP + ratio * (CHART_BOTTOM - CHART_TOP)}
                y2={CHART_TOP + ratio * (CHART_BOTTOM - CHART_TOP)}
              />
            ))}
            {readSegments.map((segment, index) => (
              <path
                className="storage-history__line storage-history__line--read"
                d={storagePath(segment, windowStart, windowEnd, maximum)}
                key={`read-${index}`}
              />
            ))}
            {writeSegments.map((segment, index) => (
              <path
                className="storage-history__line storage-history__line--write"
                d={storagePath(segment, windowStart, windowEnd, maximum)}
                key={`write-${index}`}
              />
            ))}
            <text x="0" y="172">{t("common:fiveMinutesBack")}</text>
            <text x={CHART_WIDTH} y="172" textAnchor="end">{t("common:now")}</text>
          </svg>
          <div className="storage-history__peaks">
            <span>{t("storage:readPeak")} <strong>{formatRate(readPeak)}</strong></span>
            <span>{t("storage:writePeak")} <strong>{formatRate(writePeak)}</strong></span>
          </div>
        </>
      )}
    </section>
  );
}

function storagePath(
  segment: readonly StorageSeriesPoint[],
  windowStart: number,
  windowEnd: number,
  maximum: number,
): string {
  const duration = Math.max(1, windowEnd - windowStart);
  const commands = segment.map((point, index) => {
    const x = ((point.timestamp - windowStart) / duration) * CHART_WIDTH;
    const y = CHART_BOTTOM - (point.value / maximum) * (CHART_BOTTOM - CHART_TOP);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  if (commands.length === 1) commands.push("h0.01");
  return commands.join(" ");
}
