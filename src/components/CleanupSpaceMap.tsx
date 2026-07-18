import { AlertTriangle, CheckCircle2, ChevronRight, CircleStop, Clock3, File, FolderOpen, Layers3, LoaderCircle, LockKeyhole, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  createCleanupDeleteLease,
  cancelCleanupDelete,
  cancelCleanupSubtree,
  executeCleanupDelete,
  getCleanupPathState,
  getCleanupSubtree,
  releaseCleanupDeleteLease,
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
import type { CleanupDeleteFailure, CleanupDeleteMode, CleanupDeleteProgress, CleanupScan, CleanupDeleteLease, CleanupProtectionReason, CommandError } from "../types";
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
  onDeletionApplied: (
    targets: readonly CleanupDeletionTargetSnapshot[],
    invalidateSnapshot?: boolean,
  ) => Promise<void>;
  onUserActionStart?: (input: StartUserActionInput) => string;
  onUserActionComplete?: (id: string, input: CompleteUserActionInput) => void;
}

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
  failed: CleanupDeleteFailure[];
  cancelled: boolean;
}

type CleanupMapMode = "path" | "category";

const CLEANUP_MAP_MODE_STORAGE_KEY = "core-robin.cleanup-map-mode.v1";

export const CleanupSpaceMap = memo(function CleanupSpaceMap({
  snapshot,
  snapshotStatus,
  onDeletionApplied,
  onUserActionStart,
  onUserActionComplete,
}: CleanupSpaceMapProps) {
  const { t } = useAppTranslation();
  const [loadedSubtrees, setLoadedSubtrees] = useState<Map<string, CleanupMapNode>>(() => new Map());
  const [mapMode, setMapMode] = useState<CleanupMapMode>(readCleanupMapMode);
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
  const root = mapMode === "path" ? pathRoot : categoryRoot;
  const { nodes, parents, depths } = useMemo(() => indexTree(root), [root]);
  const planNodes = useMemo(() => {
    const pathNodes = indexTree(pathRoot).nodes;
    for (const [id, node] of indexTree(categoryRoot).nodes) pathNodes.set(id, node);
    return pathNodes;
  }, [categoryRoot, pathRoot]);
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
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteCancelling, setDeleteCancelling] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<CleanupDeleteProgress | null>(null);
  const [deleteError, setDeleteError] = useState<CommandError | null>(null);
  const [deleteMode, setDeleteMode] = useState<CleanupDeleteMode>("trash");
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  const [deleteOutcome, setDeleteOutcome] = useState<CleanupDeleteOutcome | null>(null);
  const [loadingNodeId, setLoadingNodeId] = useState<string | null>(null);
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
  const activeSubtreeRequestRef = useRef<string | null>(null);

  const cancelActiveSubtree = useCallback(() => {
    const requestId = activeSubtreeRequestRef.current;
    if (!requestId) return;
    activeSubtreeRequestRef.current = null;
    void cancelCleanupSubtree(requestId);
  }, []);

  useEffect(() => {
    cancelActiveSubtree();
    subtreeRequestIdRef.current += 1;
    setLoadedSubtrees(new Map());
    setFocusId(root.id);
    setSelectedId(root.id);
    setPlannedIds(new Set());
    setChangedIds(new Set());
    setDeleteOutcome(null);
    setDeleteProgress(null);
    setDeleteCancelling(false);
    dragStateRef.current = null;
    setDragState(null);
    window.clearTimeout(blockedDropTimerRef.current);
    setBlockedDropNodeId(null);
    setLoadingNodeId(null);
    setSubtreeError(null);
  }, [cancelActiveSubtree, snapshot.sampledAtMs]);

  useEffect(() => {
    cancelActiveSubtree();
    subtreeRequestIdRef.current += 1;
    setFocusId(root.id);
    setSelectedId(root.id);
    setLoadingNodeId(null);
    setSubtreeError(null);
    try {
      window.localStorage.setItem(CLEANUP_MAP_MODE_STORAGE_KEY, mapMode);
    } catch {
      // The view remains switchable for this session when storage is unavailable.
    }
  }, [cancelActiveSubtree, mapMode]);

  useEffect(() => () => cancelActiveSubtree(), [cancelActiveSubtree]);

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
  const selected = nodes.get(selectedId) ?? visibleNodes.get(selectedId) ?? focus;
  const selectedCollected = collectedIds.has(selected.id) ||
    isCleanupNodeCoveredByPlan(plannedIds, selected.id, parents);
  const directChildren = useMemo(
    () => [...focus.children].sort((left, right) => right.allocatedSizeBytes - left.allocatedSizeBytes || left.name.localeCompare(right.name)),
    [focus],
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
  const focusChanged = changedIds.has(focus.id);
  const freshness = focusChanged ? "changed" : snapshotStatus;
  const validationTargets = useMemo(() => {
    if (focus.path) return [{ id: focus.id, path: focus.path }];
    if (!focus.id.startsWith("location:")) return [];
    return focus.children.flatMap((child) => child.path ? [{ id: child.id, path: child.path }] : []);
  }, [focus]);
  const selectMapNode = useCallback((node: CleanupMapNode | null) => {
    const nextId = node?.id ?? focus.id;
    setSelectedId((current) => current === nextId ? current : nextId);
  }, [focus.id]);

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
        return cleanupPathChanged(state, snapshot.sampledAtMs) ? target.id : null;
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
  }, [focus.id, snapshot.sampledAtMs, validationRevision, validationTargets]);

  const navigateTo = (node: CleanupMapNode) => {
    if (loadingNodeId && node.id !== loadingNodeId) {
      cancelActiveSubtree();
      subtreeRequestIdRef.current += 1;
      setLoadingNodeId(null);
    }
    setSubtreeError(null);
    if (node.id === focus.id) {
      setSelectedId(node.id);
      return;
    }
    setFocusId(node.id);
    setSelectedId(node.id);
  };

  const drillInto = async (node: CleanupMapNode) => {
    if (loadingNodeId === node.id) return;
    if (loadingNodeId) {
      cancelActiveSubtree();
      subtreeRequestIdRef.current += 1;
      setLoadingNodeId(null);
    }
    setSubtreeError(null);
    setSelectedId(node.id);
    if ((node.kind === "folder" || node.kind === "restricted") && node.children.length > 0) {
      navigateTo(node);
      return;
    }
    if (node.kind !== "folder" || !node.hasChildren || !node.path) return;

    const requestId = subtreeRequestIdRef.current + 1;
    subtreeRequestIdRef.current = requestId;
    const backendRequestId = `cleanup-subtree-${snapshot.sampledAtMs}-${requestId}`;
    activeSubtreeRequestRef.current = backendRequestId;
    setLoadingNodeId(node.id);
    setSubtreeError(null);
    try {
      const subtree = await getCleanupSubtree({
        requestId: backendRequestId,
        path: node.path,
        safety: node.safety,
      });
      if (subtreeRequestIdRef.current !== requestId) return;
      const loaded = subtree as CleanupMapNode;
      setLoadedSubtrees((current) => {
        const next = new Map(current);
        next.set(node.id, loaded);
        return next;
      });
      navigateTo(loaded);
    } catch (caughtError) {
      if (subtreeRequestIdRef.current === requestId) {
        setSubtreeError(normalizeCommandError(caughtError));
      }
    } finally {
      if (subtreeRequestIdRef.current === requestId) {
        activeSubtreeRequestRef.current = null;
        setLoadingNodeId(null);
      }
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
    setDeleteError(null);
    setDeleteAcknowledged(false);
    try {
      const lease = await createCleanupDeleteLease(
        buildCleanupDeleteLeaseRequest(items, scanSampledAtMs, mode),
      );
      if (deleteRequestIdRef.current !== requestId) {
        if (lease.executable) await releaseCleanupDeleteLease({ leaseId: lease.id });
        return;
      }
      const refreshedItems = applyRefreshedCleanupTargets(items, lease.refreshedTargets);
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
    if (!lease || lease.mode !== deleteMode || !cleanupLeaseCanExecute(lease) || !deleteAcknowledged || deleteSubmitting) return;
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
        path: item.path,
        logicalSizeBytes: item.logicalSizeBytes,
        allocatedSizeBytes: deletedByPath.get(item.path) ?? item.allocatedSizeBytes,
        itemCount: item.itemCount,
      }));
      setPlannedIds((current) => new Set(
        [...current].filter((id) => {
          const path = nodes.get(id)?.path;
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
    <section className="cleanup-map" aria-labelledby="cleanup-map-title">
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
        <div className="cleanup-map__mode" role="group" aria-label={t("cleanup:map.mode.label")}>
          <button type="button" className={mapMode === "path" ? "is-active" : undefined} aria-pressed={mapMode === "path"} onClick={() => setMapMode("path")}>
            {t("cleanup:map.mode.path")}
          </button>
          <button type="button" className={mapMode === "category" ? "is-active" : undefined} aria-pressed={mapMode === "category"} onClick={() => setMapMode("category")}>
            {t("cleanup:map.mode.category")}
          </button>
        </div>
      </header>

      <div className="cleanup-map__workspace">
        <div className="cleanup-map__visual">
          <div className="cleanup-map__canvas" ref={canvasRef}>
            {freshness !== "current" ? (
              <div className={`cleanup-map__freshness is-${freshness}`} role="status">
                {freshness === "changed" ? <RefreshCw size={13} /> : <Clock3 size={13} />}
                <span>{t(`cleanup:map.freshness.${freshness}`)}</span>
              </div>
            ) : null}
            {loadingNodeId ? (
              <div className="cleanup-map__subtree-loading" role="status">
                <LoaderCircle size={14} />
                <span>{t("cleanup:map.loadingFolder")}</span>
              </div>
            ) : null}
            <div className="cleanup-map__surface">
              <CleanupSunburstCanvas
                arcs={arcs}
                hues={hueMap}
                selectedId={selected.id}
                changedIds={changedIds}
                collectedIds={collectedIds}
                focusKey={focus.id}
                ariaLabel={t("cleanup:map.ariaLabel", { name: nodeDisplayName(focus, t("cleanup:map.smallerObjects"), t("cleanup:map.restrictedObjects")) })}
                onSelect={selectMapNode}
                onActivate={(node) => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false;
                    return;
                  }
                  void drillInto(node);
                }}
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
                <span>{nodeDisplayName(focus, t("cleanup:map.smallerObjects"), t("cleanup:map.restrictedObjects"))}</span>
                <strong>{formatBytes(focus.allocatedSizeBytes)}</strong>
                {focusChanged ? <small>{t("cleanup:map.freshness.changedShort")}</small> : null}
              </button>
            </div>

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
                      ? t(snapshotStatus === "current" ? "cleanup:map.reviewCleanup" : "cleanup:map.refreshCleanup")
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
              <strong>{nodeDisplayName(selected, t("cleanup:map.smallerObjects"), t("cleanup:map.restrictedObjects"))}</strong>
              <code title={selected.path ?? selected.name}>{selected.path ?? t("cleanup:map.grouped")}</code>
            </div>
            <span>
              <strong>{formatBytes(selected.allocatedSizeBytes)}</strong>
              <small>{t("cleanup:map.allocatedSize")}</small>
              {selected.logicalSizeBytes !== selected.allocatedSizeBytes ? <small>{t("cleanup:map.logicalSize", { size: formatBytes(selected.logicalSizeBytes) })}</small> : null}
            </span>
          </div>
          <div className={`cleanup-map__path-actions-slot${selected.path ? "" : " is-empty"}`}>
            {selected.path ? (
              <PathActions className="cleanup-map__path-actions" path={selected.path} />
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
                <small>{t("cleanup:map.deleteResult.reclaimed", { size: formatBytes(deleteOutcome.deletedBytes) })}</small>
                {deleteOutcome.failed.slice(0, 3).map((failure) => (
                  <code key={failure.path} title={failure.message}>{failure.path}</code>
                ))}
              </div>
            </div>
          ) : null}

          {directChildren.length > 0 ? (
            <ol className="cleanup-map__legend">
              {directChildren.map((child) => {
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
                      data-draggable={!collected ? "true" : undefined}
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
                        <strong>{nodeDisplayName(child, t("cleanup:map.smallerObjects"), t("cleanup:map.restrictedObjects"))}</strong>
                        <small>
                          {t(`cleanup:map.types.${child.kind}`)} · {percentage(child.allocatedSizeBytes, focus.allocatedSizeBytes)}
                          {collected ? ` · ${t("cleanup:map.basket.collected")}` : ""}
                          {protectedNode ? ` · ${t("cleanup:map.basket.protectedBadge")}` : ""}
                        </small>
                      </span>
                      <b>{child.kind === "restricted" ? t("cleanup:map.unreadable") : formatBytes(child.allocatedSizeBytes)}</b>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="cleanup-map__leaf">
              {focus.hasChildren ? t("cleanup:map.loadDeeperHint") : t("cleanup:map.noDeeperBreakdown")}
            </div>
          )}

          {subtreeError ? (
            <div className="cleanup-map__subtree-error" role="alert">
              {t("cleanup:map.loadFailed")}: {subtreeError.message}
            </div>
          ) : null}

          <div className="cleanup-map__review">
            <span><ShieldAlert size={14} />{t(`cleanup:safety.${selected.safety}`)}</span>
            <small>{selectedCollected
              ? t("cleanup:map.basket.collectedHint")
              : selected.kind === "restricted"
                ? t("cleanup:map.restrictedHint")
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
          submitting={deleteSubmitting}
          cancelling={deleteCancelling}
          progress={deleteProgress}
          error={deleteError}
          mode={deleteMode}
          deleteAcknowledged={deleteAcknowledged}
          onModeChange={(mode) => {
            if (mode === deleteMode || deleteSubmitting) return;
            setDeleteMode(mode);
            const sampledAtMs = deleteLease?.refreshedAtMs ?? snapshot.sampledAtMs;
            void prepareDeleteLease(deleteDialogItems, sampledAtMs, mode);
          }}
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

function indexTree(root: CleanupMapNode) {
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

function nodeDisplayName(node: CleanupMapNode, aggregateLabel: string, restrictedLabel: string) {
  if (node.kind === "aggregate") return aggregateLabel;
  if (node.kind === "restricted" && node.path === null) return restrictedLabel;
  return node.name;
}
