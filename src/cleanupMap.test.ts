import { describe, expect, it } from "vitest";

import {
  annularSectorPath,
  collectCleanupPlanNode,
  layoutCleanupMap,
  type CleanupMapNode,
} from "./cleanupMap";

function node(
  id: string,
  sizeBytes: number,
  children: CleanupMapNode[] = [],
): CleanupMapNode {
  return {
    id,
    name: id,
    path: id,
    sizeBytes,
    itemCount: 1,
    safety: "review",
    children,
  };
}

describe("cleanup map", () => {
  it("lays out children in proportion to their measured size", () => {
    const arcs = layoutCleanupMap(node("root", 100, [node("large", 75), node("small", 25)]));

    expect(arcs).toHaveLength(2);
    expect(arcs[0].endAngle - arcs[0].startAngle).toBeCloseTo(Math.PI * 1.5);
    expect(arcs[1].endAngle - arcs[1].startAngle).toBeCloseTo(Math.PI * 0.5);
  });

  it("includes nested nodes up to the requested depth", () => {
    const root = node("root", 10, [node("one", 10, [node("two", 10, [node("three", 10)])])]);

    expect(layoutCleanupMap(root, 2).map((arc) => arc.node.id)).toEqual(["one", "two"]);
  });

  it("creates a closed annular path for a full-size segment", () => {
    const path = annularSectorPath(180, 180, 58, 100, -Math.PI / 2, Math.PI * 1.5);

    expect(path).toContain("A 100 100");
    expect(path.endsWith("Z")).toBe(true);
    expect(path).not.toContain("NaN");
  });

  it("keeps cleanup plans free of duplicate and overlapping paths", () => {
    const parents = new Map([
      ["downloads/installers", "downloads"],
      ["downloads/installers/old", "downloads/installers"],
      ["cache", "root"],
    ]);
    let planned = collectCleanupPlanNode(new Set(), "downloads/installers", parents);
    planned = collectCleanupPlanNode(planned, "downloads/installers/old", parents);
    expect([...planned]).toEqual(["downloads/installers"]);

    planned = collectCleanupPlanNode(planned, "downloads", parents);
    expect([...planned]).toEqual(["downloads"]);

    planned = collectCleanupPlanNode(planned, "cache", parents);
    planned = collectCleanupPlanNode(planned, "cache", parents);
    expect([...planned]).toEqual(["downloads", "cache"]);
  });
});
