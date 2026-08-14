import { AlertTriangle, ArrowDownUp, CheckCircle2, ChevronRight, CircleStop, Clock3, File, FolderOpen, Layers3, List, LoaderCircle, LockKeyhole, PieChart, Plus, RefreshCw, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  createCleanupDeleteLease,
  cancelCleanupDelete,
  executeCleanupDelete,
  getCleanupIndexedChildren,
  getCleanupIndexedDirectory,
  getCleanupPathState,
  releaseCleanupDeleteLease,
  setCleanupDeleteLeaseMode,
} from "../api";
import { cleanupPathChanged } from "../cleanupFreshness";
import {
  canCollectCleanupNode,
  cleanupNodeProtection,
  isInsideTrashPath,
  isTrashRootPath,
} from "../cleanupProtection";
import {
  applyRefreshedCleanupTargets,
  buildCleanupDeleteLeaseRequest,
  cleanupLeaseCanExecute,
} from "../cleanupDeleteFreshness";
import {
  buildCleanupHueMap,
  cleanupNodeVisual,
  collectCleanupPlanNode,
  isCleanupNodeCoveredByPlan,
  layoutCleanupMap,
  type CleanupMapNode,
} from "../cleanupMap";
import type { CleanupSnapshotStatus } from "../cleanupScanStore";
import {
  reconcileCleanupNodeAfterDeletion,
  type CleanupDeletionTargetSnapshot,
} from "../cleanupScanStore";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "../storageMigration";
import type { CleanupDeleteFailure, CleanupDeleteMode, CleanupDeleteProgress, CleanupScan, CleanupDeleteLease, CleanupProtectionReason, CleanupScanJobStatus, CommandError } from "../types";
import type {
  CompleteUserActionInput,
  StartUserActionInput,
} from "../userActionHistory";
import { formatBytes, normalizeCommandError } from "../utils";
import { CleanupSunburstCanvas } from "./CleanupSunburstCanvas";
import { CleanupDeleteDialog } from "./CleanupDeleteDialog";
import { PathActions } from "./PathActions";
import "./CleanupSpaceMapProtection.css";

interface CleanupSpaceMapProps {
  snapshot: CleanupScan;
  snapshotStatus: CleanupSnapshotStatus;
  command?: CleanupSpaceMapCommand | null;
  onCommandHandled?: (id: number) => void;
  onDeletionApplied: (
    targets: readonly CleanupDeletionTargetSnapshot[],
    invalidateSnapshot?: boolean,
  ) => Promise<void>;
  directoryRefreshStatus?: CleanupScanJobStatus | null;
  directoryRefreshError?: CommandError | null;
  onRefreshDirectory?: (directoryId: string) => void;
  onCancelDirectoryRefresh?: () => void;
  onReloadLatestSnapshot?: () => Promise<CleanupScan | null>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}

export type CleanupSpaceMapCommand =
  | {
      id: number;
      type: "focusLocation";
      locationKind: string;
    }
  | {
      id: number;
      type: "addPath";
      name: string;
      path: string;
      sizeBytes: number;
    };

interface CleanupDragState {
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  x: number;
  y: number;
  dragging: boolean;
  overDropzone: boolean;
  blocked: boolean;
  protectionReason: CleanupProtectionReason | null;
}

interface CleanupDeleteOutcome {
  deletedCount: number;
  deletedBytes: number;
  selectedLogicalBytes: number;
  selectedAllocatedBytes: number;
  availableBytesBefore: number | null;
  availableBytesAfter: number | null;
  mode: CleanupDeleteMode;
  failed: CleanupDeleteFailure[];
  cancelled: boolean;
}

function cleanupAvailableDelta(outcome: CleanupDeleteOutcome): number {
  if (
    outcome.availableBytesBefore === null
    || outcome.availableBytesAfter === null
  ) return 0;
  return Math.max(
    0,
    outcome.availableBytesAfter - outcome.availableBytesBefore,
  );
}

type CleanupMapMode = "path" | "category";
type CleanupPresentation = "map" | "list";

const CLEANUP_MAP_MODE_STORAGE_KEY = "core-robin.cleanup-map-mode.v1";

export const CleanupSpaceMap = memo(function CleanupSpaceMap({
  snapshot,
  snapshotStatus,
  command = null,
  onCommandHandled,
  onDeletionApplied,
  directoryRefreshStatus = null,
  directoryRefreshError = null,
  onRefreshDirectory = () => undefined,
  onCancelDirectoryRefresh = () => undefined,
  onReloadLatestSnapshot = async () => null,
  onUserActionStart,
  onUserActionComplete,
}: CleanupSpaceMapProps) {
  const { t } = useAppTranslation();
  const [loadedSubtrees, setLoadedSubtrees] = useState<Map<string, CleanupMapNode>>(
    () => new Map(),
  );
  const [pagedChildren, setPagedChildren] = useState<Map<string, CleanupMapNode[]>>(
    () => new Map(),
  );
  const [pageCursors, setPageCursors] = useState<Map<string, number | null>>(
    () => new Map(),
  );
  const [pagingDirectoryId, setPagingDirectoryId] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<CleanupMapMode>(readCleanupMapMode);
  const [presentation, setPresentation] = useState<CleanupPresentation>("map");
  const [listQuery, setListQuery] = useState("");
  const [listSort, setListSort] = useState<"size" | "name">("size");
  const [listDescending, setListDescending] = useState(true);
  const [listItems, setListItems] = useState<CleanupMapNode[]>([]);
  const [listCursor, setListCursor] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listError, setListError] = useState<CommandError | null>(null);
  const listRequestIdRef = useRef(0);
  const pathRoot = useMemo<CleanupMapNode>(
    () => materializeCleanupNode(snapshot.root, loadedSubtrees),
    [loadedSubtrees, snapshot.root],
  );
  const categoryRoot = useMemo<CleanupMapNode>(() => ({
    id: "cleanup-category-root",
    name: t("cleanup:map.categoryRoot"),
    path: null,
    sizeBytes: snapshot.locations.reduce((total, location) => total + location.sizeBytes, 0),
    logicalSizeBytes: snapshot.locations.reduce(
      (total, location) => total + location.nodes.reduce((sum, node) => sum + node.logicalSizeBytes, 0),
      0,
    ),
    allocatedSizeBytes: snapshot.locations.reduce((total, location) => total + location.sizeBytes, 0),
    itemCount: snapshot.locations.reduce((total, location) => total + location.itemCount, 0),
    safety: "review",
    kind: "folder",
    deletionProtected: true,
    protectionReason: "aggregate",
    hasChildren: true,
    children: snapshot.locations
      .filter((location) => location.available && (
        location.sizeBytes > 0 || location.nodes.some((node) => node.kind === "restricted")
      ))
      .map((location) => {
        const restrictedOnly = location.sizeBytes === 0 &&
          location.nodes.some((node) => node.kind === "restricted");
        return {
          id: `location:${location.kind}`,
          name: t(`cleanup:locations.${location.kind}.title`),
          path: null,
          sizeBytes: location.sizeBytes,
          logicalSizeBytes: location.nodes.reduce((total, node) => total + node.logicalSizeBytes, 0),
          allocatedSizeBytes: location.sizeBytes,
          itemCount: location.itemCount,
          safety: location.safety,
          kind: restrictedOnly ? "restricted" as const : "folder" as const,
          deletionProtected: true,
          protectionReason: restrictedOnly ? "restricted" as const : "aggregate" as const,
          hasChildren: location.nodes.length > 0,
          children: location.nodes.map((node) => materializeCleanupNode(node, loadedSubtrees)),
        };
      })
      .sort((left, right) => right.sizeBytes - left.sizeBytes),
  }), [loadedSubtrees, snapshot.locations, t]);
  const [externalPlanNodes, setExternalPlanNodes] =
    useState<Map<string, CleanupMapNode>>(() => new Map());
  const root = mapMode === "path" ? pathRoot : categoryRoot;
  const { nodes, parents, depths } = useMemo(
    () => indexTree(root, pagedChildren),
    [pagedChildren, root],
  );
  const planNodes = useMemo(() => {
    const pathNodes = indexTree(pathRoot, pagedChildren).nodes;
    for (const [id, node] of indexTree(categoryRoot).nodes) pathNodes.set(id, node);
    for (const [id, node] of externalPlanNodes) pathNodes.set(id, node);
    for (const node of listItems) pathNodes.set(node.id, node);
    return pathNodes;
  }, [categoryRoot, externalPlanNodes, listItems, pagedChildren, pathRoot]);
  const hueMap = useMemo(() => buildCleanupHueMap(root), [root]);
  const [focusId, setFocusId] = useState(root.id);
  const [selectedId, setSelectedId] = useState(root.id);
  const [plannedIds, setPlannedIds] = useState<Set<string>>(() => new Set());
  const [changedIds, setChangedIds] = useState<Set<string>>(() => new Set());
  const [validationRevision, setValidationRevision] = useState(0);
  const [dragState, setDragState] = useState<CleanupDragState | null>(null);
  const [blockedDropNodeId, setBlockedDropNodeId] = useState<string | null>(null);
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
  const [deleteOutcome, setDeleteOutcome] = useState<CleanupDeleteOutcome | null>(null);
  const [subtreeError, setSubtreeError] = useState<CommandError | null>(null);
  const dragStateRef = useRef<CleanupDragState | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const dragPreviewFrameRef = useRef(0);
  const blockedDropTimerRef = useRef(0);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const suppressNextClickRef = useRef(false);
  const deleteLeaseRef = useRef<CleanupDeleteLease | null>(null);
  const deleteRequestIdRef = useRef(0);
  const subtreeRequestIdRef = useRef(0);
  const activeScanIdRef = useRef(snapshot.scanId);
  const activeSampledAtRef = useRef(snapshot.sampledAtMs);
  const appliedRefreshJobRef = useRef<string | null>(null);
  const requestedFocusIdRef = useRef<string | null>(null);

  const retainLoadedSubtree = useCallback((subtree: CleanupMapNode) => {
    setLoadedSubtrees((current) => new Map(current).set(subtree.id, subtree));
    setPagedChildren((current) => {
      let anyChanged = false;
      const next = new Map(current);
      for (const [parentId, children] of current) {
        let parentChanged = false;
        const replaced = children.map((child) => {
          if (child.id !== subtree.id) return child;
          parentChanged = true;
          anyChanged = true;
          return subtree;
        });
        if (parentChanged) next.set(parentId, replaced);
      }
      return anyChanged ? next : current;
    });
  }, []);

  useEffect(() => {
    if (activeScanIdRef.current === snapshot.scanId) return;
    activeScanIdRef.current = snapshot.scanId;
    activeSampledAtRef.current = snapshot.sampledAtMs;
    subtreeRequestIdRef.current += 1;
    setLoadedSubtrees(new Map());
    setPagedChildren(new Map());
    setPageCursors(new Map());
    setPagingDirectoryId(null);
    setFocusId(root.id);
    setSelectedId(root.id);
    setPlannedIds(new Set());
    setExternalPlanNodes(new Map());
    requestedFocusIdRef.current = null;
    setChangedIds(new Set());
    setDeleteOutcome(null);
    setDeleteProgress(null);
    setDeleteCancelling(false);
    dragStateRef.current = null;
    setDragState(null);
    window.clearTimeout(blockedDropTimerRef.current);
    setBlockedDropNodeId(null);
    setSubtreeError(null);
    setListItems([]);
    setListCursor(null);
    setListError(null);
  }, [snapshot.scanId]);

  useEffect(() => {
    if (activeSampledAtRef.current === snapshot.sampledAtMs) return;
    activeSampledAtRef.current = snapshot.sampledAtMs;
    subtreeRequestIdRef.current += 1;
    setPagedChildren(new Map());
    setPageCursors(new Map());
    setPagingDirectoryId(null);
  }, [snapshot.sampledAtMs]);

  useEffect(() => {
    if (
      directoryRefreshStatus?.phase !== "completed"
      || !directoryRefreshStatus.target.targetPath
      || appliedRefreshJobRef.current === directoryRefreshStatus.jobId
    ) return;
    appliedRefreshJobRef.current = directoryRefreshStatus.jobId;
    const directoryId = directoryRefreshStatus.target.targetPath;
    const directoryChain = [directoryId];
    let ancestorId = parents.get(directoryId) ?? null;
    while (ancestorId && ancestorId !== root.id) {
      directoryChain.push(ancestorId);
      ancestorId = parents.get(ancestorId) ?? null;
    }
    let cancelled = false;
    void Promise.all(directoryChain.map((directoryId) => getCleanupIndexedDirectory({
      scanId: snapshot.scanId,
      directoryId,
    }))).then((directories) => {
      if (cancelled) return;
      setLoadedSubtrees(new Map(directories.map((directory) => [directory.id, directory])));
      setChangedIds((current) => {
        const next = new Set(current);
        next.delete(directoryId);
        return next;
      });
    }).catch((error) => {
      if (!cancelled) setSubtreeError(normalizeCommandError(error));
    });
    return () => {
      cancelled = true;
    };
  }, [
    directoryRefreshStatus?.jobId,
    directoryRefreshStatus?.phase,
    directoryRefreshStatus?.target.targetPath,
    parents,
    root.id,
    snapshot.scanId,
  ]);

  useEffect(() => {
    if (!command) return;
    if (command.type === "focusLocation") {
      const locationId = `location:${command.locationKind}`;
      requestedFocusIdRef.current = locationId;
      setMapMode("category");
      setFocusId(locationId);
      setSelectedId(locationId);
    } else {
      const nodeId = `quick-path:${command.path}`;
      const node: CleanupMapNode = {
        id: nodeId,
        name: command.name,
        path: command.path,
        sizeBytes: command.sizeBytes,
        logicalSizeBytes: command.sizeBytes,
        allocatedSizeBytes: command.sizeBytes,
        itemCount: 1,
        safety: "review",
        kind: "file",
        deletionProtected: false,
        protectionReason: null,
        hasChildren: false,
        children: [],
      };
      setExternalPlanNodes((current) => new Map(current).set(nodeId, node));
      setDeleteOutcome(null);
      setPlannedIds((current) => new Set(current).add(nodeId));
    }
    onCommandHandled?.(command.id);
  }, [command, onCommandHandled]);

  useEffect(() => {
    subtreeRequestIdRef.current += 1;
    const requestedFocusId = requestedFocusIdRef.current;
    requestedFocusIdRef.current = null;
    setFocusId(requestedFocusId ?? root.id);
    setSelectedId(requestedFocusId ?? root.id);
    setSubtreeError(null);
    try {
      window.localStorage.setItem(CLEANUP_MAP_MODE_STORAGE_KEY, mapMode);
    } catch {
      // The view remains switchable for this session when storage is unavailable.
    }
  }, [mapMode, root.id]);

  const focus = nodes.get(focusId) ?? root;
  const arcs = useMemo(() => layoutCleanupMap(focus), [focus]);
  const collectedIds = useMemo(
    () => {
      const focusCollected = isCleanupNodeCoveredByPlan(plannedIds, focus.id, parents);
      return new Set(
        arcs
          .filter((arc) => focusCollected || isCleanupNodeCoveredByPlan(plannedIds, arc.node.id, parents))
          .map((arc) => arc.node.id),
      );
    },
    [arcs, focus.id, parents, plannedIds],
  );
  const visibleNodes = useMemo(
    () => new Map(arcs.map((arc) => [arc.node.id, arc.node])),
    [arcs],
  );
  const listNodeMap = useMemo(
    () => new Map(listItems.map((node) => [node.id, node])),
    [listItems],
  );
  const selected = nodes.get(selectedId)
    ?? visibleNodes.get(selectedId)
    ?? listNodeMap.get(selectedId)
    ?? focus;
  const selectedDirectlyPlanned = plannedIds.has(selected.id);
  const selectedCollected = collectedIds.has(selected.id) ||
    isCleanupNodeCoveredByPlan(plannedIds, selected.id, parents);
  const directChildren = useMemo(
    () => [...focus.children].sort((left, right) => right.allocatedSizeBytes - left.allocatedSizeBytes || left.name.localeCompare(right.name)),
    [focus],
  );
  const extraChildren = pagedChildren.get(focus.id) ?? [];
  const legendChildren = useMemo(() => {
    const loadedLogicalBytes = extraChildren.reduce(
      (total, child) => total + child.logicalSizeBytes,
      0,
    );
    const loadedAllocatedBytes = extraChildren.reduce(
      (total, child) => total + child.allocatedSizeBytes,
      0,
    );
    const loadedItemCount = extraChildren.reduce(
      (total, child) => total + child.itemCount,
      0,
    );
    const remainingAggregates = directChildren
      .filter((child) => child.kind === "aggregate")
      .map((child) => {
        const logicalSizeBytes = Math.max(0, child.logicalSizeBytes - loadedLogicalBytes);
        const allocatedSizeBytes = Math.max(0, child.allocatedSizeBytes - loadedAllocatedBytes);
        const itemCount = Math.max(0, child.itemCount - loadedItemCount);
        return {
          ...child,
          sizeBytes: allocatedSizeBytes,
          logicalSizeBytes,
          allocatedSizeBytes,
          itemCount,
        };
      })
      .filter((child) => child.itemCount > 0 || child.allocatedSizeBytes > 0);
    return [
      ...directChildren.filter((child) => child.kind !== "aggregate"),
      ...extraChildren,
      ...remainingAggregates,
    ];
  }, [directChildren, extraChildren]);
  const implicitPageCursor = directChildren.some(
    (child) => child.kind === "aggregate" && child.id.endsWith("#other-items"),
  )
    ? directChildren.filter((child) => child.kind !== "aggregate").length
    : null;
  const nextPageCursor = pageCursors.has(focus.id)
    ? pageCursors.get(focus.id) ?? null
    : implicitPageCursor;
  const canPageFocus = Boolean(
    snapshot.indexed
    && focus.id.startsWith(`index:${snapshot.scanId}:`)
    && nextPageCursor !== null,
  );
  const planned = [...plannedIds]
    .map((id) => planNodes.get(id))
    .filter((node): node is CleanupMapNode => node !== undefined);
  const plannedBytes = planned.reduce((total, node) => total + node.sizeBytes, 0);
  const protectedInteraction = Boolean(
    (dragState?.dragging && dragState.blocked) || blockedDropNodeId,
  );
  const draggedNode = dragState
    ? planNodes.get(dragState.nodeId) ?? visibleNodes.get(dragState.nodeId)
    : undefined;
  const failedPaths = useMemo(
    () => new Set(deleteOutcome?.failed.map((failure) => failure.path) ?? []),
    [deleteOutcome],
  );
  const parentId = parents.get(focus.id) ?? null;
  const breadcrumbs = breadcrumbPath(focus, nodes, parents);
  const selectedBreadcrumbs = breadcrumbPath(selected, nodes, parents);
  const focusChanged = changedIds.has(focus.id);
  const freshness = focusChanged ? "changed" : snapshotStatus;
  const refreshableFocus = Boolean(
    snapshot.indexed &&
    focus.id.startsWith(`index:${snapshot.scanId}:`) &&
    (focus.kind === "folder" || focus.kind === "restricted") &&
    (focus.id !== root.id || snapshot.targetKind === "folder"),
  );
  const refreshPhase = directoryRefreshStatus?.phase ?? null;
  const refreshingFocus = Boolean(
    directoryRefreshStatus?.target.targetPath === focus.id
    && refreshPhase
    && !["cancelled", "completed", "failed"].includes(refreshPhase),
  );
  const validationTargets = useMemo(() => {
    if (focus.path) {
      return [{
        id: focus.id,
        path: focus.path,
        sampledAtMs: snapshot.sampledAtMs,
      }];
    }
    if (!focus.id.startsWith("location:")) return [];
    return focus.children.flatMap((child) => child.path ? [{
      id: child.id,
      path: child.path,
      sampledAtMs: snapshot.sampledAtMs,
    }] : []);
  }, [focus, snapshot.sampledAtMs]);
  const selectMapNode = useCallback((node: CleanupMapNode | null) => {
    const nextId = node?.id ?? focus.id;
    setSelectedId((current) => current === nextId ? current : nextId);
  }, [focus.id]);

  useEffect(() => {
    if (presentation !== "list") return;
    const requestId = ++listRequestIdRef.current;
    const timer = window.setTimeout(() => {
      setListLoading(true);
      setListError(null);
      if (!snapshot.indexed || !focus.id.startsWith(`index:${snapshot.scanId}:`)) {
        const query = listQuery.trim().toLocaleLowerCase();
        const next = legendChildren
          .filter((node) => !query || node.name.toLocaleLowerCase().includes(query))
          .sort((left, right) => {
            const comparison = listSort === "name"
              ? left.name.localeCompare(right.name)
              : left.allocatedSizeBytes - right.allocatedSizeBytes;
            return listDescending ? -comparison : comparison;
          });
        if (requestId === listRequestIdRef.current) {
          setListItems(next);
          setListCursor(null);
          setListLoading(false);
        }
        return;
      }
      void getCleanupIndexedChildren({
        scanId: snapshot.scanId,
        directoryId: focus.id,
        cursor: null,
        limit: 60,
        query: listQuery.trim() || null,
        sortBy: listSort,
        descending: listDescending,
      }).then((page) => {
        if (requestId !== listRequestIdRef.current) return;
        setListItems(page.items);
        setListCursor(page.nextCursor);
      }).catch((reason) => {
        if (requestId === listRequestIdRef.current) {
          setListError(normalizeCommandError(reason));
        }
      }).finally(() => {
        if (requestId === listRequestIdRef.current) setListLoading(false);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [
    focus.id,
    legendChildren,
    listDescending,
    listQuery,
    listSort,
    presentation,
    snapshot.indexed,
    snapshot.scanId,
  ]);

  const loadMoreListItems = async () => {
    if (listCursor === null || listLoadingMore) return;
    setListLoadingMore(true);
    setListError(null);
    try {
      const page = await getCleanupIndexedChildren({
        scanId: snapshot.scanId,
        directoryId: focus.id,
        cursor: listCursor,
        limit: 60,
        query: listQuery.trim() || null,
        sortBy: listSort,
        descending: listDescending,
      });
      setListItems((current) => [...current, ...page.items]);
      setListCursor(page.nextCursor);
    } catch (reason) {
      setListError(normalizeCommandError(reason));
    } finally {
      setListLoadingMore(false);
    }
  };

  useEffect(() => {
    const revalidate = () => setValidationRevision((current) => current + 1);
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, []);

  useEffect(() => () => {
    deleteRequestIdRef.current += 1;
    const lease = deleteLeaseRef.current;
    if (lease) void releaseCleanupDeleteLease({ leaseId: lease.id });
  }, []);

  useEffect(() => {
    const cancelDragOnBlur = () => {
      dragStateRef.current = null;
      setDragState(null);
    };
    window.addEventListener("blur", cancelDragOnBlur);
    return () => window.removeEventListener("blur", cancelDragOnBlur);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const preventNativeSelection = (event: Event) => event.preventDefault();
    canvas.addEventListener("selectstart", preventNativeSelection);
    canvas.addEventListener("dragstart", preventNativeSelection);
    return () => {
      canvas.removeEventListener("selectstart", preventNativeSelection);
      canvas.removeEventListener("dragstart", preventNativeSelection);
    };
  }, []);

  useEffect(() => {
    if (validationTargets.length === 0) return;
    let cancelled = false;
    void Promise.all(validationTargets.map(async (target) => {
      try {
        const state = await getCleanupPathState(target.path);
        return cleanupPathChanged(state, target.sampledAtMs) ? target.id : null;
      } catch {
        return null;
      }
    })).then((changedTargets) => {
      if (cancelled) return;
      const changed = changedTargets.filter((id): id is string => id !== null);
      if (changed.length === 0) return;
      setChangedIds((current) => {
        const next = new Set(current);
        next.add(focus.id);
        changed.forEach((id) => next.add(id));
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [focus.id, validationRevision, validationTargets]);

  const navigateTo = (node: CleanupMapNode) => {
    setSubtreeError(null);
    if (node.id === focus.id) {
      setSelectedId(node.id);
      return;
    }
    setFocusId(node.id);
    setSelectedId(node.id);
  };

  const refreshFocusedFolder = () => {
    if (!refreshableFocus || refreshingFocus) return;
    setSubtreeError(null);
    onRefreshDirectory(focus.id);
  };

  const drillInto = async (node: CleanupMapNode) => {
    setSubtreeError(null);
    setSelectedId(node.id);
    if (node.kind === "aggregate") {
      return;
    }
    if ((node.kind === "folder" || node.kind === "restricted") && node.children.length > 0) {
      navigateTo(node);
      return;
    }
    if (
      !snapshot.indexed
      || !snapshot.scanId
      || !node.id.startsWith(`index:${snapshot.scanId}:`)
      || (node.kind !== "folder" && node.kind !== "restricted")
      || !node.hasChildren
    ) return;

    const requestId = subtreeRequestIdRef.current + 1;
    subtreeRequestIdRef.current = requestId;
    try {
      const subtree = await getCleanupIndexedDirectory({
        scanId: snapshot.scanId,
        directoryId: node.id,
      });
      if (subtreeRequestIdRef.current !== requestId) return;
      const loaded = subtree as CleanupMapNode;
      retainLoadedSubtree(loaded);
      navigateTo(loaded);
    } catch (caughtError) {
      if (subtreeRequestIdRef.current === requestId) {
        const normalized = normalizeCommandError(caughtError);
        if (
          normalized.code === "cleanup_index_node_missing"
          || normalized.code === "cleanup_index_scan_missing"
        ) {
          try {
            const latest = await onReloadLatestSnapshot();
            if (
              subtreeRequestIdRef.current !== requestId
              || (latest && latest.scanId !== snapshot.scanId)
            ) return;
          } catch {
            // Fall through to the original, actionable index error.
          }
        }
        setSubtreeError(normalized);
      }
    }
  };

  const loadMoreChildren = async () => {
    if (!canPageFocus || nextPageCursor === null || pagingDirectoryId) return;
    setPagingDirectoryId(focus.id);
    setSubtreeError(null);
    try {
      const page = await getCleanupIndexedChildren({
        scanId: snapshot.scanId,
        directoryId: focus.id,
        cursor: nextPageCursor,
        limit: 50,
      });
      setPagedChildren((current) => {
        const existing = current.get(focus.id) ?? [];
        const seen = new Set(existing.map((node) => node.id));
        const appended = page.items.filter((node) => !seen.has(node.id));
        return new Map(current).set(focus.id, [...existing, ...appended]);
      });
      setPageCursors((current) => new Map(current).set(focus.id, page.nextCursor));
    } catch (caughtError) {
      setSubtreeError(normalizeCommandError(caughtError));
    } finally {
      setPagingDirectoryId(null);
    }
  };

  const addToPlan = (node: CleanupMapNode) => {
    if (node.id === root.id || !canCollectCleanupNode(node)) return;
    setDeleteOutcome(null);
    setPlannedIds((current) => collectCleanupPlanNode(current, node.id, parents));
  };

  const removeFromPlan = (nodeId: string) => {
    setPlannedIds((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  };

  const updateDragState = (next: CleanupDragState | null) => {
    const previous = dragStateRef.current;
    dragStateRef.current = next;
    if (next?.dragging) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
        if (!dragPreviewRef.current) return;
        dragPreviewRef.current.style.transform = `translate3d(${next.x + 13}px, ${next.y + 13}px, 0)`;
      });
    }
    if (
      previous === null ||
      next === null ||
      previous.dragging !== next.dragging ||
      previous.overDropzone !== next.overDropzone
    ) {
      setDragState(next);
    }
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, node: CleanupMapNode) => {
    if (
      event.button !== 0 ||
      node.kind === "aggregate" ||
      isCleanupNodeCoveredByPlan(plannedIds, node.id, parents)
    ) return;
    const protectionReason = cleanupNodeProtection(node);
    window.clearTimeout(blockedDropTimerRef.current);
    setBlockedDropNodeId(null);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Global pointer listeners still keep the drag usable when capture is unavailable.
    }
    updateDragState({
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      overDropzone: false,
      blocked: protectionReason !== null,
      protectionReason,
    });
  };

  const moveDragAt = (pointerId: number, clientX: number, clientY: number) => {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const distance = Math.hypot(clientX - current.startX, clientY - current.startY);
    const dragging = current.dragging || (
      distance >= 10 && (performance.now() - current.startedAt >= 90 || distance >= 18)
    );
    const overDropzone = dragging && Boolean(
      document.elementFromPoint(clientX, clientY)?.closest(".cleanup-map__dropzone"),
    );
    updateDragState({ ...current, x: clientX, y: clientY, dragging, overDropzone });
  };

  const finishDragAt = (pointerId: number) => {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== pointerId) return;
    if (current.dragging) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
      if (current.overDropzone) {
        if (current.blocked) {
          setBlockedDropNodeId(current.nodeId);
          window.clearTimeout(blockedDropTimerRef.current);
          blockedDropTimerRef.current = window.setTimeout(() => {
            setBlockedDropNodeId(null);
          }, 1_800);
        } else {
          const node = nodes.get(current.nodeId);
          if (node) addToPlan(node);
        }
      }
    }
    updateDragState(null);
  };

  const cancelDragAt = (pointerId: number) => {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== pointerId) return;
    updateDragState(null);
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      moveDragAt(event.pointerId, event.clientX, event.clientY);
      if (dragStateRef.current?.pointerId === event.pointerId && dragStateRef.current.dragging) {
        event.preventDefault();
      }
    };
    const finish = (event: PointerEvent) => finishDragAt(event.pointerId);
    const cancel = (event: PointerEvent) => cancelDragAt(event.pointerId);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [nodes, parents]);

  useEffect(() => () => {
    window.cancelAnimationFrame(dragPreviewFrameRef.current);
    window.clearTimeout(blockedDropTimerRef.current);
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
    scanSampledAtMs: number,
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
        buildCleanupDeleteLeaseRequest(
          items,
          scanSampledAtMs,
          mode,
          snapshot.targetKind === "system_disk" ? undefined : snapshot.targetPath,
          snapshot.targetKind,
          snapshot.scanId,
        ),
      );
      if (deleteRequestIdRef.current !== requestId) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        return;
      }
      const refreshedItems = applyRefreshedCleanupTargets(
        items,
        lease.refreshedTargets,
        lease.missingPaths,
        lease.unavailablePaths,
      );
      if (!refreshedItems) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        throw {
          code: "cleanup_refresh_incomplete",
          message: "CoreRobin could not match every refreshed cleanup target by path.",
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

  const openDeleteDialog = async () => {
    if (planned.length === 0 || !snapshot.deletionAvailable) return;
    const items = [...planned];
    const initialMode: CleanupDeleteMode = items.some((item) => isInsideTrashPath(item.path))
      ? "permanent"
      : "trash";
    setDeleteMode(initialMode);
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
    setDeleteOutcome(null);
    await prepareDeleteLease(items, snapshot.sampledAtMs, initialMode);
  };

  const confirmCleanup = async () => {
    const lease = deleteLeaseRef.current;
    if (
      !lease ||
      lease.mode !== deleteMode ||
      !cleanupLeaseCanExecute(lease) ||
      (deleteMode === "permanent" && !deleteAcknowledged) ||
      deleteSubmitting ||
      deleteModeSwitching
    ) return;
    const actionRecordId = onUserActionStart?.({
      kind: "cleanup_delete",
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
        id: item.id,
        path: item.path,
        logicalSizeBytes: item.logicalSizeBytes,
        allocatedSizeBytes: deletedByPath.get(item.path) ?? item.allocatedSizeBytes,
        itemCount: item.itemCount,
      }));
      setPlannedIds((current) => new Set(
        [...current].filter((id) => {
          const path = planNodes.get(id)?.path;
          return path === null || path === undefined || !deletedPaths.has(path);
        }),
      ));
      setLoadedSubtrees((current) => {
        const next = new Map<string, CleanupMapNode>();
        for (const [id, node] of current) {
          const reconciled = reconcileCleanupNodeAfterDeletion(node, deletionTargets);
          if (reconciled) next.set(id, reconciled);
        }
        return next;
      });
      setSelectedId(focus.id);
      const uncertainPaths = new Set([
        ...(result.interruptedPath ? [result.interruptedPath] : []),
        ...result.failed.map((failure) => failure.path),
      ]);
      if (uncertainPaths.size > 0) {
        const uncertainItems = deleteDialogItems.filter(
          (item) => item.path !== null && uncertainPaths.has(item.path),
        );
        if (uncertainItems.length > 0) {
          setChangedIds((current) => {
            const next = new Set(current);
            for (const item of uncertainItems) {
              let currentId: string | undefined = item.id;
              while (currentId) {
                next.add(currentId);
                currentId = parents.get(currentId);
              }
            }
            return next;
          });
        }
      }
      setDeleteOutcome({
        deletedCount: result.deleted.length,
        deletedBytes: result.deletedBytes,
        selectedLogicalBytes: result.selectedLogicalBytes ?? result.deletedBytes,
        selectedAllocatedBytes:
          result.selectedAllocatedBytes ?? result.deletedBytes,
        availableBytesBefore: result.availableBytesBefore ?? null,
        availableBytesAfter: result.availableBytesAfter ?? null,
        mode: deleteMode,
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
          outcome: {
            selectedCount: deleteDialogItems.length,
            succeededCount: result.deleted.length,
            skippedCount: Math.max(
              0,
              deleteDialogItems.length - result.deleted.length - result.failed.length,
            ),
            releasedBytes: result.deletedBytes,
          },
        });
        actionRecorded = true;
      }
      await onDeletionApplied(deletionTargets, uncertainPaths.size > 0);
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

  const cancelCleanup = async () => {
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

  return (
    <section
      className="cleanup-map"
      id="cleanup-space-map"
      aria-labelledby="cleanup-map-title"
    >
      <header className="cleanup-map__heading">
        <div>
          <h3 id="cleanup-map-title">{t("cleanup:map.title")}</h3>
          {mapMode === "category" ? <p>{t("cleanup:map.descriptionCategory")}</p> : null}
          <nav className="cleanup-map__breadcrumbs" aria-label={t("cleanup:map.breadcrumbs")}>
            {breadcrumbs.map((node, index) => (
              <span key={node.id}>
                {index > 0 ? <ChevronRight size={11} /> : null}
                <button
                  type="button"
                  aria-current={node.id === focus.id ? "page" : undefined}
                  onClick={() => navigateTo(node)}
                >
                  {node.name}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div className="cleanup-map__view-controls">
          <div className="cleanup-map__mode" role="group" aria-label={t("cleanup:map.mode.label")}>
            <button type="button" className={mapMode === "path" ? "is-active" : undefined} aria-pressed={mapMode === "path"} onClick={() => setMapMode("path")}>
              {t("cleanup:map.mode.path")}
            </button>
            <button type="button" className={mapMode === "category" ? "is-active" : undefined} aria-pressed={mapMode === "category"} onClick={() => setMapMode("category")}>
              {t("cleanup:map.mode.category")}
            </button>
          </div>
          <div className="cleanup-map__presentation" role="group" aria-label={t("cleanup:map.view.label")}>
            <button type="button" className={presentation === "map" ? "is-active" : undefined} aria-pressed={presentation === "map"} onClick={() => setPresentation("map")}>
              <PieChart size={13} />{t("cleanup:map.view.map")}
            </button>
            <button type="button" className={presentation === "list" ? "is-active" : undefined} aria-pressed={presentation === "list"} onClick={() => setPresentation("list")}>
              <List size={13} />{t("cleanup:map.view.list")}
            </button>
          </div>
        </div>
      </header>

      <div className="cleanup-map__workspace">
        <div className="cleanup-map__visual">
          <div className="cleanup-map__canvas" ref={canvasRef}>
            {freshness !== "current" ? (
              <div className={`cleanup-map__freshness is-${freshness}`}>
                {freshness === "changed" ? <AlertTriangle size={13} /> : <Clock3 size={13} />}
                <span role="status">{t(`cleanup:map.freshness.${freshness}`)}</span>
                {freshness === "changed" && refreshableFocus ? (
                  <button
                    type="button"
                    className="cleanup-map__freshness-action"
                    disabled={refreshingFocus}
                    onClick={refreshFocusedFolder}
                  >
                    {refreshingFocus ? <LoaderCircle className="is-spinning" size={13} /> : <RefreshCw size={13} />}
                    <span>
                      {t(
                        refreshingFocus
                          ? "cleanup:map.freshness.refreshingFolder"
                          : "cleanup:map.freshness.refreshFolder",
                        { name: focus.name },
                      )}
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {refreshingFocus && directoryRefreshStatus ? (
              <div className="cleanup-map__refresh-progress" role="status">
                <LoaderCircle className="is-spinning" size={14} />
                <span>
                  {t("cleanup:map.refreshProgress", {
                    count: directoryRefreshStatus.progress.scannedEntryCount,
                    time: Math.max(1, Math.round(directoryRefreshStatus.progress.elapsedMs / 1_000)),
                  })}
                </span>
                <small title={directoryRefreshStatus.progress.currentPath}>
                  {directoryRefreshStatus.progress.currentPath}
                </small>
                <button type="button" onClick={onCancelDirectoryRefresh}>
                  <CircleStop size={13} />
                  {t("common:cancel")}
                </button>
              </div>
            ) : null}
            {presentation === "map" ? (
              <div className="cleanup-map__surface">
                <CleanupSunburstCanvas
                  arcs={arcs}
                  hues={hueMap}
                  selectedId={selected.id}
                  changedIds={changedIds}
                  collectedIds={collectedIds}
                  focusKey={focus.id}
                  ariaLabel={t("cleanup:map.ariaLabel", { name: nodeDisplayName(focus, t("cleanup:map.otherContent"), t("cleanup:map.restrictedObjects")) })}
                  onSelect={selectMapNode}
                  onActivate={(node) => {
                    if (suppressNextClickRef.current) {
                      suppressNextClickRef.current = false;
                      return;
                    }
                    void drillInto(node);
                  }}
                  onCollect={addToPlan}
                  onPointerDown={beginDrag}
                  onPointerCancel={cancelDragAt}
                />
                <button
                  className={`cleanup-map__center-control${focusChanged ? " is-changed" : ""}`}
                  type="button"
                  disabled={!parentId}
                  aria-label={parentId ? t("cleanup:map.centerBack") : undefined}
                  onClick={() => {
                    const parent = parentId ? nodes.get(parentId) : null;
                    if (parent) navigateTo(parent);
                  }}
                >
                  <span>{nodeDisplayName(focus, t("cleanup:map.otherContent"), t("cleanup:map.restrictedObjects"))}</span>
                  <strong>{formatBytes(focus.allocatedSizeBytes)}</strong>
                  {focusChanged ? <small>{t("cleanup:map.freshness.changedShort")}</small> : null}
                </button>
              </div>
            ) : (
              <div className="cleanup-index-list">
                <div className="cleanup-index-list__toolbar">
                  <label>
                    <Search size={14} />
                    <input
                      type="search"
                      value={listQuery}
                      onChange={(event) => setListQuery(event.target.value)}
                      placeholder={t("cleanup:map.view.search")}
                    />
                    {listQuery ? (
                      <button type="button" onClick={() => setListQuery("")} aria-label={t("cleanup:map.view.clearSearch")}>
                        <X size={13} />
                      </button>
                    ) : null}
                  </label>
                  <select value={listSort} onChange={(event) => setListSort(event.target.value as "size" | "name")}>
                    <option value="size">{t("cleanup:map.view.sortSize")}</option>
                    <option value="name">{t("cleanup:map.view.sortName")}</option>
                  </select>
                  <button type="button" onClick={() => setListDescending((current) => !current)}>
                    <ArrowDownUp size={14} />
                    {t(listDescending ? "cleanup:map.view.descending" : "cleanup:map.view.ascending")}
                  </button>
                </div>
                {listLoading ? (
                  <div className="cleanup-index-list__state" role="status">
                    <LoaderCircle className="is-spinning" size={18} />{t("cleanup:map.view.loading")}
                  </div>
                ) : listError ? (
                  <div className="cleanup-index-list__state is-error" role="alert">
                    <AlertTriangle size={18} />{t("cleanup:map.view.loadFailed")}
                  </div>
                ) : listItems.length === 0 ? (
                  <div className="cleanup-index-list__state">
                    <Search size={18} />{t("cleanup:map.view.empty")}
                  </div>
                ) : (
                  <div className="cleanup-index-list__table" role="table" aria-label={t("cleanup:map.view.list")}>
                    {listItems.map((node) => {
                      const protectedNode = cleanupNodeProtection(node) !== null;
                      const collected = plannedIds.has(node.id);
                      return (
                        <div className={selected.id === node.id ? "is-selected" : undefined} role="row" key={node.id}>
                          <input
                            type="checkbox"
                            checked={collected}
                            disabled={protectedNode || node.kind === "aggregate"}
                            aria-label={collected
                              ? t("cleanup:map.removeFromBasket")
                              : t("cleanup:map.addToBasket")}
                            onChange={() => collected ? removeFromPlan(node.id) : addToPlan(node)}
                          />
                          <button type="button" role="cell" onClick={() => setSelectedId(node.id)} onDoubleClick={() => void drillInto(node)}>
                            <span>{node.kind === "file" ? <File size={15} /> : <FolderOpen size={15} />}</span>
                            <span><strong>{nodeDisplayName(node, t("cleanup:map.otherContent"), t("cleanup:map.restrictedObjects"))}</strong><small>{node.path ?? t(`cleanup:map.types.${node.kind}`)}</small></span>
                            <b>{formatBytes(node.allocatedSizeBytes)}</b>
                            {node.hasChildren ? <ChevronRight size={14} /> : <span />}
                          </button>
                        </div>
                      );
                    })}
                    {listCursor !== null ? (
                      <button className="cleanup-index-list__more" type="button" disabled={listLoadingMore} onClick={() => void loadMoreListItems()}>
                        {listLoadingMore ? <LoaderCircle className="is-spinning" size={14} /> : <Plus size={14} />}
                        {t("cleanup:map.loadMore")}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            <div
              className={`cleanup-map__plan cleanup-map__dropzone${dragState?.dragging ? " is-dragging" : ""}${dragState?.overDropzone && !dragState.blocked ? " is-active" : ""}${dragState?.dragging && dragState.blocked ? " is-protected-drag" : ""}${blockedDropNodeId ? " is-blocked" : ""}${planned.length > 0 ? " has-items" : ""}${deleteOutcome ? " has-outcome" : ""}`}
              aria-live="polite"
            >
              <span className="cleanup-map__basket-attention" aria-hidden="true"><i /><i /></span>
              <span className="cleanup-map__basket-icon" aria-hidden="true">
                {protectedInteraction ? <LockKeyhole size={20} /> : <Trash2 size={20} />}
              </span>
              <div className="cleanup-map__basket-copy">
                <small>{protectedInteraction
                  ? t("cleanup:map.basket.protectedTitle")
                  : dragState?.overDropzone
                    ? t("cleanup:map.basket.release")
                    : t("cleanup:map.basket.title")}</small>
                <strong>{protectedInteraction
                  ? t("cleanup:map.basket.protectedMessage")
                  : planned.length > 0
                    ? t("cleanup:map.planSummary", { count: planned.length, size: formatBytes(plannedBytes) })
                    : deleteOutcome
                    ? t(
                        deleteOutcome.cancelled
                          ? "cleanup:map.basket.cancelled"
                          : deleteOutcome.failed.length > 0
                            ? "cleanup:map.basket.partial"
                            : "cleanup:map.basket.completed",
                        { deletedCount: deleteOutcome.deletedCount, failedCount: deleteOutcome.failed.length },
                      )
                    : t("cleanup:map.basket.empty")}</strong>
                {planned.length > 0 ? (
                  <div className="cleanup-map__basket-items">
                    {planned.map((node) => (
                      <button className={node.path && failedPaths.has(node.path) ? "is-failed" : undefined} type="button" key={node.id} onClick={() => removeFromPlan(node.id)} title={t("cleanup:map.basket.remove", { name: node.name })}>
                        <span>{node.name}</span><X size={11} />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {planned.length > 0 ? (
                <>
                  <button className="cleanup-map__basket-clear" type="button" onClick={() => setPlannedIds(new Set())}>
                    {t("cleanup:map.basket.clear")}
                  </button>
                  <button className="button button--primary cleanup-map__basket-review" type="button" disabled={!snapshot.deletionAvailable} onClick={() => void openDeleteDialog()}>
                    <ChevronRight size={14} />
                    {snapshot.deletionAvailable
                      ? t("cleanup:map.chooseDeleteMethod")
                      : t("cleanup:map.deletionUnavailable")}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <aside className="cleanup-map__details" aria-label={t("cleanup:map.details")}>
          <div className={`cleanup-map__selected${selectedCollected ? " is-collected" : ""}`}>
            <span className={`cleanup-map__selected-icon is-${selected.kind}`}>
              {selected.kind === "file" ? <File size={17} /> : selected.kind === "aggregate" ? <Layers3 size={17} /> : selected.kind === "restricted" ? <LockKeyhole size={17} /> : <FolderOpen size={17} />}
            </span>
            <div>
              <small>{t(selectedCollected ? "cleanup:map.basket.collected" : "cleanup:map.selected")}</small>
              <strong>{nodeDisplayName(selected, t("cleanup:map.otherContent"), t("cleanup:map.restrictedObjects"))}</strong>
              {mapMode === "path" && selected.path ? (
                <nav
                  className="cleanup-map__selected-path"
                  aria-label={t("cleanup:map.selectedPath")}
                  title={selected.path}
                >
                  {selectedBreadcrumbs.map((node, index) => (
                    <span key={node.id}>
                      {index > 0 ? <ChevronRight size={10} aria-hidden="true" /> : null}
                      {node.id === selected.id ? (
                        <em aria-current="page">{node.name}</em>
                      ) : (
                        <button
                          type="button"
                          title={node.path ?? node.name}
                          onClick={() => navigateTo(node)}
                        >
                          {node.name}
                        </button>
                      )}
                    </span>
                  ))}
                </nav>
              ) : (
                <code title={selected.path ?? selected.name}>{selected.path ?? t("cleanup:map.grouped")}</code>
              )}
            </div>
            <span>
              <strong>{formatBytes(selected.allocatedSizeBytes)}</strong>
              <small>{t("cleanup:map.allocatedSize")}</small>
              {selected.logicalSizeBytes !== selected.allocatedSizeBytes ? <small>{t("cleanup:map.logicalSize", { size: formatBytes(selected.logicalSizeBytes) })}</small> : null}
            </span>
          </div>
          <div className={`cleanup-map__path-actions-slot${selected.path ? "" : " is-empty"}`}>
            {selected.path ? (
              <>
                <PathActions className="cleanup-map__path-actions" path={selected.path} />
                {selectedDirectlyPlanned ? (
                  <button
                    className="button button--secondary cleanup-map__collect-action"
                    type="button"
                    onClick={() => removeFromPlan(selected.id)}
                  >
                    <X size={14} />{t("cleanup:map.removeFromBasket")}
                  </button>
                ) : selectedCollected ? (
                  <button
                    className="button button--secondary cleanup-map__collect-action"
                    type="button"
                    disabled
                  >
                    <CheckCircle2 size={14} />{t("cleanup:map.includedByParent")}
                  </button>
                ) : (
                  <button
                    className="button button--primary cleanup-map__collect-action"
                    type="button"
                    disabled={!canCollectCleanupNode(selected)}
                    onClick={() => addToPlan(selected)}
                  >
                    <Plus size={14} />{t("cleanup:map.addToBasket")}
                  </button>
                )}
              </>
            ) : null}
          </div>

          {deleteOutcome ? (
            <div className={`cleanup-map__delete-result${deleteOutcome.cancelled ? " is-cancelled" : deleteOutcome.failed.length > 0 ? " is-partial" : " is-success"}`} role="status">
              {deleteOutcome.cancelled ? <CircleStop size={16} /> : deleteOutcome.failed.length > 0 ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              <div>
                <strong>{t(
                  deleteOutcome.cancelled
                    ? deleteOutcome.deletedCount > 0 ? "cleanup:map.deleteResult.cancelled" : "cleanup:map.deleteResult.cancelledNoDeletion"
                    : deleteOutcome.failed.length > 0
                    ? deleteOutcome.deletedCount > 0 ? "cleanup:map.deleteResult.partial" : "cleanup:map.deleteResult.failed"
                    : "cleanup:map.deleteResult.success",
                  { deletedCount: deleteOutcome.deletedCount, failedCount: deleteOutcome.failed.length },
                )}</strong>
                <small>
                  {t("cleanup:map.deleteResult.selectedSizes", {
                    logical: formatBytes(deleteOutcome.selectedLogicalBytes),
                    allocated: formatBytes(deleteOutcome.selectedAllocatedBytes),
                  })}
                </small>
                <small>
                  {deleteOutcome.availableBytesBefore !== null
                    && deleteOutcome.availableBytesAfter !== null
                    ? t(
                      deleteOutcome.mode === "trash"
                        ? "cleanup:map.deleteResult.trashSpace"
                        : cleanupAvailableDelta(deleteOutcome) >=
                            deleteOutcome.deletedBytes * 0.8
                          ? "cleanup:map.deleteResult.released"
                          : "cleanup:map.deleteResult.pendingReclaim",
                      {
                        size: formatBytes(cleanupAvailableDelta(deleteOutcome)),
                        processed: formatBytes(deleteOutcome.deletedBytes),
                      },
                    )
                    : t("cleanup:map.deleteResult.reclaimed", {
                      size: formatBytes(deleteOutcome.deletedBytes),
                    })}
                </small>
                {deleteOutcome.failed.slice(0, 3).map((failure) => (
                  <code key={failure.path} title={failure.message}>{failure.path}</code>
                ))}
              </div>
            </div>
          ) : null}

          {directChildren.length > 0 ? (
            <ol className="cleanup-map__legend">
              {legendChildren.map((child) => {
                const visual = cleanupNodeVisual(child, Math.max(1, (depths.get(child.id) ?? 1) - (depths.get(focus.id) ?? 0)), hueMap);
                const collected = isCleanupNodeCoveredByPlan(plannedIds, child.id, parents);
                const protectionReason = cleanupNodeProtection(child);
                const protectedNode = protectionReason !== null;
                const protectedDragSource = dragState?.dragging && dragState.nodeId === child.id && dragState.blocked;
                return (
                  <li key={child.id}>
                    <button
                      className={`${selected.id === child.id ? "is-selected" : ""}${collected ? " is-collected" : ""}${protectedDragSource ? " is-protected-drag-source" : ""}${child.path && failedPaths.has(child.path) ? " is-delete-failed" : ""}`.trim() || undefined}
                      type="button"
                      style={{ "--cleanup-node-color": visual.swatch } as CSSProperties}
                      aria-current={selected.id === child.id ? "true" : undefined}
                      onMouseEnter={() => setSelectedId(child.id)}
                      onFocus={() => setSelectedId(child.id)}
                      data-draggable={!collected && child.kind !== "aggregate" ? "true" : undefined}
                      data-drag-policy={protectedNode ? "protected" : "collect"}
                      data-protection-reason={protectionReason ?? undefined}
                      onPointerDown={(event) => beginDrag(event, child)}
                      onPointerCancel={(event) => cancelDragAt(event.pointerId)}
                      onClick={() => {
                        if (suppressNextClickRef.current) {
                          suppressNextClickRef.current = false;
                          return;
                        }
                        void drillInto(child);
                      }}
                    >
                      <i className={visual.className} style={{ background: visual.swatch }}>
                        {protectedNode ? <LockKeyhole size={8} /> : null}
                      </i>
                      <span>
                        <strong>{nodeDisplayName(child, t("cleanup:map.otherContent"), t("cleanup:map.restrictedObjects"))}</strong>
                        <small>
                          {t(`cleanup:map.types.${child.kind}`)} · {percentage(child.allocatedSizeBytes, focus.allocatedSizeBytes)}
                          {collected ? ` · ${t("cleanup:map.basket.collected")}` : ""}
                          {protectedNode ? ` · ${t("cleanup:map.basket.protectedBadge")}` : ""}
                        </small>
                      </span>
                      <b>
                        {child.kind === "restricted" ? t("cleanup:map.unreadable") : formatBytes(child.allocatedSizeBytes)}
                      </b>
                    </button>
                  </li>
                );
              })}
              {canPageFocus ? (
                <li className="cleanup-map__load-more">
                  <button
                    type="button"
                    disabled={pagingDirectoryId === focus.id}
                    onClick={() => void loadMoreChildren()}
                  >
                    {pagingDirectoryId === focus.id
                      ? <LoaderCircle className="is-spinning" size={14} />
                      : <Plus size={14} />}
                    <span>
                      <strong>{t("cleanup:map.loadMore")}</strong>
                    </span>
                  </button>
                </li>
              ) : null}
            </ol>
          ) : (
            <div className="cleanup-map__leaf">
              {focus.hasChildren ? t("cleanup:map.loadDeeperHint") : t("cleanup:map.noDeeperBreakdown")}
            </div>
          )}

          {subtreeError ? (
            <div className="cleanup-map__subtree-error" role="alert">
              {t("cleanup:map.loadFailed")}
              {subtreeError.code === "cleanup_index_node_missing"
                || subtreeError.code === "cleanup_index_scan_missing"
                ? null
                : `: ${subtreeError.message}`}
            </div>
          ) : null}
          {directoryRefreshError ? (
            <div className="cleanup-map__subtree-error" role="alert">
              {t("cleanup:map.refreshFailed")}: {directoryRefreshError.message}
            </div>
          ) : null}

          <div className="cleanup-map__review">
            <span><ShieldAlert size={14} />{t(`cleanup:safety.${selected.safety}`)}</span>
            <small>{selectedCollected
              ? t("cleanup:map.basket.collectedHint")
              : selected.kind === "restricted"
                ? t("cleanup:map.restrictedHint")
                : selected.kind === "aggregate" && focus.path
                  ? t("cleanup:map.otherContentHint")
                : isTrashRootPath(selected.path)
                  ? t("cleanup:map.trashRootProtected")
                  : canCollectCleanupNode(selected)
                    ? t("cleanup:map.directActionHint")
                    : t("cleanup:map.protectedSelectionHint")}</small>
          </div>
        </aside>
      </div>
      {dragState?.dragging ? (
        <div
          ref={dragPreviewRef}
          className={`cleanup-map__drag-preview${dragState.overDropzone && !dragState.blocked ? " is-over" : ""}${dragState.blocked ? " is-protected" : ""}`}
          style={{ transform: `translate3d(${dragState.x + 13}px, ${dragState.y + 13}px, 0)` }}
          aria-hidden="true"
        >
          {dragState.blocked ? <LockKeyhole size={14} /> : <FolderOpen size={14} />}
          <span>{draggedNode?.name}</span>
          <strong>{dragState.blocked
            ? t("cleanup:map.basket.protectedPreview")
            : formatBytes(draggedNode?.sizeBytes ?? 0)}</strong>
        </div>
      ) : null}
      {deleteDialogOpen ? (
        <CleanupDeleteDialog
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
          onCancelExecution={() => void cancelCleanup()}
          onRefresh={() => {
            if (deleteLease) void prepareDeleteLease(deleteDialogItems, deleteLease.refreshedAtMs, deleteMode);
          }}
          onConfirm={() => void confirmCleanup()}
        />
      ) : null}
    </section>
  );
});

function materializeCleanupNode(
  node: CleanupMapNode,
  loadedSubtrees: ReadonlyMap<string, CleanupMapNode>,
): CleanupMapNode {
  const materialized = loadedSubtrees.get(node.id) ?? node;
  return {
    ...materialized,
    children: materialized.children.map((child) => materializeCleanupNode(child, loadedSubtrees)),
  };
}

function readCleanupMapMode(): CleanupMapMode {
  try {
    return readMigratedStorageItem(
      window.localStorage,
      CLEANUP_MAP_MODE_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.cleanupMapMode,
    ) === "category"
      ? "category"
      : "path";
  } catch {
    return "path";
  }
}

function indexTree(
  root: CleanupMapNode,
  pagedChildren: ReadonlyMap<string, readonly CleanupMapNode[]> = new Map(),
) {
  const nodes = new Map<string, CleanupMapNode>();
  const parents = new Map<string, string>();
  const depths = new Map<string, number>();
  const visit = (node: CleanupMapNode, parent: string | null, depth: number) => {
    nodes.set(node.id, node);
    depths.set(node.id, depth);
    if (parent) parents.set(node.id, parent);
    node.children.forEach((child) => visit(child, node.id, depth + 1));
  };
  visit(root, null, 0);
  for (const [parentId, children] of pagedChildren) {
    const parentDepth = depths.get(parentId);
    if (parentDepth === undefined) continue;
    for (const child of children) {
      if (nodes.has(child.id)) continue;
      visit(child, parentId, parentDepth + 1);
    }
  }
  return { nodes, parents, depths };
}

function breadcrumbPath(
  focus: CleanupMapNode,
  nodes: Map<string, CleanupMapNode>,
  parents: Map<string, string>,
) {
  const path = [focus];
  let parentId = parents.get(focus.id);
  while (parentId) {
    const parent = nodes.get(parentId);
    if (!parent) break;
    path.unshift(parent);
    parentId = parents.get(parent.id);
  }
  return path;
}

function percentage(value: number, total: number) {
  return total <= 0 ? "0%" : `${Math.max(0.1, value / total * 100).toFixed(value / total >= 0.1 ? 0 : 1)}%`;
}

function nodeDisplayName(
  node: CleanupMapNode,
  aggregateLabel: string,
  restrictedLabel: string,
) {
  if (node.kind === "aggregate") return aggregateLabel;
  if (node.kind === "restricted" && node.path === null) return restrictedLabel;
  return node.name;
}
