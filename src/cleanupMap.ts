import type { CleanupNode, CleanupSafety } from "./types";

export interface CleanupMapNode extends CleanupNode {
  safety: CleanupSafety;
}

export interface CleanupMapArc {
  node: CleanupMapNode;
  depth: number;
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
}

export interface CleanupNodeVisual {
  fill: string;
  swatch: string;
  className: "is-folder" | "is-file" | "is-aggregate" | "is-restricted";
}

export const CLEANUP_MAP_SIZE = 420;
export const CLEANUP_MAP_CENTER = CLEANUP_MAP_SIZE / 2;
export const CLEANUP_MAP_CENTER_RADIUS = 50;
export const CLEANUP_MAP_MAX_DEPTH = 5;
export const CLEANUP_MAP_MAX_ARCS = 640;

const RING_WIDTHS = [34, 32, 30, 28, 26] as const;
const FULL_CIRCLE = Math.PI * 2;
const START_ANGLE = -Math.PI / 2;
const MIN_VISIBLE_ANGLE = 0.0025;
const ROOT_HUES = [212, 146, 286, 42, 352, 184, 252, 322] as const;
const LOCATION_HUES: Record<string, number> = {
  "location:downloads": 42,
  "location:trash": 4,
  "location:app_cache": 286,
  "location:developer_cache": 212,
  "location:hidden_data": 148,
};

export function collectCleanupPlanNode(
  current: ReadonlySet<string>,
  nodeId: string,
  parents: ReadonlyMap<string, string>,
): Set<string> {
  if (isCleanupNodeCoveredByPlan(current, nodeId, parents)) {
    return new Set(current);
  }
  const next = new Set([...current].filter((id) => !isCleanupAncestor(nodeId, id, parents)));
  next.add(nodeId);
  return next;
}

export function isCleanupNodeCoveredByPlan(
  current: ReadonlySet<string>,
  nodeId: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  return current.has(nodeId) || [...current].some((id) => isCleanupAncestor(id, nodeId, parents));
}

export function isCleanupAncestor(
  candidate: string,
  nodeId: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  let parent = parents.get(nodeId);
  while (parent) {
    if (parent === candidate) return true;
    parent = parents.get(parent);
  }
  return false;
}

export function layoutCleanupMap(
  root: CleanupMapNode,
  maxDepth = CLEANUP_MAP_MAX_DEPTH,
  maxArcs = CLEANUP_MAP_MAX_ARCS,
): CleanupMapArc[] {
  const arcs: CleanupMapArc[] = [];
  const queue: Array<{
    parent: CleanupMapNode;
    depth: number;
    startAngle: number;
    endAngle: number;
  }> = [{ parent: root, depth: 1, startAngle: START_ANGLE, endAngle: START_ANGLE + FULL_CIRCLE }];

  while (queue.length > 0 && arcs.length < maxArcs) {
    const request = queue.shift();
    if (!request || request.depth > maxDepth) continue;
    layoutChildren(request, maxDepth, maxArcs, arcs, queue);
  }
  return arcs;
}

function layoutChildren(
  request: {
    parent: CleanupMapNode;
    depth: number;
    startAngle: number;
    endAngle: number;
  },
  maxDepth: number,
  maxArcs: number,
  output: CleanupMapArc[],
  queue: Array<{
    parent: CleanupMapNode;
    depth: number;
    startAngle: number;
    endAngle: number;
  }>,
) {
  const { parent, depth, startAngle, endAngle } = request;
  const children = parent.children
    .filter((child) => child.kind !== "restricted" && child.allocatedSizeBytes > 0)
    .sort((left, right) => right.allocatedSizeBytes - left.allocatedSizeBytes || left.name.localeCompare(right.name));
  const restricted = parent.children.filter((child) => child.kind === "restricted");
  const childrenTotal = children.reduce((sum, child) => sum + child.allocatedSizeBytes, 0);
  const denominator = Math.max(parent.allocatedSizeBytes, childrenTotal);

  const { innerRadius, outerRadius } = ringBounds(depth);
  const candidates: CleanupMapArc[] = [];
  let cursor = startAngle;
  if (denominator > 0) {
    for (const child of children) {
      const childEnd = Math.min(
        endAngle,
        cursor + (endAngle - startAngle) * (child.allocatedSizeBytes / denominator),
      );
      if (childEnd - cursor <= Number.EPSILON) continue;
      candidates.push({
        node: child,
        depth,
        startAngle: cursor,
        endAngle: childEnd,
        innerRadius,
        outerRadius,
      });
      cursor = childEnd;
    }
  }

  const remaining = Math.max(0, maxArcs - output.length);
  if (remaining === 0) return;
  const firstTinyIndex = candidates.findIndex((arc) => arc.endAngle - arc.startAngle < MIN_VISIBLE_ANGLE);
  const meaningfulCount = firstTinyIndex === -1 ? candidates.length : firstTinyIndex;
  const realLimit = Math.min(meaningfulCount, remaining);
  const needsAggregate = realLimit < candidates.length;
  const visibleRealCount = needsAggregate && realLimit === remaining
    ? Math.max(0, realLimit - 1)
    : realLimit;
  const visible = candidates.slice(0, visibleRealCount);
  output.push(...visible);

  if (needsAggregate && output.length < maxArcs) {
    const hidden = candidates.slice(visibleRealCount);
    const first = hidden[0];
    const last = hidden[hidden.length - 1];
    if (first && last) {
      output.push({
        node: createVisualAggregate(parent, depth, hidden.map((arc) => arc.node)),
        depth,
        startAngle: first.startAngle,
        endAngle: last.endAngle,
        innerRadius,
        outerRadius,
      });
    }
  }

  if (depth < maxDepth) {
    for (const arc of visible) {
      if (arc.node.children.length === 0) continue;
      queue.push({
        parent: arc.node,
        depth: depth + 1,
        startAngle: arc.startAngle,
        endAngle: arc.endAngle,
      });
    }
  }

  restricted.forEach((child, index) => {
    if (output.length >= maxArcs) return;
    const markerSpan = Math.min((endAngle - startAngle) * 0.025, 0.014);
    const markerEnd = endAngle - index * markerSpan * 1.35;
    const markerStart = Math.max(startAngle, markerEnd - markerSpan);
    output.push({
      node: child,
      depth,
      startAngle: markerStart,
      endAngle: markerEnd,
      innerRadius: Math.max(innerRadius, outerRadius - 6),
      outerRadius,
    });
  });
}

function createVisualAggregate(
  parent: CleanupMapNode,
  depth: number,
  nodes: CleanupMapNode[],
): CleanupMapNode {
  return {
    id: `${parent.id}::visual-aggregate:${depth}`,
    name: "smaller-objects",
    path: null,
    sizeBytes: nodes.reduce((total, node) => total + node.sizeBytes, 0),
    logicalSizeBytes: nodes.reduce((total, node) => total + node.logicalSizeBytes, 0),
    allocatedSizeBytes: nodes.reduce((total, node) => total + node.allocatedSizeBytes, 0),
    itemCount: nodes.reduce((total, node) => total + node.itemCount, 0),
    safety: parent.safety,
    kind: "aggregate",
    deletionProtected: true,
    protectionReason: "aggregate",
    hasChildren: false,
    children: [],
  };
}

export function ringBounds(depth: number): { innerRadius: number; outerRadius: number } {
  const safeDepth = Math.max(1, Math.min(Math.floor(depth), RING_WIDTHS.length));
  let innerRadius = CLEANUP_MAP_CENTER_RADIUS + 3;
  for (let index = 0; index < safeDepth - 1; index += 1) {
    innerRadius += RING_WIDTHS[index];
  }
  return { innerRadius, outerRadius: innerRadius + RING_WIDTHS[safeDepth - 1] - 2 };
}

export function hitTestCleanupMap(
  arcs: readonly CleanupMapArc[],
  x: number,
  y: number,
): CleanupMapArc | null {
  const offsetX = x - CLEANUP_MAP_CENTER;
  const offsetY = y - CLEANUP_MAP_CENTER;
  const radius = Math.hypot(offsetX, offsetY);
  let angle = Math.atan2(offsetY, offsetX);
  if (angle < START_ANGLE) angle += FULL_CIRCLE;

  for (let index = arcs.length - 1; index >= 0; index -= 1) {
    const arc = arcs[index];
    if (radius < arc.innerRadius || radius > arc.outerRadius) continue;
    if (angle >= arc.startAngle && angle <= arc.endAngle) return arc;
  }
  return null;
}

export function buildCleanupHueMap(root: CleanupMapNode): Map<string, number> {
  const hues = new Map<string, number>();
  hues.set(root.id, ROOT_HUES[stableHash(root.id) % ROOT_HUES.length]);
  const children = [...root.children].sort((left, right) => right.allocatedSizeBytes - left.allocatedSizeBytes);
  children.forEach((child, index) => {
    const hue = LOCATION_HUES[child.id] ?? ROOT_HUES[stableHash(child.id) % ROOT_HUES.length] ?? ROOT_HUES[index % ROOT_HUES.length];
    assignBranchHues(child, hue, hue, hues);
  });
  return hues;
}

function assignBranchHues(
  node: CleanupMapNode,
  hue: number,
  branchHue: number,
  output: Map<string, number>,
) {
  output.set(node.id, normalizeHue(hue));
  for (const child of node.children) {
    const unit = stableHash(child.id) / 0xffff_ffff;
    const offset = (unit - 0.5) * 52;
    assignBranchHues(child, branchHue + offset, branchHue, output);
  }
}

export function cleanupNodeVisual(
  node: CleanupMapNode,
  depth: number,
  hues: ReadonlyMap<string, number>,
): CleanupNodeVisual {
  const hue = hues.get(node.id) ?? ROOT_HUES[stableHash(node.id) % ROOT_HUES.length];
  if (node.kind === "file") {
    const lightness = Math.min(69, 51 + depth * 2.2);
    const color = `hsl(214 8% ${lightness.toFixed(1)}%)`;
    return { fill: color, swatch: color, className: "is-file" };
  }
  if (node.kind === "aggregate") {
    const color = `hsla(${hue.toFixed(1)} 24% 68% / 0.46)`;
    return { fill: color, swatch: `hsl(${hue.toFixed(1)} 24% 68%)`, className: "is-aggregate" };
  }
  if (node.kind === "restricted") {
    return { fill: "#8b5cf6", swatch: "#a78bfa", className: "is-restricted" };
  }
  const lightness = Math.min(72, 58 + depth * 2.3);
  const color = `hsl(${hue.toFixed(1)} 78% ${lightness.toFixed(1)}%)`;
  return { fill: color, swatch: color, className: "is-folder" };
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeHue(value: number): number {
  return (value % 360 + 360) % 360;
}
