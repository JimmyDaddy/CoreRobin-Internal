import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  List,
  ListTree,
  LocateFixed,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildFlatProcessRows,
  buildProcessTreeProjection,
  computeVirtualRange,
  type VisibleProcessRow,
} from "../processExplorer";
import type {
  ProcessRow,
  ProcessSortKey,
  ProcessViewMode,
  SortDirection,
} from "../types";
import {
  formatBytes,
  formatPercent,
  formatRate,
  processDiskRate,
  processIdentity,
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
  viewMode?: ProcessViewMode;
  onViewModeChange?: (viewMode: ProcessViewMode) => void;
  expandedIdentities?: string[];
  onExpandedIdentitiesChange?: (identities: string[]) => void;
  followSelection?: boolean;
  onFollowSelectionChange?: (enabled: boolean) => void;
  onResetPreferences?: () => void;
  compact?: boolean;
}

const ROW_HEIGHT = 34;
const OVERSCAN_ROWS = 6;
const COMPACT_ROWS = 9;

function activityClass(cpuPercent: number | null): string {
  if (cpuPercent === null || cpuPercent < 10) return "activity-dot--calm";
  if (cpuPercent < 70) return "activity-dot--warm";
  return "activity-dot--hot";
}

function sortAriaValue(
  column: ProcessSortKey,
  sortKey: ProcessSortKey,
  direction: SortDirection,
): "ascending" | "descending" | "none" {
  return column === sortKey ? direction : "none";
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
  viewMode = "flat",
  onViewModeChange,
  expandedIdentities = [],
  onExpandedIdentitiesChange,
  followSelection = true,
  onFollowSelectionChange,
  onResetPreferences,
  compact = false,
}: ProcessTableProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusIdentity = useRef<string | null>(null);
  const activeRowFocusIdentity = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(340);
  const [focusedIdentity, setFocusedIdentity] = useState<string | null>(null);
  const effectiveViewMode: ProcessViewMode = compact ? "flat" : viewMode;

  const treeProjection = useMemo(
    () =>
      effectiveViewMode === "tree"
        ? buildProcessTreeProjection(
            processes,
            query,
            sortKey,
            direction,
            new Set(expandedIdentities),
            selectedIdentity,
            followSelection,
          )
        : null,
    [
      direction,
      effectiveViewMode,
      expandedIdentities,
      followSelection,
      processes,
      query,
      selectedIdentity,
      sortKey,
    ],
  );
  const allRows = useMemo(
    () =>
      treeProjection?.rows ??
      buildFlatProcessRows(processes, query, sortKey, direction),
    [direction, processes, query, sortKey, treeProjection],
  );
  const rows = compact ? allRows.slice(0, COMPACT_ROWS) : allRows;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const updateViewport = () => setViewportHeight(body.clientHeight);
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.classList.contains("process-select-button")
      ) {
        activeRowFocusIdentity.current = null;
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  const virtualRange = compact
    ? {
        start: 0,
        end: rows.length,
        paddingTop: 0,
        paddingBottom: 0,
      }
    : computeVirtualRange(
        rows.length,
        ROW_HEIGHT,
        scrollTop,
        viewportHeight,
        OVERSCAN_ROWS,
      );
  const visibleRows = rows.slice(virtualRange.start, virtualRange.end);

  useLayoutEffect(() => {
    if (compact || !followSelection || query.trim()) return;
    const focusedTarget =
      activeRowFocusIdentity.current &&
      rows.some((row) => row.identity === activeRowFocusIdentity.current)
        ? activeRowFocusIdentity.current
        : null;
    const targetIdentity = focusedTarget ?? selectedIdentity;
    if (!targetIdentity) return;
    const selectedIndex = rows.findIndex((row) => row.identity === targetIdentity);
    const body = bodyRef.current;
    if (selectedIndex < 0 || !body) return;
    const rowTop = selectedIndex * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    let didScroll = false;
    if (rowTop < body.scrollTop) {
      body.scrollTop = rowTop;
      setScrollTop(rowTop);
      didScroll = true;
    } else if (rowBottom > body.scrollTop + body.clientHeight) {
      const nextScrollTop = rowBottom - body.clientHeight;
      body.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      didScroll = true;
    }
    if (didScroll && focusedTarget) pendingFocusIdentity.current = focusedTarget;
  }, [compact, followSelection, query, rows, selectedIdentity]);

  useLayoutEffect(() => {
    const identity = pendingFocusIdentity.current;
    if (!identity) return;
    const button = rowButtonRefs.current.get(identity);
    if (button) {
      pendingFocusIdentity.current = null;
      button.focus({ preventScroll: true });
    }
  }, [visibleRows]);

  useEffect(() => {
    if (
      focusedIdentity !== null &&
      !rows.some((row) => row.identity === focusedIdentity)
    ) {
      setFocusedIdentity(null);
    }
  }, [focusedIdentity, rows]);

  const requestSort = (nextSortKey: ProcessSortKey) => {
    const nextDirection =
      nextSortKey === sortKey && direction === "descending"
        ? "ascending"
        : "descending";
    onSortChange(nextSortKey, nextDirection);
  };

  const sortIcon = (column: ProcessSortKey) => {
    if (column !== sortKey) {
      return <ChevronsUpDown size={13} aria-hidden="true" />;
    }
    return direction === "descending" ? (
      <ArrowDown size={13} aria-hidden="true" />
    ) : (
      <ArrowUp size={13} aria-hidden="true" />
    );
  };

  const toggleExpanded = useCallback(
    (identity: string, expanded: boolean) => {
      if (!onExpandedIdentitiesChange) return;
      const next = new Set(expandedIdentities);
      if (expanded) next.add(identity);
      else next.delete(identity);
      onExpandedIdentitiesChange([...next]);
    },
    [expandedIdentities, onExpandedIdentitiesChange],
  );

  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      const body = bodyRef.current;
      if (!row || !body) return;
      const rowTop = index * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      let nextScrollTop = body.scrollTop;
      if (rowTop < body.scrollTop) nextScrollTop = rowTop;
      else if (rowBottom > body.scrollTop + body.clientHeight) {
        nextScrollTop = rowBottom - body.clientHeight;
      }
      if (nextScrollTop !== body.scrollTop) {
        body.scrollTop = nextScrollTop;
        setScrollTop(nextScrollTop);
      }
      pendingFocusIdentity.current = row.identity;
      setFocusedIdentity(row.identity);
      requestAnimationFrame(() => {
        const button = rowButtonRefs.current.get(row.identity);
        if (button) {
          pendingFocusIdentity.current = null;
          button.focus({ preventScroll: true });
        }
      });
    },
    [rows],
  );

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, row: VisibleProcessRow) => {
      const index = rows.findIndex((candidate) => candidate.identity === row.identity);
      if (index < 0) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusRow(Math.min(rows.length - 1, index + 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          focusRow(Math.max(0, index - 1));
          break;
        case "Home":
          event.preventDefault();
          focusRow(0);
          break;
        case "End":
          event.preventDefault();
          focusRow(rows.length - 1);
          break;
        case "ArrowRight":
          if (effectiveViewMode !== "tree") break;
          event.preventDefault();
          if (row.hasChildren && !row.expanded) {
            toggleExpanded(row.identity, true);
          } else if (
            row.expanded &&
            rows[index + 1]?.parentIdentity === row.identity
          ) {
            focusRow(index + 1);
          }
          break;
        case "ArrowLeft":
          if (effectiveViewMode !== "tree") break;
          event.preventDefault();
          if (row.hasChildren && row.expanded) {
            toggleExpanded(row.identity, false);
          } else if (row.parentIdentity) {
            const parentIndex = rows.findIndex(
              (candidate) => candidate.identity === row.parentIdentity,
            );
            if (parentIndex >= 0) focusRow(parentIndex);
          }
          break;
      }
    },
    [effectiveViewMode, focusRow, rows, toggleExpanded],
  );

  const visibleIdentitySet = new Set(visibleRows.map((row) => row.identity));
  const fallbackTabIdentity =
    (focusedIdentity && visibleIdentitySet.has(focusedIdentity)
      ? focusedIdentity
      : null) ??
    (selectedIdentity && visibleIdentitySet.has(selectedIdentity)
      ? selectedIdentity
      : visibleRows[0]?.identity ?? null);
  const selectionFiltered = Boolean(
    query.trim() &&
      selectedIdentity &&
      processes.some((process) => processIdentity(process) === selectedIdentity) &&
      !rows.some((row) => row.identity === selectedIdentity),
  );
  const matchCount = treeProjection?.matchCount ?? allRows.length;

  return (
    <section
      className={`panel process-panel${compact ? " process-panel--compact" : ""}`}
      aria-labelledby="process-title"
    >
      <div className="process-toolbar">
        <div className="process-heading">
          <div>
            <span className="eyebrow">实时采样</span>
            <h2 id="process-title">
              {compact ? "影响最大的进程" : "所有进程"}
            </h2>
          </div>
          {!compact ? (
            <div className="process-view-controls" aria-label="进程视图设置">
              <div className="segmented-control" aria-label="视图模式">
                <button
                  type="button"
                  aria-pressed={effectiveViewMode === "flat"}
                  title="平铺视图"
                  onClick={() => onViewModeChange?.("flat")}
                >
                  <List size={14} />平铺
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveViewMode === "tree"}
                  title="按父子关系显示；排序只作用于同级"
                  onClick={() => onViewModeChange?.("tree")}
                >
                  <ListTree size={14} />树形
                </button>
              </div>
              <button
                className="process-tool-button"
                type="button"
                aria-pressed={followSelection}
                title="刷新重排后保持选中进程在视野内"
                onClick={() => onFollowSelectionChange?.(!followSelection)}
              >
                <LocateFixed size={14} />跟随
              </button>
              <button
                className="process-tool-button process-tool-button--icon"
                type="button"
                aria-label="恢复默认进程视图"
                title="恢复默认进程视图"
                onClick={onResetPreferences}
              >
                <RotateCcw size={14} />
              </button>
            </div>
          ) : null}
        </div>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">搜索进程</span>
          <input
            value={query}
            maxLength={256}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="名称、PID 或用户"
            spellCheck={false}
          />
          {query ? <kbd>{matchCount}</kbd> : <kbd>⌘K</kbd>}
        </label>
      </div>

      <div
        className="process-table"
        role={effectiveViewMode === "tree" ? "treegrid" : "grid"}
        aria-label="系统进程"
        aria-rowcount={rows.length + 1}
        aria-colcount={6}
      >
        <div className="process-table__header process-grid" role="row">
          <span
            role="columnheader"
            aria-sort={sortAriaValue("name", sortKey, direction)}
          >
            <button type="button" onClick={() => requestSort("name")}>
              进程 {sortIcon("name")}
            </button>
          </span>
          <span role="columnheader">PID</span>
          <span
            role="columnheader"
            aria-sort={sortAriaValue("cpu", sortKey, direction)}
          >
            <button type="button" onClick={() => requestSort("cpu")}>
              CPU {sortIcon("cpu")}
            </button>
          </span>
          <span
            role="columnheader"
            aria-sort={sortAriaValue("memory", sortKey, direction)}
          >
            <button type="button" onClick={() => requestSort("memory")}>
              内存 {sortIcon("memory")}
            </button>
          </span>
          <span
            role="columnheader"
            aria-sort={sortAriaValue("disk", sortKey, direction)}
          >
            <button type="button" onClick={() => requestSort("disk")}>
              磁盘 I/O {sortIcon("disk")}
            </button>
          </span>
          <span role="columnheader">状态</span>
        </div>

        <div
          ref={bodyRef}
          className="process-table__body"
          role="rowgroup"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {virtualRange.paddingTop > 0 ? (
            <div
              className="process-virtual-space"
              style={{ height: virtualRange.paddingTop }}
              role="presentation"
            />
          ) : null}
          {visibleRows.map((row, visibleIndex) => {
            const { process, identity } = row;
            const selected = identity === selectedIdentity;
            const rowIndex = virtualRange.start + visibleIndex;
            const treeRowProps =
              effectiveViewMode === "tree"
                ? {
                    "aria-level": row.depth + 1,
                    ...(row.hasChildren
                      ? { "aria-expanded": row.expanded }
                      : {}),
                  }
                : {};
            return (
              <div
                role="row"
                className={`process-row process-grid${
                  selected ? " is-selected" : ""
                }${row.queryMatch && query.trim() ? " is-query-match" : ""}`}
                key={identity}
                aria-rowindex={rowIndex + 2}
                aria-selected={selected}
                onClick={() => onSelect(process)}
                {...treeRowProps}
              >
                <span
                  className="process-name"
                  role="gridcell"
                  style={
                    {
                      "--tree-depth": Math.min(row.depth, 6),
                    } as CSSProperties
                  }
                >
                  {effectiveViewMode === "tree" ? (
                    row.hasChildren ? (
                      <button
                        className="tree-toggle"
                        type="button"
                        aria-label={`${row.expanded ? "折叠" : "展开"}${process.name || "未命名进程"}`}
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(identity, !row.expanded);
                        }}
                      >
                        {row.expanded ? (
                          <ChevronDown size={13} />
                        ) : (
                          <ChevronRight size={13} />
                        )}
                      </button>
                    ) : (
                      <span className="tree-toggle-spacer" aria-hidden="true" />
                    )
                  ) : null}
                  <i
                    className={`activity-dot ${activityClass(process.cpuPercent)}`}
                    aria-hidden="true"
                  />
                  <button
                    className="process-select-button"
                    type="button"
                    ref={(element) => {
                      if (element) rowButtonRefs.current.set(identity, element);
                      else rowButtonRefs.current.delete(identity);
                    }}
                    tabIndex={identity === fallbackTabIdentity ? 0 : -1}
                    title={process.name}
                    onFocus={() => {
                      activeRowFocusIdentity.current = identity;
                      setFocusedIdentity(identity);
                    }}
                    onKeyDown={(event) => handleRowKeyDown(event, row)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(process);
                    }}
                  >
                    {process.name || "未命名进程"}
                  </button>
                  {process.protected ? (
                    <ShieldCheck size={13} aria-label="受保护" />
                  ) : null}
                </span>
                <span className="tabular" role="gridcell">
                  {process.pid}
                </span>
                <span className="tabular" role="gridcell">
                  {formatPercent(process.cpuPercent)}
                </span>
                <span className="tabular" role="gridcell">
                  {formatBytes(process.memoryBytes)}
                </span>
                <span className="tabular" role="gridcell">
                  {formatRate(processDiskRate(process))}
                </span>
                <span role="gridcell">
                  <i
                    className={`status-mark status-mark--${process.status.toLowerCase()}`}
                  />
                  {statusLabel(process.status)}
                </span>
              </div>
            );
          })}
          {virtualRange.paddingBottom > 0 ? (
            <div
              className="process-virtual-space"
              style={{ height: virtualRange.paddingBottom }}
              role="presentation"
            />
          ) : null}
          {rows.length === 0 ? (
            <div className="process-empty">没有匹配的进程</div>
          ) : null}
        </div>
      </div>

      <footer className="process-footer">
        {compact ? (
          <span>
            显示 {rows.length} / {allRows.length} 个进程
          </span>
        ) : effectiveViewMode === "tree" ? (
          <span>
            可见 {rows.length} · 匹配 {matchCount} / {processes.length} 个进程
          </span>
        ) : (
          <span>
            {rows.length} / {processes.length} 个进程 · 按需渲染
          </span>
        )}
        {!compact && effectiveViewMode === "tree" ? (
          <span>按同级排序</span>
        ) : null}
        {selectionFiltered ? (
          <button type="button" onClick={() => onQueryChange("")}>
            选中进程被筛选隐藏 · 清除筛选
          </button>
        ) : null}
      </footer>
    </section>
  );
}
