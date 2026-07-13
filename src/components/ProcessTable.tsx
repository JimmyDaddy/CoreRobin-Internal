import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Search,
  ShieldCheck,
} from "lucide-react";

import type {
  ProcessRow,
  ProcessSortKey,
  SortDirection,
} from "../types";
import {
  formatBytes,
  formatPercent,
  formatRate,
  processDiskRate,
  processIdentity,
  sortAndFilterProcesses,
  statusLabel,
} from "../utils";

interface ProcessTableProps {
  processes: ProcessRow[];
  selectedIdentity: string | null;
  onSelect: (process: ProcessRow) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sortKey: ProcessSortKey;
  direction: SortDirection;
  onSortChange: (sortKey: ProcessSortKey, direction: SortDirection) => void;
  compact?: boolean;
}

const MAX_ROWS = 250;

function activityClass(cpuPercent: number | null): string {
  if (cpuPercent === null || cpuPercent < 10) return "activity-dot--calm";
  if (cpuPercent < 70) return "activity-dot--warm";
  return "activity-dot--hot";
}

export function ProcessTable({
  processes,
  selectedIdentity,
  onSelect,
  query,
  onQueryChange,
  sortKey,
  direction,
  onSortChange,
  compact = false,
}: ProcessTableProps) {
  const orderedProcesses = sortAndFilterProcesses(processes, query, sortKey, direction);
  const visibleProcesses = orderedProcesses.slice(0, compact ? 9 : MAX_ROWS);

  const requestSort = (nextSortKey: ProcessSortKey) => {
    const nextDirection =
      nextSortKey === sortKey && direction === "descending" ? "ascending" : "descending";
    onSortChange(nextSortKey, nextDirection);
  };

  const sortIcon = (column: ProcessSortKey) => {
    if (column !== sortKey) return <ChevronsUpDown size={13} aria-hidden="true" />;
    return direction === "descending" ? (
      <ArrowDown size={13} aria-hidden="true" />
    ) : (
      <ArrowUp size={13} aria-hidden="true" />
    );
  };

  return (
    <section className={`panel process-panel${compact ? " process-panel--compact" : ""}`} aria-labelledby="process-title">
      <div className="process-toolbar">
        <div>
          <span className="eyebrow">实时采样</span>
          <h2 id="process-title">{compact ? "影响最大的进程" : "所有进程"}</h2>
        </div>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">搜索进程</span>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="名称、PID 或用户"
            spellCheck={false}
          />
          {query ? <kbd>{orderedProcesses.length}</kbd> : <kbd>⌘K</kbd>}
        </label>
      </div>

      <div className="process-table" role="table" aria-label="系统进程">
        <div className="process-table__header process-grid" role="row">
          <button type="button" onClick={() => requestSort("name")}>
            进程 {sortIcon("name")}
          </button>
          <span>PID</span>
          <button type="button" onClick={() => requestSort("cpu")}>
            CPU {sortIcon("cpu")}
          </button>
          <button type="button" onClick={() => requestSort("memory")}>
            内存 {sortIcon("memory")}
          </button>
          <button type="button" onClick={() => requestSort("disk")}>
            磁盘 I/O {sortIcon("disk")}
          </button>
          <span>状态</span>
        </div>

        <div className="process-table__body" role="rowgroup">
          {visibleProcesses.map((process) => {
            const identity = processIdentity(process);
            const selected = identity === selectedIdentity;
            return (
              <button
                type="button"
                role="row"
                className={`process-row process-grid${selected ? " is-selected" : ""}`}
                key={identity}
                aria-pressed={selected}
                onClick={() => onSelect(process)}
              >
                <span className="process-name" role="cell">
                  <i className={`activity-dot ${activityClass(process.cpuPercent)}`} aria-hidden="true" />
                  <span title={process.name}>{process.name || "未命名进程"}</span>
                  {process.protected ? <ShieldCheck size={13} aria-label="受保护" /> : null}
                </span>
                <span className="tabular" role="cell">{process.pid}</span>
                <span className="tabular" role="cell">{formatPercent(process.cpuPercent)}</span>
                <span className="tabular" role="cell">{formatBytes(process.memoryBytes)}</span>
                <span className="tabular" role="cell">{formatRate(processDiskRate(process))}</span>
                <span role="cell"><i className={`status-mark status-mark--${process.status.toLowerCase()}`} />{statusLabel(process.status)}</span>
              </button>
            );
          })}
          {visibleProcesses.length === 0 ? (
            <div className="process-empty">没有匹配的进程</div>
          ) : null}
        </div>
      </div>

      <footer className="process-footer">
        <span>显示 {visibleProcesses.length} / {orderedProcesses.length} 个进程</span>
        {!compact && orderedProcesses.length > MAX_ROWS ? (
          <span>为保持实时响应，当前仅展示前 {MAX_ROWS} 项</span>
        ) : null}
      </footer>
    </section>
  );
}
