import { CheckCircle2, ChevronRight, Clock3, FolderOpen, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  createCleanupTrashLease,
  executeCleanupTrash,
  getCleanupPathState,
  releaseCleanupTrashLease,
} from "../api";
import { cleanupPathChanged } from "../cleanupFreshness";
import { collectCleanupPlanNode, layoutCleanupMap, type CleanupMapNode } from "../cleanupMap";
import type { CleanupSnapshotStatus } from "../cleanupScanStore";
import type { CleanupNode, CleanupScan, CleanupTrashLease, CommandError } from "../types";
import { formatBytes, normalizeCommandError } from "../utils";
import { CleanupTrashDialog } from "./CleanupTrashDialog";

interface CleanupSpaceMapProps {
  snapshot: CleanupScan;
  snapshotStatus: CleanupSnapshotStatus;
}

const ARC_COLORS = [
  "#63a8ff",
  "#56cf93",
  "#a78bfa",
  "#f5b94c",
  "#f1788b",
  "#60c9cf",
  "#8cb4ff",
];

interface CleanupDragState {
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dragging: boolean;
  overDropzone: boolean;
}

interface CleanupTrashOutcome {
  movedCount: number;
  failedCount: number;
}

export function CleanupSpaceMap({ snapshot, snapshotStatus }: CleanupSpaceMapProps) {
  const { t } = useTranslation();
  const root = useMemo<CleanupMapNode>(() => ({
    id: "cleanup-root",
    name: t("cleanup.map.allScanned"),
    path: null,
    sizeBytes: snapshot.locations.reduce((total, location) => total + location.sizeBytes, 0),
    itemCount: snapshot.locations.reduce((total, location) => total + location.itemCount, 0),
    safety: "review",
    children: snapshot.locations
      .filter((location) => location.available && location.sizeBytes > 0)
      .map((location) => ({
        id: `location:${location.kind}`,
        name: t(`cleanup.locations.${location.kind}.title`),
        path: null,
        sizeBytes: location.sizeBytes,
        itemCount: location.itemCount,
        safety: location.safety,
        children: location.nodes.map(localizeOtherNode),
      }))
      .sort((left, right) => right.sizeBytes - left.sizeBytes),
  }), [snapshot, t]);
  const { nodes, parents } = useMemo(() => indexTree(root), [root]);
  const [focusId, setFocusId] = useState(root.id);
  const [selectedId, setSelectedId] = useState(root.id);
  const [plannedIds, setPlannedIds] = useState<Set<string>>(() => new Set());
  const [changedIds, setChangedIds] = useState<Set<string>>(() => new Set());
  const [validationRevision, setValidationRevision] = useState(0);
  const [dragState, setDragState] = useState<CleanupDragState | null>(null);
  const [trashDialogOpen, setTrashDialogOpen] = useState(false);
  const [trashDialogItems, setTrashDialogItems] = useState<CleanupMapNode[]>([]);
  const [trashLease, setTrashLease] = useState<CleanupTrashLease | null>(null);
  const [trashPreparing, setTrashPreparing] = useState(false);
  const [trashSubmitting, setTrashSubmitting] = useState(false);
  const [trashError, setTrashError] = useState<CommandError | null>(null);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [trashOutcome, setTrashOutcome] = useState<CleanupTrashOutcome | null>(null);
  const dragStateRef = useRef<CleanupDragState | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const suppressNextClickRef = useRef(false);
  const trashLeaseRef = useRef<CleanupTrashLease | null>(null);
  const trashRequestIdRef = useRef(0);

  useEffect(() => {
    setFocusId(root.id);
    setSelectedId(root.id);
    setPlannedIds(new Set());
    setChangedIds(new Set());
    setTrashOutcome(null);
    dragStateRef.current = null;
    setDragState(null);
  }, [root]);

  const focus = nodes.get(focusId) ?? root;
  const selected = nodes.get(selectedId) ?? focus;
  const arcs = useMemo(() => layoutCleanupMap(focus), [focus]);
  const planned = [...plannedIds]
    .map((id) => nodes.get(id))
    .filter((node): node is CleanupMapNode => node !== undefined);
  const plannedBytes = planned.reduce((total, node) => total + node.sizeBytes, 0);
  const parentId = parents.get(focus.id) ?? null;
  const breadcrumbs = breadcrumbPath(focus, nodes, parents);
  const focusChanged = changedIds.has(focus.id);
  const freshness = focusChanged ? "changed" : snapshotStatus;

  useEffect(() => {
    const revalidate = () => setValidationRevision((current) => current + 1);
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, []);

  useEffect(() => () => {
    trashRequestIdRef.current += 1;
    const lease = trashLeaseRef.current;
    if (lease) void releaseCleanupTrashLease({ leaseId: lease.id });
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
    if (!focus.path) return;
    let cancelled = false;
    void getCleanupPathState(focus.path)
      .then((state) => {
        if (cancelled || !cleanupPathChanged(state, snapshot.sampledAtMs)) return;
        setChangedIds((current) => {
          if (current.has(focus.id)) return current;
          const next = new Set(current);
          next.add(focus.id);
          return next;
        });
      })
      .catch(() => {
        // A failed one-shot metadata check must not hide the retained map.
      });
    return () => {
      cancelled = true;
    };
  }, [focus.id, focus.path, snapshot.sampledAtMs, validationRevision]);

  const drillInto = (node: CleanupMapNode) => {
    setSelectedId(node.id);
    if (node.children.length > 0) setFocusId(node.id);
  };

  const navigateTo = (node: CleanupMapNode) => {
    setFocusId(node.id);
    setSelectedId(node.id);
  };

  const addToPlan = (node: CleanupMapNode) => {
    if (node.id === root.id || !canCollectCleanupNode(node)) return;
    setTrashOutcome(null);
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
    dragStateRef.current = next;
    setDragState(next);
  };

  const beginDrag = (event: ReactPointerEvent<SVGPathElement>, node: CleanupMapNode) => {
    if (event.button !== 0 || !canCollectCleanupNode(node)) return;
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
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      overDropzone: false,
    });
  };

  const moveDragAt = (pointerId: number, clientX: number, clientY: number) => {
    const current = dragStateRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const dragging = current.dragging || Math.hypot(
      clientX - current.startX,
      clientY - current.startY,
    ) >= 7;
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
        const node = nodes.get(current.nodeId);
        if (node) addToPlan(node);
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
  });

  const closeTrashDialog = useCallback(() => {
    trashRequestIdRef.current += 1;
    const lease = trashLeaseRef.current;
    trashLeaseRef.current = null;
    if (lease) void releaseCleanupTrashLease({ leaseId: lease.id });
    setTrashDialogOpen(false);
    setTrashDialogItems([]);
    setTrashLease(null);
    setTrashPreparing(false);
    setTrashSubmitting(false);
    setTrashError(null);
    setReviewAcknowledged(false);
  }, []);

  const openTrashDialog = async () => {
    if (planned.length === 0 || !snapshot.deletionAvailable) return;
    const items = [...planned];
    const requestId = trashRequestIdRef.current + 1;
    trashRequestIdRef.current = requestId;
    setTrashDialogItems(items);
    setTrashDialogOpen(true);
    setTrashLease(null);
    trashLeaseRef.current = null;
    setTrashPreparing(true);
    setTrashSubmitting(false);
    setTrashError(null);
    setReviewAcknowledged(false);
    setTrashOutcome(null);
    try {
      const lease = await createCleanupTrashLease({
        paths: items.flatMap((item) => item.path ? [item.path] : []),
        scanSampledAtMs: snapshot.sampledAtMs,
      });
      if (trashRequestIdRef.current !== requestId) {
        await releaseCleanupTrashLease({ leaseId: lease.id });
        return;
      }
      trashLeaseRef.current = lease;
      setTrashLease(lease);
    } catch (caughtError) {
      if (trashRequestIdRef.current === requestId) {
        setTrashError(normalizeCommandError(caughtError));
      }
    } finally {
      if (trashRequestIdRef.current === requestId) setTrashPreparing(false);
    }
  };

  const confirmMoveToTrash = async () => {
    const lease = trashLeaseRef.current;
    if (!lease || trashSubmitting) return;
    setTrashSubmitting(true);
    setTrashError(null);
    try {
      const result = await executeCleanupTrash({ leaseId: lease.id });
      trashLeaseRef.current = null;
      setTrashLease(null);
      const movedPaths = new Set(result.movedPaths);
      const movedIds = trashDialogItems
        .filter((item) => item.path !== null && movedPaths.has(item.path))
        .map((item) => item.id);
      setPlannedIds((current) => new Set(
        [...current].filter((id) => {
          const path = nodes.get(id)?.path;
          return path === null || path === undefined || !movedPaths.has(path);
        }),
      ));
      setChangedIds((current) => {
        const next = new Set(current);
        for (const id of movedIds) {
          next.add(id);
          let parent = parents.get(id);
          while (parent) {
            next.add(parent);
            parent = parents.get(parent);
          }
        }
        return next;
      });
      setTrashOutcome({
        movedCount: result.movedPaths.length,
        failedCount: result.failed.length,
      });
      closeTrashDialog();
    } catch (caughtError) {
      trashLeaseRef.current = null;
      setTrashLease(null);
      setTrashError(normalizeCommandError(caughtError));
    } finally {
      setTrashSubmitting(false);
    }
  };

  return (
    <section className="cleanup-map" aria-labelledby="cleanup-map-title">
      <header className="cleanup-map__heading">
        <div>
          <span className="eyebrow">{t("cleanup.map.kicker")}</span>
          <h3 id="cleanup-map-title">{t("cleanup.map.title")}</h3>
          <p>{t("cleanup.map.description")}</p>
          <nav className="cleanup-map__breadcrumbs" aria-label={t("cleanup.map.breadcrumbs")}>
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
      </header>

      <div className="cleanup-map__workspace">
        <div className="cleanup-map__visual">
          <div className="cleanup-map__canvas" ref={canvasRef}>
          {freshness !== "current" ? (
            <div className={`cleanup-map__freshness is-${freshness}`} role="status">
              {freshness === "changed" ? <RefreshCw size={13} /> : <Clock3 size={13} />}
              <span>{t(`cleanup.map.freshness.${freshness}`)}</span>
            </div>
          ) : null}
          <svg viewBox="0 0 360 360" role="img" aria-label={t("cleanup.map.ariaLabel", { name: focus.name })}>
            <g className={`cleanup-map__rings${focusChanged ? " is-changed" : ""}`} key={focus.id}>
              {arcs.map((arc, index) => (
                <path
                  className={`cleanup-map__arc${selected.id === arc.node.id ? " is-selected" : ""}${changedIds.has(arc.node.id) ? " is-changed" : ""}${canCollectCleanupNode(arc.node) ? "" : " is-not-collectable"}`}
                  d={arc.path}
                  fill={colorForNode(arc.node, focus, nodes, parents)}
                  key={`${focus.id}:${arc.node.id}:${arc.depth}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${arc.node.name} ${formatBytes(arc.node.sizeBytes)}`}
                  style={{ animationDelay: `${Math.min(index * 12, 180)}ms` }}
                  onMouseEnter={() => setSelectedId(arc.node.id)}
                  onFocus={() => setSelectedId(arc.node.id)}
                  onClick={() => {
                    if (suppressNextClickRef.current) {
                      suppressNextClickRef.current = false;
                      return;
                    }
                    drillInto(arc.node);
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                  onPointerDown={(event) => beginDrag(event, arc.node)}
                  onLostPointerCapture={(event) => cancelDragAt(event.pointerId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      drillInto(arc.node);
                    }
                  }}
                />
              ))}
            </g>
            <g
              className={`cleanup-map__center-control${parentId ? " is-interactive" : ""}`}
              role={parentId ? "button" : undefined}
              tabIndex={parentId ? 0 : undefined}
              aria-label={parentId ? t("cleanup.map.centerBack") : undefined}
              onClick={() => {
                const parent = parentId ? nodes.get(parentId) : null;
                if (parent) navigateTo(parent);
              }}
              onKeyDown={(event) => {
                if (parentId && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  const parent = nodes.get(parentId);
                  if (parent) navigateTo(parent);
                }
              }}
            >
              <circle className={`cleanup-map__center${focusChanged ? " is-changed" : ""}`} cx="180" cy="180" r="52" />
              <text className="cleanup-map__center-label" x="180" y={focusChanged ? "165" : "172"} textAnchor="middle">{truncateLabel(focus.name)}</text>
              <text className="cleanup-map__center-value" x="180" y={focusChanged ? "188" : "195"} textAnchor="middle">{formatBytes(focus.sizeBytes)}</text>
              {focusChanged ? <text className="cleanup-map__center-state" x="180" y="207" textAnchor="middle">{t("cleanup.map.freshness.changedShort")}</text> : null}
            </g>
          </svg>
          </div>
          <span>{t("cleanup.map.clickToDrill")}</span>
        </div>

        <aside className="cleanup-map__details" aria-label={t("cleanup.map.details")}>
          <div className="cleanup-map__selected">
            <span className="cleanup-map__selected-icon"><FolderOpen size={17} /></span>
            <div>
              <small>{t("cleanup.map.selected")}</small>
              <strong>{selected.name}</strong>
              <code title={selected.path ?? selected.name}>{selected.path ?? t("cleanup.map.grouped")}</code>
            </div>
            <span><strong>{formatBytes(selected.sizeBytes)}</strong><small>{t("cleanup.itemCount", { count: selected.itemCount })}</small></span>
          </div>

          <div className={`cleanup-map__plan cleanup-map__dropzone${dragState?.dragging ? " is-dragging" : ""}${dragState?.overDropzone ? " is-active" : ""}${planned.length > 0 ? " has-items" : ""}${trashOutcome ? " has-outcome" : ""}`}>
            <span className="cleanup-map__basket-icon"><Trash2 size={19} /></span>
            <div className="cleanup-map__basket-copy">
              <small>{dragState?.overDropzone ? t("cleanup.map.basket.release") : t("cleanup.map.basket.title")}</small>
              <strong>{planned.length > 0
                  ? t("cleanup.map.planSummary", { count: planned.length, size: formatBytes(plannedBytes) })
                  : trashOutcome
                  ? t(
                      trashOutcome.failedCount > 0
                        ? "cleanup.map.basket.partial"
                        : "cleanup.map.basket.completed",
                      {
                        movedCount: trashOutcome.movedCount,
                        failedCount: trashOutcome.failedCount,
                      },
                    )
                  : t("cleanup.map.basket.empty")}</strong>
              {planned.length > 0 ? (
                <div className="cleanup-map__basket-items">
                  {planned.map((node) => (
                    <button type="button" key={node.id} onClick={() => removeFromPlan(node.id)} title={t("cleanup.map.basket.remove", { name: node.name })}>
                      <span>{node.name}</span><X size={11} />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {planned.length > 0 ? (
              <button className="cleanup-map__basket-clear" type="button" onClick={() => setPlannedIds(new Set())}>
                {t("cleanup.map.basket.clear")}
              </button>
            ) : null}
            <button
              className="button button--danger"
              type="button"
              disabled={planned.length === 0 || !snapshot.deletionAvailable}
              onClick={() => void openTrashDialog()}
            >
              {trashOutcome && planned.length === 0 ? <CheckCircle2 size={14} /> : <Trash2 size={14} />}
              {snapshot.deletionAvailable ? t("cleanup.map.reviewCleanup") : t("cleanup.map.deletionUnavailable")}
            </button>
          </div>

          {focus.children.length > 0 ? (
            <ol className="cleanup-map__legend">
              {focus.children.slice(0, 12).map((child, index) => (
                <li key={child.id}>
                  <button
                    className={selected.id === child.id ? "is-selected" : undefined}
                    type="button"
                    onMouseEnter={() => setSelectedId(child.id)}
                    onFocus={() => setSelectedId(child.id)}
                    onClick={() => drillInto(child)}
                  >
                    <i style={{ background: ARC_COLORS[index % ARC_COLORS.length] }} />
                    <span><strong>{child.name}</strong><small>{percentage(child.sizeBytes, focus.sizeBytes)}</small></span>
                    <b>{formatBytes(child.sizeBytes)}</b>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="cleanup-map__leaf">{t("cleanup.map.noDeeperBreakdown")}</div>
          )}

          <div className="cleanup-map__review">
            <span><ShieldAlert size={14} />{t(`cleanup.safety.${selected.safety}`)}</span>
            <small>{t(isTrashPath(selected.path) ? "cleanup.map.alreadyInTrash" : "cleanup.map.directActionHint")}</small>
          </div>
        </aside>
      </div>
      {dragState?.dragging ? (
        <div className={`cleanup-map__drag-preview${dragState.overDropzone ? " is-over" : ""}`} style={{ left: dragState.x, top: dragState.y }} aria-hidden="true">
          <FolderOpen size={14} />
          <span>{nodes.get(dragState.nodeId)?.name}</span>
          <strong>{formatBytes(nodes.get(dragState.nodeId)?.sizeBytes ?? 0)}</strong>
        </div>
      ) : null}
      {trashDialogOpen ? (
        <CleanupTrashDialog
          items={trashDialogItems}
          lease={trashLease}
          preparing={trashPreparing}
          submitting={trashSubmitting}
          error={trashError}
          reviewAcknowledged={reviewAcknowledged}
          onReviewAcknowledgedChange={setReviewAcknowledged}
          onCancel={closeTrashDialog}
          onConfirm={() => void confirmMoveToTrash()}
        />
      ) : null}
    </section>
  );
}

function canCollectCleanupNode(node: CleanupMapNode): boolean {
  return node.path !== null && !isTrashPath(node.path);
}

function isTrashPath(path: string | null): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/").toLocaleLowerCase();
  return normalized === "~/.trash" ||
    normalized.startsWith("~/.trash/") ||
    normalized.includes("/.local/share/trash/files");
}

function localizeOtherNode(node: CleanupNode): CleanupMapNode {
  return {
    ...node,
    name: node.path === null && node.name === "other" ? "…" : node.name,
    children: node.children.map(localizeOtherNode),
  };
}

function indexTree(root: CleanupMapNode) {
  const nodes = new Map<string, CleanupMapNode>();
  const parents = new Map<string, string>();
  const visit = (node: CleanupMapNode, parent: string | null) => {
    nodes.set(node.id, node);
    if (parent) parents.set(node.id, parent);
    node.children.forEach((child) => visit(child, node.id));
  };
  visit(root, null);
  return { nodes, parents };
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

function colorForNode(
  node: CleanupMapNode,
  focus: CleanupMapNode,
  nodes: Map<string, CleanupMapNode>,
  parents: Map<string, string>,
) {
  const onlyChild = focus.children.length === 1 ? focus.children[0] : null;
  if (onlyChild && node.id !== onlyChild.id && onlyChild.children.length > 0) {
    let branch = node;
    let parentId = parents.get(branch.id);
    while (parentId && parentId !== onlyChild.id) {
      const parent = nodes.get(parentId);
      if (!parent) break;
      branch = parent;
      parentId = parents.get(branch.id);
    }
    const nestedIndex = Math.max(
      0,
      onlyChild.children.findIndex((child) => child.id === branch.id),
    );
    return ARC_COLORS[nestedIndex % ARC_COLORS.length];
  }
  let branch = node;
  let parentId = parents.get(branch.id);
  while (parentId && parentId !== focus.id) {
    const parent = nodes.get(parentId);
    if (!parent) break;
    branch = parent;
    parentId = parents.get(branch.id);
  }
  const index = Math.max(0, focus.children.findIndex((child) => child.id === branch.id));
  return ARC_COLORS[index % ARC_COLORS.length];
}

function percentage(value: number, total: number) {
  return total <= 0 ? "0%" : `${Math.max(0.1, value / total * 100).toFixed(value / total >= 0.1 ? 0 : 1)}%`;
}

function truncateLabel(value: string) {
  return value.length > 12 ? `${value.slice(0, 11)}…` : value;
}
