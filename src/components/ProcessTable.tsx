import {
  Activity,
  ArrowDown,
  ArrowDownUp,
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
  UserX,
  X,
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
import { useAppTranslation } from "../i18n/useAppTranslation";
import { processApplicationIconSource } from "../applicationIcon";

import {
  buildFlatProcessRows,
  buildProcessTreeProjection,
  computeVirtualRange,
  expandableProcessTreeRootIdentities,
  indexProcessPorts,
  matchingProcessPort,
  reconcileStableProcessOrder,
  type VisibleProcessRow,
} from "../processExplorer";
import type {
  NetworkConnection,
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
  resourceUsageLevel,
  statusLabel,
} from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";

interface ProcessTableProps {
  processes: ProcessRow[];
  connections?: readonly NetworkConnection[];
  selectedIdentity: string | null;
  onSelect: (process: ProcessRow) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sortKey: ProcessSortKey;
  direction: SortDirection;
  onSortChange: (sortKey: ProcessSortKey, direction: SortDirection) => void;
  liveSort?: boolean;
  onLiveSortChange?: (enabled: boolean) => void;
  viewMode?: ProcessViewMode;
  onViewModeChange?: (viewMode: ProcessViewMode) => void;
  expandedIdentities?: string[];
  onExpandedIdentitiesChange?: (identities: string[]) => void;
  followSelection?: boolean;
  onFollowSelectionChange?: (enabled: boolean) => void;
  onResetPreferences?: () => void;
  orphanOnly?: boolean;
  onOrphanOnlyChange?: (enabled: boolean) => void;
  compact?: boolean;
}

const ROW_HEIGHT = 38;
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
  connections = [],
  selectedIdentity,
  onSelect,
  query,
  onQueryChange,
  sortKey,
  direction,
  onSortChange,
  liveSort = false,
  onLiveSortChange,
  viewMode = "flat",
  onViewModeChange,
  expandedIdentities = [],
  onExpandedIdentitiesChange,
  followSelection = true,
  onFollowSelectionChange,
  onResetPreferences,
  orphanOnly = false,
  onOrphanOnlyChange,
  compact = false,
}: ProcessTableProps) {
  const { t } = useAppTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rowButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusIdentity = useRef<string | null>(null);
  const activeRowFocusIdentity = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(340);
  const [focusedIdentity, setFocusedIdentity] = useState<string | null>(null);
  const [orderRevision, setOrderRevision] = useState(0);
  const stableOrderRef = useRef<{
    sortKey: ProcessSortKey;
    direction: SortDirection;
    revision: number;
    identities: string[];
  } | null>(null);
  const effectiveViewMode: ProcessViewMode = compact ? "flat" : viewMode;
  const portsByPid = useMemo(
    () => indexProcessPorts(connections),
    [connections],
  );
  const identityOrder = useMemo(() => {
    const previous = stableOrderRef.current;
    const forceResort =
      liveSort ||
      previous === null ||
      previous.sortKey !== sortKey ||
      previous.direction !== direction ||
      previous.revision !== orderRevision;
    const identities = reconcileStableProcessOrder(
      previous?.identities ?? [],
      processes,
      sortKey,
      direction,
      forceResort,
    );
    stableOrderRef.current = {
      sortKey,
      direction,
      revision: orderRevision,
      identities,
    };
    return new Map(
      identities.map((identity, index) => [identity, index]),
    );
  }, [direction, liveSort, orderRevision, processes, sortKey]);
  const projectionContext = useMemo(
    () => ({ identityOrder, portsByPid }),
    [identityOrder, portsByPid],
  );

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
            projectionContext,
            orphanOnly,
          )
        : null,
    [
      direction,
      effectiveViewMode,
      expandedIdentities,
      followSelection,
      orphanOnly,
      processes,
      projectionContext,
      query,
      selectedIdentity,
      sortKey,
    ],
  );
  const allRows = useMemo(
    () =>
      treeProjection?.rows ??
      buildFlatProcessRows(
        processes,
        query,
        sortKey,
        direction,
        projectionContext,
        orphanOnly,
      ),
    [
      direction,
      orphanOnly,
      processes,
      projectionContext,
      query,
      sortKey,
      treeProjection,
    ],
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
    if (effectiveViewMode === "tree" && onExpandedIdentitiesChange) {
      const nextExpanded = new Set(expandedIdentities);
      for (const identity of expandableProcessTreeRootIdentities(processes)) {
        nextExpanded.add(identity);
      }
      if (nextExpanded.size !== expandedIdentities.length) {
        onExpandedIdentitiesChange([...nextExpanded]);
      }
    }
    const nextDirection =
      nextSortKey === sortKey && direction === "descending"
        ? "ascending"
        : "descending";
    setOrderRevision((current) => current + 1);
    onSortChange(nextSortKey, nextDirection);
  };

  const showTreeView = () => {
    const nextExpanded = new Set(expandedIdentities);
    for (const identity of expandableProcessTreeRootIdentities(processes)) {
      nextExpanded.add(identity);
    }
    if (nextExpanded.size !== expandedIdentities.length) {
      onExpandedIdentitiesChange?.([...nextExpanded]);
    }
    onViewModeChange?.("tree");
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
            <span className="eyebrow">{t("process:realtime")}</span>
            <h2 id="process-title">
              {compact ? t("process:topProcesses") : t("process:allProcesses")}
            </h2>
          </div>
          {!compact ? (
            <div className="process-view-controls" aria-label={t("process:viewSettings")}>
              <div className="segmented-control" aria-label={t("process:viewMode")}>
                <button
                  type="button"
                  aria-pressed={effectiveViewMode === "flat"}
                  title={t("process:flatTitle")}
                  onClick={() => onViewModeChange?.("flat")}
                >
                  <List size={14} />{t("process:flat")}
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveViewMode === "tree"}
                  title={t("process:treeTitle")}
                  onClick={showTreeView}
                >
                  <ListTree size={14} />{t("process:tree")}
                </button>
              </div>
              <button
                className="process-tool-button"
                type="button"
                aria-pressed={followSelection}
                title={t("process:followTitle")}
                onClick={() => onFollowSelectionChange?.(!followSelection)}
              >
                <LocateFixed size={14} />{t("process:follow")}
              </button>
              <button
                className="process-tool-button"
                type="button"
                aria-pressed={orphanOnly}
                title={t("process:orphan.filterTitle")}
                onClick={() => onOrphanOnlyChange?.(!orphanOnly)}
              >
                <UserX size={14} />{t("process:orphan.filter")}
              </button>
              <button
                className="process-tool-button"
                type="button"
                aria-pressed={liveSort}
                title={t("process:liveSortTitle")}
                onClick={() => onLiveSortChange?.(!liveSort)}
              >
                <Activity size={14} />{t("process:liveSort")}
              </button>
              <button
                className="process-tool-button process-tool-button--icon"
                type="button"
                aria-label={t("process:resort")}
                title={t("process:resort")}
                onClick={() => setOrderRevision((current) => current + 1)}
              >
                <ArrowDownUp size={14} />
              </button>
              <button
                className="process-tool-button process-tool-button--icon"
                type="button"
                aria-label={t("process:resetView")}
                title={t("process:resetView")}
                onClick={() => {
                  setOrderRevision((current) => current + 1);
                  onQueryChange("");
                  onResetPreferences?.();
                }}
              >
                <RotateCcw size={14} />
              </button>
            </div>
          ) : null}
        </div>
        <div className="search-field" role="search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label={t("process:search")}
            value={query}
            maxLength={256}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.preventDefault();
              onQueryChange("");
            }}
            placeholder={t("process:searchPlaceholder")}
            spellCheck={false}
          />
          {query ? (
            <>
              <kbd>{matchCount}</kbd>
              <button
                className="search-field__clear"
                type="button"
                aria-label={t("process:clearSearch")}
                title={t("process:clearSearch")}
                onClick={() => onQueryChange("")}
              >
                <X size={13} />
              </button>
            </>
          ) : <kbd>⌘K</kbd>}
        </div>
      </div>

      <div
        className="process-table"
        role={effectiveViewMode === "tree" ? "treegrid" : "grid"}
        aria-label={t("process:systemProcesses")}
        aria-rowcount={rows.length + 1}
        aria-colcount={6}
      >
        <div className="process-table__header process-grid" role="row">
          <span
            role="columnheader"
            aria-sort={sortAriaValue("name", sortKey, direction)}
          >
            <button type="button" onClick={() => requestSort("name")}>
              {t("process:columns.process")} {sortIcon("name")}
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
              {t("process:columns.memory")} {sortIcon("memory")}
            </button>
          </span>
          <span
            role="columnheader"
            aria-sort={sortAriaValue("disk", sortKey, direction)}
          >
            <button type="button" onClick={() => requestSort("disk")}>
              {t("process:columns.disk")} {sortIcon("disk")}
            </button>
          </span>
          <span role="columnheader">{t("process:columns.status")}</span>
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
            const matchedPort = matchingProcessPort(
              query,
              process.pid,
              portsByPid,
            );
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
                        aria-label={t(
                          row.expanded ? "process:collapse" : "process:expand",
                          { name: process.name || t("common:unnamedProcess") },
                        )}
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
                  <ApplicationAvatar
                    name={process.name}
                    source={processApplicationIconSource(process)}
                    className="process-application-avatar"
                  />
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
                    {process.name || t("common:unnamedProcess")}
                  </button>
                  {matchedPort !== null ? (
                    <span
                      className="background-task-chip process-port-match tabular"
                      title={t("process:matchedPort", { port: matchedPort })}
                      style={{ minHeight: 0, padding: "2px 5px" }}
                    >
                      :{matchedPort}
                    </span>
                  ) : null}
                  {process.protected ? (
                    <ShieldCheck size={13} aria-label={t("process:protected")} />
                  ) : null}
                </span>
                <span className="tabular" role="gridcell">
                  {process.pid}
                </span>
                <span
                  className={`tabular resource-usage resource-usage--${resourceUsageLevel(
                    process.cpuPercent,
                    [10, 50, 100],
                  )}`}
                  role="gridcell"
                >
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
            <div className="process-empty">{t("process:noMatches")}</div>
          ) : null}
        </div>
      </div>

      <footer className="process-footer">
        {compact ? (
          <span>
            {t("process:footer.compact", {
              visible: rows.length,
              total: allRows.length,
            })}
          </span>
        ) : effectiveViewMode === "tree" ? (
          <span>
            {t("process:footer.tree", {
              visible: rows.length,
              matches: matchCount,
              total: processes.length,
            })}
          </span>
        ) : (
          <span>
            {t("process:footer.flat", {
              visible: rows.length,
              total: processes.length,
            })}
          </span>
        )}
        {!compact ? (
          <span>
            {t(
              liveSort
                ? "process:footer.liveOrder"
                : "process:footer.stableOrder",
            )}
          </span>
        ) : null}
        {selectionFiltered ? (
          <button type="button" onClick={() => onQueryChange("")}>
            {t("process:footer.selectionFiltered")}
          </button>
        ) : null}
      </footer>
    </section>
  );
}
