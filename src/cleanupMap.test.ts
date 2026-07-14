import { describe, expect, it } from "vitest";

import {
  buildCleanupHueMap,
  cleanupNodeVisual,
  collectCleanupPlanNode,
  hitTestCleanupMap,
  layoutCleanupMap,
  ringBounds,
  type CleanupMapNode,
} from "./cleanupMap";
import type { CleanupNodeKind } from "./types";

function node(
  id: string,
  sizeBytes: number,
  children: CleanupMapNode[] = [],
  kind: CleanupNodeKind = "folder",
  logicalSizeBytes = sizeBytes,
): CleanupMapNode {
  return {
    id,
    name: id,
    path: id,
    sizeBytes,
    logicalSizeBytes,
    allocatedSizeBytes: sizeBytes,
    itemCount: 1,
    safety: "review",
    kind,
    hasChildren: children.length > 0,
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

  it("sorts siblings by allocated size and does not inflate missing bytes", () => {
    const root = node("root", 100, [
      node("small", 10, [], "folder", 900),
      node("large", 40, [], "folder", 40),
    ]);
    const arcs = layoutCleanupMap(root);

    expect(arcs.map((arc) => arc.node.id)).toEqual(["large", "small"]);
    expect(arcs[0].endAngle - arcs[0].startAngle).toBeCloseTo(Math.PI * 0.8);
    expect(arcs[1].endAngle - arcs[1].startAngle).toBeCloseTo(Math.PI * 0.2);
    expect(arcs[1].endAngle - arcs[0].startAngle).toBeCloseTo(Math.PI);
  });

  it("includes nested nodes up to the requested depth", () => {
    const root = node("root", 10, [node("one", 10, [node("two", 10, [node("three", 10)])])]);

    expect(layoutCleanupMap(root, 2).map((arc) => arc.node.id)).toEqual(["one", "two"]);
  });

  it("uses progressively thinner rings for five readable levels of context", () => {
    const widths = Array.from({ length: 5 }, (_, index) => {
      const bounds = ringBounds(index + 1);
      return bounds.outerRadius - bounds.innerRadius;
    });

    expect(widths.every((width, index) => index === 0 || width < widths[index - 1])).toBe(true);
    expect(ringBounds(5).outerRadius).toBeLessThanOrEqual(210);
  });

  it("keeps hierarchy colors stable and gives files and aggregates their own semantics", () => {
    const branch = node("location:developer_cache", 80, [
      node("~/cache/file.bin", 50, [], "file"),
      node("~/cache/smaller", 30, [], "aggregate"),
    ]);
    const root = node("root", 100, [branch, node("location:downloads", 20)]);
    const reordered = node("root", 100, [node("location:downloads", 20), branch]);
    const hues = buildCleanupHueMap(root);
    const reorderedHues = buildCleanupHueMap(reordered);

    expect(hues.get(branch.id)).toBe(reorderedHues.get(branch.id));
    expect(cleanupNodeVisual(branch.children[0], 2, hues).className).toBe("is-file");
    expect(cleanupNodeVisual(branch.children[1], 2, hues).className).toBe("is-aggregate");
    expect(cleanupNodeVisual(branch.children[1], 2, hues).fill).toContain("/ 0.46");
  });

  it("renders restricted content as a non-quantitative perimeter marker", () => {
    const root = node("root", 100, [
      node("visible", 100),
      node("restricted", 0, [], "restricted"),
    ]);
    const arcs = layoutCleanupMap(root);
    const visible = arcs.find((arc) => arc.node.id === "visible");
    const restricted = arcs.find((arc) => arc.node.id === "restricted");

    expect(restricted).toBeDefined();
    expect(visible).toBeDefined();
    if (!visible || !restricted) throw new Error("Expected both quantitative and restricted arcs");
    expect(visible.endAngle - visible.startAngle).toBeCloseTo(Math.PI * 2);
    expect(restricted.endAngle - restricted.startAngle).toBeLessThan(0.02);
    expect(restricted.outerRadius - restricted.innerRadius).toBeLessThanOrEqual(6);
  });

  it("bounds the drawable arc count and consolidates the omitted tail", () => {
    const children = Array.from({ length: 1_000 }, (_, index) => node(`child-${index}`, 1));
    const arcs = layoutCleanupMap(node("root", 1_000, children), 1, 50);

    expect(arcs).toHaveLength(50);
    expect(arcs[arcs.length - 1]?.node.kind).toBe("aggregate");
    expect(arcs.reduce((total, arc) => total + arc.node.allocatedSizeBytes, 0)).toBe(1_000);
  });

  it("hit-tests the retained canvas geometry without DOM paths", () => {
    const arcs = layoutCleanupMap(node("root", 100, [node("large", 75), node("small", 25)]));
    const target = arcs[0];
    const angle = (target.startAngle + target.endAngle) / 2;
    const radius = (target.innerRadius + target.outerRadius) / 2;
    const hit = hitTestCleanupMap(
      arcs,
      210 + Math.cos(angle) * radius,
      210 + Math.sin(angle) * radius,
    );

    expect(hit?.node.id).toBe("large");
    expect(hitTestCleanupMap(arcs, 210, 210)).toBeNull();
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
