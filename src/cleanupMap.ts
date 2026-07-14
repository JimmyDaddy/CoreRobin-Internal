import type { CleanupNode, CleanupSafety } from "./types";

export interface CleanupMapNode extends CleanupNode {
  safety: CleanupSafety;
}

export interface CleanupMapArc {
  node: CleanupMapNode;
  depth: number;
  startAngle: number;
  endAngle: number;
  path: string;
}

export function collectCleanupPlanNode(
  current: ReadonlySet<string>,
  nodeId: string,
  parents: ReadonlyMap<string, string>,
): Set<string> {
  if (current.has(nodeId) || [...current].some((id) => isCleanupAncestor(id, nodeId, parents))) {
    return new Set(current);
  }
  const next = new Set([...current].filter((id) => !isCleanupAncestor(nodeId, id, parents)));
  next.add(nodeId);
  return next;
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

const FULL_CIRCLE = Math.PI * 2;
const START_ANGLE = -Math.PI / 2;

export function layoutCleanupMap(
  root: CleanupMapNode,
  maxDepth = 3,
): CleanupMapArc[] {
  const arcs: CleanupMapArc[] = [];
  layoutChildren(root, 1, START_ANGLE, START_ANGLE + FULL_CIRCLE, maxDepth, arcs);
  return arcs;
}

function layoutChildren(
  parent: CleanupMapNode,
  depth: number,
  startAngle: number,
  endAngle: number,
  maxDepth: number,
  output: CleanupMapArc[],
) {
  if (depth > maxDepth) return;
  const children = parent.children.filter((child) => child.sizeBytes > 0);
  const total = children.reduce((sum, child) => sum + child.sizeBytes, 0);
  if (total <= 0) return;

  let cursor = startAngle;
  children.forEach((child, index) => {
    const fraction = child.sizeBytes / total;
    const childEnd = index === children.length - 1
      ? endAngle
      : cursor + (endAngle - startAngle) * fraction;
    const innerRadius = 55 + (depth - 1) * 38;
    const outerRadius = innerRadius + 34;
    output.push({
      node: child,
      depth,
      startAngle: cursor,
      endAngle: childEnd,
      path: annularSectorPath(180, 180, innerRadius, outerRadius, cursor, childEnd),
    });
    layoutChildren(child, depth + 1, cursor, childEnd, maxDepth, output);
    cursor = childEnd;
  });
}

export function annularSectorPath(
  centerX: number,
  centerY: number,
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  rawEndAngle: number,
): string {
  const endAngle = Math.min(rawEndAngle, startAngle + FULL_CIRCLE - 0.000_001);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const outerStart = polarPoint(centerX, centerY, outerRadius, startAngle);
  const outerEnd = polarPoint(centerX, centerY, outerRadius, endAngle);
  const innerEnd = polarPoint(centerX, centerY, innerRadius, endAngle);
  const innerStart = polarPoint(centerX, centerY, innerRadius, startAngle);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function polarPoint(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
) {
  return {
    x: Number((centerX + Math.cos(angle) * radius).toFixed(3)),
    y: Number((centerY + Math.sin(angle) * radius).toFixed(3)),
  };
}
