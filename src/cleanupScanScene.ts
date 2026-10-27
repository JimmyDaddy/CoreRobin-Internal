import { CLEANUP_MAP_CENTER, type CleanupMapArc } from "./cleanupMap";
import type { CleanupScanJobPhase } from "./types";

const TAU = Math.PI * 2;
const SETTLE_MS = 900;

export function cleanupScanIsActive(phase: CleanupScanJobPhase | null) {
  return phase === "preparing" || phase === "scanning" || phase === "finalizing";
}

/** One clock survives discoveries, selection, navigation and resizing. */
export class CleanupScanScene {
  elapsedMs = 0;
  phase: CleanupScanJobPhase | null = null;
  arrivals = new Map<string, number>();
  completedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private scanKey = "";
  private focusKey = "";
  private sizes = new Map<string, number>();

  update(arcs: readonly CleanupMapArc[], scanKey: string, focusKey: string, phase: CleanupScanJobPhase | null) {
    const newScan = this.scanKey !== scanKey;
    const newFocus = this.focusKey !== focusKey;
    if (newScan) {
      this.elapsedMs = 0;
      this.lastFrameAt = null;
      this.completedAt = null;
    }
    if (newScan || newFocus || !cleanupScanIsActive(phase)) this.arrivals.clear();
    // Navigation is not a discovery. Look up the CURRENT arcs when painting a pulse.
    if (!newScan && !newFocus && cleanupScanIsActive(phase)) {
      const growing = arcs.filter(({ node, startAngle, endAngle }) =>
        node.allocatedSizeBytes > (this.sizes.get(node.id) ?? 0) && endAngle - startAngle > .035,
      ).sort((a, b) => b.depth - a.depth).slice(0, 5);
      if (growing.length) this.arrivals = new Map(growing.map(({ node }) => [node.id, this.elapsedMs]));
    }
    if (phase === "completed" && cleanupScanIsActive(this.phase) && !newScan) this.completedAt = this.elapsedMs;
    if (phase !== "completed") this.completedAt = null;
    this.scanKey = scanKey;
    this.focusKey = focusKey;
    this.phase = phase;
    this.sizes = new Map(arcs.map(({ node }) => [node.id, node.allocatedSizeBytes]));
  }

  advance(now: number, allowed: boolean) {
    const running = allowed && (cleanupScanIsActive(this.phase) ||
      (this.completedAt !== null && this.elapsedMs - this.completedAt < SETTLE_MS));
    if (!running) { this.lastFrameAt = null; return false; }
    if (this.lastFrameAt !== null) this.elapsedMs += Math.max(0, now - this.lastFrameAt);
    this.lastFrameAt = now;
    return cleanupScanIsActive(this.phase) ||
      (this.completedAt !== null && this.elapsedMs - this.completedAt < SETTLE_MS);
  }
}

/** The halo, sweep and data pulses use the same 420px coordinates as the pie. */
export function drawCleanupScanScene(
  context: CanvasRenderingContext2D,
  arcs: readonly CleanupMapArc[],
  scene: CleanupScanScene,
  motionAllowed: boolean,
  light: boolean,
) {
  if (!scene.phase) return;
  // The DOM center control covers radius 50 plus its border. Keep the entire
  // inner head visible, rather than letting the button obscure its leading tip.
  const inner = 55;
  const outer = Math.max(85, ...arcs.map((arc) => arc.outerRadius));
  const halo = outer + Math.min(7, (CLEANUP_MAP_CENTER - outer) / 2);
  const finished = scene.phase === "completed";
  const ink = finished ? light ? "#23835d" : "#67dfb0"
    : scene.phase === "stalled" ? light ? "#a76a12" : "#f2bf67"
      : light ? "#2b70ba" : "#7ecbff";
  const angle = -Math.PI / 2 + scene.elapsedMs / 3_200 * TAU;
  context.save();
  context.strokeStyle = ink;
  context.fillStyle = ink;
  context.lineWidth = .8;
  context.globalAlpha = finished ? .32 : .18;
  circle(context, halo);
  context.stroke();

  if (!finished) {
    // A single hand drives the inner and outer heads and the sweep between them.
    // No reverse orbit, stage-relative floor, independent zoom or CSS clock.
    for (let index = 0; index < 32; index += 1) {
      const tick = index / 32 * TAU;
      line(context, halo - 1.5, halo + 1.5, tick);
      context.stroke();
    }
    context.globalAlpha = .25;
    circle(context, inner);
    context.stroke();
    if (motionAllowed) {
      for (let index = 0; index < 12; index += 1) {
        const end = angle - index * .045;
        context.globalAlpha = (12 - index) / 12 * (light ? .055 : .075);
        sector(context, inner, outer, end - .045, end);
        context.fill();
      }
      context.globalAlpha = .4;
      context.lineWidth = 1;
      line(context, inner, halo, angle);
      context.stroke();
      for (let index = 0; index < 16; index += 1) {
        const tail = 1 - index / 16;
        context.globalAlpha = tail * tail * .9;
        context.lineWidth = .5 + tail * 2;
        context.shadowColor = ink;
        context.shadowBlur = index < 4 ? 2 : 0;
        for (const radius of [inner, halo]) {
          context.beginPath();
          context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, radius, angle - index * .06 - .08, angle - index * .06);
          context.stroke();
        }
      }
      context.shadowColor = ink;
      context.shadowBlur = 4;
      for (const radius of [inner, halo]) {
        context.globalAlpha = 1;
        dot(context, radius, angle, 2);
        context.fill();
      }
      context.shadowBlur = 0;
      for (const arc of arcs) {
        const start = scene.arrivals.get(arc.node.id);
        if (start === undefined) continue;
        const progress = (scene.elapsedMs - start) / 850;
        if (progress < 0 || progress >= 1) continue;
        const alpha = Math.sin(progress * Math.PI);
        context.globalAlpha = alpha * .18;
        sector(context, arc.innerRadius, arc.outerRadius, arc.startAngle, arc.endAngle);
        context.fill();
        context.globalAlpha = alpha * .8;
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, arc.outerRadius - 1, arc.startAngle, arc.endAngle);
        context.stroke();
        dot(context, (arc.innerRadius + arc.outerRadius) / 2, arc.startAngle + (arc.endAngle - arc.startAngle) * progress, 1.6);
        context.fill();
      }
    }
  } else if (motionAllowed && scene.completedAt !== null) {
    const progress = Math.min(1, (scene.elapsedMs - scene.completedAt) / SETTLE_MS);
    context.globalAlpha = Math.sin(progress * Math.PI) * .65;
    context.lineWidth = 1.5;
    // The pulse stays inside the viewport even at the maximum map depth.
    circle(context, outer + (halo - outer) * progress);
    context.stroke();
  }
  context.restore();
}

function circle(context: CanvasRenderingContext2D, radius: number) {
  context.beginPath();
  context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, radius, 0, TAU);
}

function dot(context: CanvasRenderingContext2D, radius: number, angle: number, size: number) {
  context.beginPath();
  context.arc(CLEANUP_MAP_CENTER + Math.cos(angle) * radius, CLEANUP_MAP_CENTER + Math.sin(angle) * radius, size, 0, TAU);
}

function line(context: CanvasRenderingContext2D, from: number, to: number, angle: number) {
  context.beginPath();
  context.moveTo(CLEANUP_MAP_CENTER + Math.cos(angle) * from, CLEANUP_MAP_CENTER + Math.sin(angle) * from);
  context.lineTo(CLEANUP_MAP_CENTER + Math.cos(angle) * to, CLEANUP_MAP_CENTER + Math.sin(angle) * to);
}

function sector(context: CanvasRenderingContext2D, inner: number, outer: number, start: number, end: number) {
  context.beginPath();
  context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, outer, start, end);
  context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, inner, end, start, true);
  context.closePath();
}
