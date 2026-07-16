import type {
  ProcessHistoryPoint,
  ProcessRow,
  ProcessSortKey,
  ProcessViewMode,
  SortDirection,
  SystemSnapshot,
} from "./types";
import { processIdentity } from "./utils";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "./storageMigration";

export const PROCESS_EXPLORER_STORAGE_KEY =
  "core-robin.process-explorer.preferences.v1";
export const PROCESS_HISTORY_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_PROCESS_HISTORY_POINTS = 300;

const MAX_QUERY_LENGTH = 256;
const MAX_EXPANDED_IDENTITIES = 512;

export interface ProcessExplorerPreferences {
  version: 1;
  viewMode: ProcessViewMode;
  query: string;
  sortKey: ProcessSortKey;
  sortDirection: SortDirection;
  expandedIdentities: string[];
  followSelection: boolean;
}

export interface VisibleProcessRow {
  identity: string;
  process: ProcessRow;
  parentIdentity: string | null;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  queryMatch: boolean;
}

export interface ProcessTreeProjection {
  rows: VisibleProcessRow[];
  includedCount: number;
  matchCount: number;
}

export interface SelectedProcessHistory {
  identity: string;
  pid: number;
  name: string;
  lastSequence: number;
  missing: boolean;
  points: ProcessHistoryPoint[];
}

export interface VirtualRange {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}

interface ProcessTreeIndex {
  processByIdentity: Map<string, ProcessRow>;
  parentByIdentity: Map<string, string>;
}

export function defaultProcessExplorerPreferences(): ProcessExplorerPreferences {
  return {
    version: 1,
    viewMode: "flat",
    query: "",
    sortKey: "cpu",
    sortDirection: "descending",
    expandedIdentities: [],
    followSelection: true,
  };
}

export function parseProcessExplorerPreferences(
  serialized: string | null,
): ProcessExplorerPreferences {
  const fallback = defaultProcessExplorerPreferences();
  if (!serialized) return fallback;

  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1) return fallback;

    const expandedIdentities = Array.isArray(value.expandedIdentities)
      ? Array.from(
          new Set(
            value.expandedIdentities.filter(
              (identity): identity is string =>
                typeof identity === "string" &&
                identity.length > 0 &&
                identity.length <= 512,
            ),
          ),
        ).slice(-MAX_EXPANDED_IDENTITIES)
      : [];

    return {
      version: 1,
      viewMode: isProcessViewMode(value.viewMode) ? value.viewMode : fallback.viewMode,
      query:
        typeof value.query === "string"
          ? value.query.slice(0, MAX_QUERY_LENGTH)
          : fallback.query,
      sortKey: isProcessSortKey(value.sortKey) ? value.sortKey : fallback.sortKey,
      sortDirection: isSortDirection(value.sortDirection)
        ? value.sortDirection
        : fallback.sortDirection,
      expandedIdentities,
      followSelection:
        typeof value.followSelection === "boolean"
          ? value.followSelection
          : fallback.followSelection,
    };
  } catch {
    return fallback;
  }
}

export function loadProcessExplorerPreferences(): ProcessExplorerPreferences {
  try {
    return parseProcessExplorerPreferences(
      readMigratedStorageItem(
        window.localStorage,
        PROCESS_EXPLORER_STORAGE_KEY,
        LEGACY_STORAGE_KEYS.processExplorer,
      ),
    );
  } catch {
    return defaultProcessExplorerPreferences();
  }
}

export function saveProcessExplorerPreferences(
  preferences: ProcessExplorerPreferences,
): void {
  try {
    const sanitized = parseProcessExplorerPreferences(
      JSON.stringify(preferences),
    );
    window.localStorage.setItem(
      PROCESS_EXPLORER_STORAGE_KEY,
      JSON.stringify(sanitized),
    );
  } catch {
    // Private browsing and hardened WebViews may reject local storage. The
    // in-memory preferences remain fully functional for the current session.
  }
}

export function pruneExpandedIdentities(
  expandedIdentities: readonly string[],
  processes: readonly ProcessRow[],
): string[] {
  const liveIdentities = new Set(processes.map(processIdentity));
  return Array.from(
    new Set(
      expandedIdentities.filter(
        (identity) =>
          identity.length > 0 &&
          identity.length <= 512 &&
          liveIdentities.has(identity),
      ),
    ),
  ).slice(-MAX_EXPANDED_IDENTITIES);
}

export function buildProcessTreeProjection(
  processes: readonly ProcessRow[],
  query: string,
  sortKey: ProcessSortKey,
  direction: SortDirection,
  expandedIdentities: ReadonlySet<string>,
  selectedIdentity: string | null,
  followSelection: boolean,
): ProcessTreeProjection {
  const { processByIdentity, parentByIdentity } = buildProcessTreeIndex(processes);

  const childrenByIdentity = new Map<string, ProcessRow[]>();
  const roots: ProcessRow[] = [];
  for (const process of processes) {
    const identity = processIdentity(process);
    const parentIdentity = parentByIdentity.get(identity);
    if (!parentIdentity) {
      roots.push(process);
      continue;
    }
    const children = childrenByIdentity.get(parentIdentity) ?? [];
    children.push(process);
    childrenByIdentity.set(parentIdentity, children);
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const queryMatches = new Set<string>();
  for (const process of processes) {
    if (!normalizedQuery || processMatchesQuery(process, normalizedQuery)) {
      queryMatches.add(processIdentity(process));
    }
  }

  const included = new Set<string>();
  if (!normalizedQuery) {
    for (const identity of processByIdentity.keys()) included.add(identity);
  } else {
    for (const matchIdentity of queryMatches) {
      addIdentityAndAncestors(matchIdentity, parentByIdentity, included);
    }
  }

  const forcedExpanded = new Set<string>();
  if (normalizedQuery) {
    for (const matchIdentity of queryMatches) {
      addAncestors(matchIdentity, parentByIdentity, forcedExpanded);
    }
  }
  if (
    followSelection &&
    selectedIdentity !== null &&
    included.has(selectedIdentity)
  ) {
    addAncestors(selectedIdentity, parentByIdentity, forcedExpanded);
  }

  const rows: VisibleProcessRow[] = [];
  const visited = new Set<string>();
  const stack = sortProcesses(roots, sortKey, direction)
    .reverse()
    .map((process) => ({ process, depth: 0 }));
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    const { process, depth } = entry;
    const identity = processIdentity(process);
    if (visited.has(identity) || !included.has(identity)) continue;
    visited.add(identity);

    const children = sortProcesses(
      (childrenByIdentity.get(identity) ?? []).filter((child) =>
        included.has(processIdentity(child)),
      ),
      sortKey,
      direction,
    );
    const hasChildren = children.length > 0;
    const expanded =
      hasChildren &&
      (forcedExpanded.has(identity) || expandedIdentities.has(identity));
    rows.push({
      identity,
      process,
      parentIdentity: parentByIdentity.get(identity) ?? null,
      depth,
      hasChildren,
      expanded,
      queryMatch: queryMatches.has(identity),
    });

    if (expanded) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) stack.push({ process: child, depth: depth + 1 });
      }
    }
  }

  return {
    rows,
    includedCount: included.size,
    matchCount: normalizedQuery ? queryMatches.size : processes.length,
  };
}

export function expandableProcessTreeRootIdentities(
  processes: readonly ProcessRow[],
): string[] {
  const { processByIdentity, parentByIdentity } = buildProcessTreeIndex(processes);
  const rootsWithChildren = new Set<string>();
  for (const parentIdentity of parentByIdentity.values()) {
    if (!parentByIdentity.has(parentIdentity)) rootsWithChildren.add(parentIdentity);
  }
  return [...rootsWithChildren]
    .filter((identity) => processByIdentity.has(identity))
    .sort(compareIdentities);
}

function buildProcessTreeIndex(
  processes: readonly ProcessRow[],
): ProcessTreeIndex {
  const processByIdentity = new Map<string, ProcessRow>();
  const identitiesByPid = new Map<number, string[]>();
  for (const process of processes) {
    const identity = processIdentity(process);
    processByIdentity.set(identity, process);
    const identities = identitiesByPid.get(process.pid) ?? [];
    identities.push(identity);
    identitiesByPid.set(process.pid, identities);
  }

  const parentByIdentity = new Map<string, string>();
  for (const process of processes) {
    const identity = processIdentity(process);
    if (process.parentPid === null || process.parentPid === process.pid) continue;

    const parentCandidates = identitiesByPid.get(process.parentPid) ?? [];
    if (parentCandidates.length !== 1) continue;
    const [parentIdentity] = parentCandidates;
    if (parentIdentity === undefined) continue;
    const parent = processByIdentity.get(parentIdentity);
    if (!parent || parent.startTime > process.startTime) continue;
    parentByIdentity.set(identity, parentIdentity);
  }
  breakParentCycles(parentByIdentity, processByIdentity);
  return { processByIdentity, parentByIdentity };
}

export function buildFlatProcessRows(
  processes: readonly ProcessRow[],
  query: string,
  sortKey: ProcessSortKey,
  direction: SortDirection,
): VisibleProcessRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return sortProcesses(
    processes.filter(
      (process) =>
        !normalizedQuery || processMatchesQuery(process, normalizedQuery),
    ),
    sortKey,
    direction,
  ).map((process) => ({
    identity: processIdentity(process),
    process,
    parentIdentity: null,
    depth: 0,
    hasChildren: false,
    expanded: false,
    queryMatch: true,
  }));
}

export function updateSelectedProcessHistory(
  current: SelectedProcessHistory | null,
  snapshot: SystemSnapshot | null,
  selectedIdentity: string | null,
): SelectedProcessHistory | null {
  if (!snapshot || !selectedIdentity) return null;

  const selected = snapshot.processes.find(
    (process) => processIdentity(process) === selectedIdentity,
  );
  if (!selected) {
    if (current?.identity !== selectedIdentity) return null;
    return current.missing ? current : { ...current, missing: true };
  }

  const continuing = current?.identity === selectedIdentity ? current : null;
  if (continuing && snapshot.sequence <= continuing.lastSequence) return current;

  const point: ProcessHistoryPoint = {
    sequence: snapshot.sequence,
    timestamp: snapshot.sampledAtMs,
    cpuPercent: selected.cpuPercent,
    memoryBytes: selected.memoryBytes,
    diskReadBytesPerSecond: selected.diskReadBytesPerSecond,
    diskWriteBytesPerSecond: selected.diskWriteBytesPerSecond,
  };
  const priorPoints = continuing?.points ?? [];
  const cutoff = snapshot.sampledAtMs - PROCESS_HISTORY_WINDOW_MS;
  const points = [...priorPoints, point]
    .filter((candidate) => candidate.timestamp >= cutoff)
    .slice(-MAX_PROCESS_HISTORY_POINTS);

  return {
    identity: selectedIdentity,
    pid: selected.pid,
    name: selected.name,
    lastSequence: snapshot.sequence,
    missing: false,
    points,
  };
}

export function computeVirtualRange(
  itemCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 6,
): VirtualRange {
  if (
    !Number.isFinite(itemCount) ||
    !Number.isFinite(rowHeight) ||
    itemCount <= 0 ||
    rowHeight <= 0
  ) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const safeItemCount = Math.floor(itemCount);
  const safeViewportHeight = Number.isFinite(viewportHeight)
    ? Math.max(0, viewportHeight)
    : 0;
  const windowHeight = Math.max(rowHeight, safeViewportHeight);
  const maximumScrollTop = Math.max(
    0,
    safeItemCount * rowHeight - windowHeight,
  );
  const requestedScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const safeScrollTop = Math.min(
    maximumScrollTop,
    Math.max(0, requestedScrollTop),
  );
  const safeOverscan = Number.isFinite(overscan)
    ? Math.max(0, Math.floor(overscan))
    : 0;
  const visibleStart = Math.min(
    safeItemCount,
    Math.floor(safeScrollTop / rowHeight),
  );
  const visibleEnd = Math.ceil(
    (safeScrollTop + windowHeight) / rowHeight,
  );
  const start = Math.max(0, visibleStart - safeOverscan);
  const end = Math.min(safeItemCount, visibleEnd + safeOverscan);
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: Math.max(0, (itemCount - end) * rowHeight),
  };
}

function processMatchesQuery(process: ProcessRow, normalizedQuery: string): boolean {
  return [process.name, String(process.pid), process.user ?? "", process.status]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

function sortProcesses(
  processes: readonly ProcessRow[],
  sortKey: ProcessSortKey,
  direction: SortDirection,
): ProcessRow[] {
  const multiplier = direction === "ascending" ? 1 : -1;
  return [...processes].sort((left, right) => {
    let comparison = 0;
    switch (sortKey) {
      case "name":
        comparison = left.name.localeCompare(right.name);
        break;
      case "memory":
        comparison = left.memoryBytes - right.memoryBytes;
        break;
      case "disk":
        comparison = compareNullableMetrics(
          nullableMetric(left, "disk"),
          nullableMetric(right, "disk"),
        );
        break;
      case "cpu":
        comparison = compareNullableMetrics(
          nullableMetric(left, "cpu"),
          nullableMetric(right, "cpu"),
        );
        break;
    }
    if (comparison !== 0) return comparison * multiplier;
    return processIdentity(left).localeCompare(processIdentity(right));
  });
}

function nullableMetric(
  process: ProcessRow,
  metric: "cpu" | "disk",
): number | null {
  if (metric === "cpu") return process.cpuPercent;
  if (
    process.diskReadBytesPerSecond === null &&
    process.diskWriteBytesPerSecond === null
  ) {
    return null;
  }
  return (
    (process.diskReadBytesPerSecond ?? 0) +
    (process.diskWriteBytesPerSecond ?? 0)
  );
}

function compareNullableMetrics(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left - right;
}

function breakParentCycles(
  parentByIdentity: Map<string, string>,
  processByIdentity: ReadonlyMap<string, ProcessRow>,
): void {
  const completed = new Set<string>();
  const identities = [...processByIdentity.keys()].sort(compareIdentities);
  for (const startIdentity of identities) {
    if (completed.has(startIdentity)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = startIdentity;
    while (current && !completed.has(current)) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart).sort(compareIdentities);
        const [cycleRoot] = cycle;
        if (cycleRoot !== undefined) parentByIdentity.delete(cycleRoot);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = parentByIdentity.get(current);
    }
    for (const identity of path) completed.add(identity);
  }
}

function compareIdentities(left: string, right: string): number {
  return left.localeCompare(right);
}

function addIdentityAndAncestors(
  identity: string,
  parentByIdentity: ReadonlyMap<string, string>,
  target: Set<string>,
): void {
  const seen = new Set<string>();
  let current: string | undefined = identity;
  while (current && !seen.has(current)) {
    seen.add(current);
    target.add(current);
    current = parentByIdentity.get(current);
  }
}

function addAncestors(
  identity: string,
  parentByIdentity: ReadonlyMap<string, string>,
  target: Set<string>,
): void {
  const seen = new Set<string>([identity]);
  let current = parentByIdentity.get(identity);
  while (current && !seen.has(current)) {
    seen.add(current);
    target.add(current);
    current = parentByIdentity.get(current);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessViewMode(value: unknown): value is ProcessViewMode {
  return value === "flat" || value === "tree";
}

function isProcessSortKey(value: unknown): value is ProcessSortKey {
  return value === "cpu" || value === "memory" || value === "disk" || value === "name";
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "ascending" || value === "descending";
}
