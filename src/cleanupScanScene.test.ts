import { describe, expect, it, vi } from "vitest";
import { CLEANUP_MAP_CENTER, layoutCleanupMap, ringBounds, type CleanupMapArc } from "./cleanupMap";
import { getMockCleanupScan } from "./mockData";
import { CleanupScanScene, drawCleanupScanScene } from "./cleanupScanScene";

const arcs = layoutCleanupMap(getMockCleanupScan().root);
const grow = (input: readonly CleanupMapArc[]) => input.map((arc) => ({ ...arc, node: {
  ...arc.node, allocatedSizeBytes: arc.node.allocatedSizeBytes + 100,
} }));

describe("single scan scene", () => {
  it("preserves one clock through discoveries, navigation, pause, visibility and resizing", () => {
    const scene = new CleanupScanScene();
    scene.update(arcs, "scan-1", "root", "scanning");
    scene.advance(100, true);
    scene.advance(1_100, true);
    expect(scene.elapsedMs).toBe(1_000);
    scene.update(grow(arcs), "scan-1", "root", "scanning");
    expect(scene.arrivals.size).toBeGreaterThan(0);
    expect(scene.arrivals.size).toBeLessThanOrEqual(5);
    scene.update(grow(arcs), "scan-1", "folder", "scanning");
    expect(scene.arrivals.size).toBe(0);
    scene.advance(1_200, true);
    expect(scene.elapsedMs).toBe(1_100);
    scene.update(arcs, "scan-1", "folder", "paused");
    expect(scene.advance(2_000, true)).toBe(false);
    scene.update(arcs, "scan-1", "folder", "scanning");
    scene.advance(10_000, true);
    expect(scene.elapsedMs).toBe(1_100);
    scene.advance(10_100, true);
    expect(scene.elapsedMs).toBe(1_200);
    expect(scene.advance(20_000, false)).toBe(false);
    scene.advance(30_000, true);
    expect(scene.elapsedMs).toBe(1_200);
    scene.update(arcs, "scan-2", "root", "scanning");
    expect(scene.elapsedMs).toBe(0);
  });

  it("finishes its only completion pulse and never restarts it on selection or new render", () => {
    const scene = new CleanupScanScene();
    scene.update(arcs, "scan", "root", "scanning");
    scene.advance(0, true);
    scene.advance(500, true);
    scene.update(arcs, "scan", "root", "completed");
    expect(scene.advance(1_000, true)).toBe(true);
    expect(scene.advance(1_500, true)).toBe(false);
    scene.update([...arcs], "scan", "folder", "completed");
    expect(scene.advance(3_000, true)).toBe(false);
    expect(scene.arrivals.size).toBe(0);
  });

  for (let depth = 1; depth <= 5; depth += 1) {
    it(`keeps the inner head, outer head and sweep coaxial at map depth ${depth}`, () => {
      const geometry = [{ ...arcs[0], ...ringBounds(depth), depth }];
      const scene = new CleanupScanScene();
      scene.update(geometry, "scan", "root", "scanning");
      scene.advance(0, true);
      scene.advance(417, true);
      const calls: number[][] = [];
      const context = {
        save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, closePath() {}, moveTo() {}, lineTo() {},
        arc: vi.fn((...args: number[]) => calls.push(args)),
      } as unknown as CanvasRenderingContext2D;
      drawCleanupScanScene(context, geometry, scene, true, false);
      const heads = calls.filter((call) => call[2] === 2);
      expect(heads).toHaveLength(2);
      const angles = heads.map(([x, y]) => Math.atan2(y - CLEANUP_MAP_CENTER, x - CLEANUP_MAP_CENTER));
      expect(angles[0]).toBeCloseTo(angles[1], 10);
      const radii = heads.map(([x, y]) => Math.hypot(x - CLEANUP_MAP_CENTER, y - CLEANUP_MAP_CENTER));
      expect(radii[0]).toBeCloseTo(51);
      expect(radii[1]).toBeGreaterThan(geometry[0].outerRadius);
      for (const [x, y, radius] of calls) {
        expect(Math.min(x - radius, y - radius)).toBeGreaterThanOrEqual(0);
        expect(Math.max(x + radius, y + radius)).toBeLessThanOrEqual(420);
      }
    });
  }
});
