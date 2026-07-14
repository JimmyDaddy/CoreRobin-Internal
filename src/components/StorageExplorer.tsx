import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  HardDrive,
  Usb,
} from "lucide-react";
import { useMemo } from "react";

import {
  sortVolumesByUsage,
  storageHistorySegments,
  storageHistoryWindow,
  topDiskProcesses,
  type StorageSeriesPoint,
} from "../storageExplorer";
import type {
  DiskSnapshot,
  HistoryPoint,
  ProcessRow,
} from "../types";
import {
  formatBytes,
  formatRate,
  processIdentity,
} from "../utils";

interface StorageExplorerProps {
  disk: DiskSnapshot;
  history: HistoryPoint[];
  processes: ProcessRow[];
  selectedIdentity: string | null;
  onSelectProcess: (process: ProcessRow) => void;
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
}: StorageExplorerProps) {
  const volumes = useMemo(
    () => sortVolumesByUsage(disk.volumes),
    [disk.volumes],
  );
  const diskProcesses = useMemo(
    () => topDiskProcesses(processes),
    [processes],
  );
  const highestUsage = volumes[0];

  return (
    <section className="storage-explorer" aria-labelledby="storage-title">
      <section className="panel storage-overview">
        <header className="storage-overview__heading">
          <div>
            <span className="eyebrow">本机存储</span>
            <h2 id="storage-title">容量与磁盘活动</h2>
            <p>卷容量来自当前系统快照；吞吐按真实采样间隔换算。</p>
          </div>
          <span className="storage-overview__badge">
            <HardDrive size={14} />{volumes.length} 个卷
          </span>
        </header>

        <div className="storage-summary" aria-label="存储摘要">
          <StorageSummaryItem
            icon={ArrowDownToLine}
            label="当前读取"
            value={formatRate(disk.readBytesPerSecond)}
            tone="read"
          />
          <StorageSummaryItem
            icon={ArrowUpFromLine}
            label="当前写入"
            value={formatRate(disk.writeBytesPerSecond)}
            tone="write"
          />
          <StorageSummaryItem
            icon={HardDrive}
            label="最高占用"
            value={
              highestUsage
                ? `${highestUsage.usagePercent.toFixed(0)}%`
                : "无可用卷"
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
            <span className="eyebrow">文件系统容量</span>
            <h2 id="volume-title">卷</h2>
          </div>
          <span>按占用率排序</span>
        </header>

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
                    <strong title={volume.name}>{volume.name || "未命名卷"}</strong>
                    <code title={volume.mountPoint}>{volume.mountPoint}</code>
                  </span>
                  {volume.removable ? <small>可移除</small> : null}
                </header>
                <div className="volume-capacity">
                  <strong>{formatBytes(usedBytes)}</strong>
                  <span>/ {formatBytes(volume.totalBytes)}</span>
                  <b>{usagePercent.toFixed(0)}%</b>
                </div>
                <span
                  className="volume-track"
                  role="progressbar"
                  aria-label={`${volume.name || volume.mountPoint} 已用空间`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usagePercent)}
                >
                  <i style={{ width: `${usagePercent}%` }} />
                </span>
                <footer>
                  <span>可用 {formatBytes(volume.availableBytes)}</span>
                  {lowSpace ? (
                    <span className="volume-warning">
                      <AlertTriangle size={12} />空间偏紧
                    </span>
                  ) : null}
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="storage-empty">
            <HardDrive size={20} />当前没有可展示的卷。
          </div>
        )}
      </section>

      <section
        className="panel storage-process-panel"
        aria-labelledby="storage-process-title"
      >
        <header className="storage-section-heading">
          <div>
            <span className="eyebrow">当前快照</span>
            <h2 id="storage-process-title">磁盘活动最高的进程</h2>
          </div>
          <span>点击后在右侧核验详情</span>
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
                    <span className="storage-process-name">
                      <strong>{process.name || "未命名进程"}</strong>
                      <small>PID {process.pid}</small>
                    </span>
                    <span>
                      <small>读取</small>
                      <strong>{formatRate(process.diskReadBytesPerSecond)}</strong>
                    </span>
                    <span>
                      <small>写入</small>
                      <strong>{formatRate(process.diskWriteBytesPerSecond)}</strong>
                    </span>
                    <span className="storage-process-total">
                      <small>合计</small>
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
            <Activity size={20} />正在等待进程磁盘活动基线…
          </div>
        )}
      </section>
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
          <span className="eyebrow">最近 5 分钟</span>
          <h2 id="storage-history-title">磁盘吞吐</h2>
        </div>
        <div className="storage-history__legend" aria-label="吞吐图例">
          <span><i className="is-read" />读取 {formatRate(disk.readBytesPerSecond)}</span>
          <span><i className="is-write" />写入 {formatRate(disk.writeBytesPerSecond)}</span>
        </div>
      </header>

      {points.length < 2 ? (
        <div className="storage-history__empty">
          <span className="pulse-dot" />正在建立磁盘吞吐基线…
        </div>
      ) : (
        <>
          <svg
            className="storage-history__chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`磁盘读取 ${formatRate(disk.readBytesPerSecond)}，写入 ${formatRate(disk.writeBytesPerSecond)}`}
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
            <text x="0" y="172">−5 分钟</text>
            <text x={CHART_WIDTH} y="172" textAnchor="end">现在</text>
          </svg>
          <div className="storage-history__peaks">
            <span>读取峰值 <strong>{formatRate(readPeak)}</strong></span>
            <span>写入峰值 <strong>{formatRate(writePeak)}</strong></span>
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
