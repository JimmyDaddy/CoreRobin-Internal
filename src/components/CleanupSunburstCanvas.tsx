import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  CLEANUP_MAP_CENTER,
  CLEANUP_MAP_SIZE,
  cleanupNodeVisual,
  hitTestCleanupMap,
  type CleanupMapArc,
  type CleanupMapNode,
  type CleanupNodeVisual,
} from "../cleanupMap";
import { cleanupHatchPattern } from "../cleanupCanvasPatterns";
import { cleanupNodeProtection } from "../cleanupProtection";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { formatBytes } from "../utils";
import type { CleanupScanJobPhase } from "../types";
import { CleanupScanScene, drawCleanupScanScene } from "../cleanupScanScene";

interface DrawableArc {
  arc: CleanupMapArc;
  visual: CleanupNodeVisual;
}

interface PieLayerCacheEntry {
  arcs: readonly DrawableArc[];
  backingSize: number;
  collectedIds: ReadonlySet<string>;
  changedIds: ReadonlySet<string>;
  layer: HTMLCanvasElement;
  pixelRatio: number;
  themeKey: string;
}

interface CleanupMapTooltip {
  alignLeft: boolean;
  node: CleanupMapNode;
  x: number;
  y: number;
}

interface CleanupSunburstCanvasProps {
  arcs: readonly CleanupMapArc[];
  hues: ReadonlyMap<string, number>;
  selectedId: string;
  changedIds: ReadonlySet<string>;
  collectedIds: ReadonlySet<string>;
  focusKey: string;
  ariaLabel: string;
  scanKey?: string;
  scanPhase?: CleanupScanJobPhase | null;
  motionAllowed?: boolean;
  onSelect: (node: CleanupMapNode | null) => void;
  onActivate: (node: CleanupMapNode) => void;
  onCollect: (node: CleanupMapNode) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>, node: CleanupMapNode) => void;
  onPointerCancel: (pointerId: number) => void;
}

export const CleanupSunburstCanvas = memo(function CleanupSunburstCanvas({
  arcs,
  hues,
  selectedId,
  changedIds,
  collectedIds,
  focusKey,
  ariaLabel,
  scanKey = "",
  scanPhase = null,
  motionAllowed = false,
  onSelect,
  onActivate,
  onCollect,
  onPointerDown,
  onPointerCancel,
}: CleanupSunburstCanvasProps) {
  const { t } = useAppTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef(0);
  const sceneRef = useRef(new CleanupScanScene());
  const hoveredIdRef = useRef<string | null>(null);
  const pieLayerCacheRef = useRef<PieLayerCacheEntry[]>([]);
  const [canvasWidth, setCanvasWidth] = useState(CLEANUP_MAP_SIZE);
  const [tooltip, setTooltip] = useState<CleanupMapTooltip | null>(null);
  const firstRingBytes = useMemo(
    () => arcs
      .filter((arc) => arc.depth === 1)
      .reduce((total, arc) => total + arc.node.allocatedSizeBytes, 0),
    [arcs],
  );
  const drawableArcs = useMemo(
    () => arcs.map((arc) => ({ arc, visual: cleanupNodeVisual(arc.node, arc.depth, hues) })),
    [arcs, hues],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
      setCanvasWidth((current) => current === width ? current : width);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const backingSize = Math.max(1, Math.round(canvasWidth * pixelRatio));
    if (canvas.width !== backingSize || canvas.height !== backingSize) {
      canvas.width = backingSize;
      canvas.height = backingSize;
    }
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const themeKey = cleanupCanvasThemeKey(canvas);
    const layer = pieLayer(pieLayerCacheRef.current, canvas, drawableArcs,
      changedIds, collectedIds, backingSize, pixelRatio, themeKey);
    const scene = sceneRef.current;
    scene.update(arcs, scanKey, focusKey, scanPhase);
    const selected = drawableArcs.find(({ arc }) => arc.node.id === selectedId);
    const light = themeKey.includes("light");
    let lastPaint = -Infinity;
    const paint = (now: number) => {
      const continuing = scene.advance(now, motionAllowed);
      resetCanvas(context, backingSize);
      configureLogicalCoordinates(context, canvasWidth, pixelRatio);
      // Geometry commits atomically. The pie never zooms independently of its halo.
      if (layer) context.drawImage(layer, 0, 0, CLEANUP_MAP_SIZE, CLEANUP_MAP_SIZE);
      drawCleanupScanScene(context, arcs, scene, motionAllowed, light);
      if (selected) drawArcState(context, selected, true, false);
      lastPaint = now;
      return continuing;
    };
    const tick = (now: number) => {
      // Cache the expensive 640-sector pie; animate only its small overlay at 30fps.
      if (now - lastPaint < 1_000 / 30 - 1) {
        animationFrameRef.current = window.requestAnimationFrame(tick);
      } else if (paint(now)) {
        animationFrameRef.current = window.requestAnimationFrame(tick);
      }
    };
    if (paint(performance.now())) animationFrameRef.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrameRef.current);
  }, [arcs, canvasWidth, changedIds, collectedIds, drawableArcs, focusKey, selectedId, scanKey, scanPhase, motionAllowed]);

  const arcAtPointer = (event: {
    currentTarget: HTMLCanvasElement;
    clientX: number;
    clientY: number;
  }) => {
    const point = logicalPointerPoint(event);
    return hitTestCleanupMap(arcs, point.x, point.y);
  };

  const tooltipProtection = tooltip
    ? cleanupNodeProtection(tooltip.node)
    : null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="cleanup-map__sunburst"
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        onContextMenu={(event) => event.preventDefault()}
        onPointerMove={(event) => {
          const hit = arcAtPointer(event);
          event.currentTarget.style.cursor = hit ? "pointer" : "default";
          if (hit) {
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = Math.max(12, Math.min(bounds.width - 12, event.clientX - bounds.left));
            const y = Math.max(34, Math.min(bounds.height - 34, event.clientY - bounds.top));
            setTooltip({
              alignLeft: x > bounds.width / 2,
              node: hit.node,
              x,
              y,
            });
          } else {
            setTooltip(null);
          }
          const nextId = hit?.node.id ?? null;
          if (hoveredIdRef.current === nextId) return;
          hoveredIdRef.current = nextId;
          onSelect(hit?.node ?? null);
        }}
        onPointerLeave={() => {
          hoveredIdRef.current = null;
          setTooltip(null);
          onSelect(null);
        }}
        onClick={(event) => {
          const hit = arcAtPointer(event);
          if (hit) onActivate(hit.node);
        }}
        onKeyDown={(event) => {
          const selected = arcs.find((arc) => arc.node.id === selectedId)?.node
            ?? arcs[0]?.node;
          if (!selected) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onActivate(selected);
          } else if (event.key === " ") {
            event.preventDefault();
            onCollect(selected);
          }
        }}
        onPointerDown={(event) => {
          const hit = arcAtPointer(event);
          if (hit) onPointerDown(event, hit.node);
        }}
        onLostPointerCapture={(event) => onPointerCancel(event.pointerId)}
      />
      {tooltip ? (
        <div
          className={`cleanup-map__tooltip${tooltip.alignLeft ? " is-left" : ""}`}
          style={{ left: tooltip.x, top: tooltip.y }}
          aria-hidden="true"
        >
          <strong>{tooltip.node.name}</strong>
          <span>
            {formatBytes(tooltip.node.allocatedSizeBytes)}
            {firstRingBytes > 0
              ? ` · ${Math.max(0.1, tooltip.node.allocatedSizeBytes / firstRingBytes * 100).toFixed(1)}%`
              : ""}
          </span>
          {tooltipProtection ? (
            <small className={tooltipProtection === "aggregate" ? "is-aggregate" : "is-protected"}>
              {t(tooltipProtection === "aggregate"
                ? "cleanup:map.aggregateBadge"
                : "cleanup:map.basket.protectedBadge")}
            </small>
          ) : null}
        </div>
      ) : null}
    </>
  );
});

function logicalPointerPoint(event: {
  currentTarget: HTMLCanvasElement;
  clientX: number;
  clientY: number;
}) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const scale = CLEANUP_MAP_SIZE / Math.max(1, bounds.width);
  return {
    x: (event.clientX - bounds.left) * scale,
    y: (event.clientY - bounds.top) * scale,
  };
}

function resetCanvas(context: CanvasRenderingContext2D, backingSize: number) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, backingSize, backingSize);
}

function configureLogicalCoordinates(
  context: CanvasRenderingContext2D,
  canvasWidth: number,
  pixelRatio: number,
) {
  const scale = canvasWidth * pixelRatio / CLEANUP_MAP_SIZE;
  context.setTransform(scale, 0, 0, scale, 0, 0);
}

function drawArcBase(
  context: CanvasRenderingContext2D,
  { arc, visual }: DrawableArc,
  restrictedPattern: CanvasPattern | null,
) {
  context.save();
  drawArcPath(context, arc);
  const collectionAlpha = context.globalAlpha;
  context.fillStyle = visual.fill;
  context.globalAlpha = collectionAlpha * (arc.node.kind === "file" ? 0.76 : 0.96);
  context.fill();

  if (arc.node.kind === "restricted") {
    context.save();
    context.clip();
    context.fillStyle = restrictedPattern ?? "rgba(232, 220, 255, 0.38)";
    context.fillRect(0, 0, CLEANUP_MAP_SIZE, CLEANUP_MAP_SIZE);
    context.restore();
  }

  context.globalAlpha = collectionAlpha;
  context.strokeStyle = "rgba(7, 16, 23, 0.9)";
  context.lineWidth = 1.35;
  context.stroke();
  context.restore();
}

function drawArcState(
  context: CanvasRenderingContext2D,
  { arc }: DrawableArc,
  selected: boolean,
  changed: boolean,
) {
  if (!selected && !changed) return;
  context.save();
  drawArcPath(context, arc);
  if (changed) {
    context.strokeStyle = "rgba(251, 191, 36, 0.95)";
    context.setLineDash([4, 3]);
    context.lineWidth = 2;
    context.stroke();
  }
  if (selected) {
    context.setLineDash([]);
    context.strokeStyle = "rgba(244, 250, 255, 0.96)";
    context.lineWidth = 2.5;
    context.stroke();
    context.fillStyle = "rgba(255, 255, 255, 0.1)";
    context.fill();
  }
  context.restore();
}

function drawArcPath(
  context: CanvasRenderingContext2D,
  arc: CleanupMapArc,
) {
  const endAngle = Math.min(
    arc.endAngle,
    arc.startAngle + Math.PI * 2 - 0.000_001,
  );
  context.beginPath();
  context.arc(
    CLEANUP_MAP_CENTER,
    CLEANUP_MAP_CENTER,
    arc.outerRadius,
    arc.startAngle,
    endAngle,
  );
  context.arc(
    CLEANUP_MAP_CENTER,
    CLEANUP_MAP_CENTER,
    arc.innerRadius,
    endAngle,
    arc.startAngle,
    true,
  );
  context.closePath();
}

function pieLayer(
  cache: PieLayerCacheEntry[],
  canvas: HTMLCanvasElement,
  arcs: readonly DrawableArc[],
  changedIds: ReadonlySet<string>,
  collectedIds: ReadonlySet<string>,
  backingSize: number,
  pixelRatio: number,
  themeKey: string,
): HTMLCanvasElement | null {
  const cached = cache.find(
    (entry) =>
      entry.arcs === arcs &&
      entry.collectedIds === collectedIds &&
      entry.changedIds === changedIds &&
      entry.backingSize === backingSize &&
      entry.pixelRatio === pixelRatio &&
      entry.themeKey === themeKey,
  );
  if (cached) return cached.layer;

  const layer = canvas.ownerDocument.createElement("canvas");
  layer.width = backingSize;
  layer.height = backingSize;
  const context = layer.getContext("2d", { alpha: true });
  if (!context) return null;
  resetCanvas(context, backingSize);
  configureLogicalCoordinates(context, backingSize / pixelRatio, pixelRatio);
  const restrictedPattern = cleanupHatchPattern(context, {
    color: "rgba(232, 220, 255, 0.72)", lineWidth: 2, pixelRatio, spacing: 8, themeKey,
  });
  for (const drawable of arcs) drawArcBase(context, drawable, restrictedPattern);
  const pattern = collectedIds.size ? cleanupHatchPattern(context, {
    color: "rgba(255, 125, 115, 0.62)",
    lineWidth: 2.4,
    pixelRatio,
    spacing: 11,
    themeKey,
  }) : null;
  drawCollectedOverlays(context, arcs, collectedIds, pattern);
  for (const drawable of arcs) drawArcState(context, drawable, false, changedIds.has(drawable.arc.node.id));
  cache.push({
    arcs,
    backingSize,
    collectedIds,
    changedIds,
    layer,
    pixelRatio,
    themeKey,
  });
  if (cache.length > 2) cache.splice(0, cache.length - 2);
  return layer;
}

function drawCollectedOverlays(
  context: CanvasRenderingContext2D,
  arcs: readonly DrawableArc[],
  collectedIds: ReadonlySet<string>,
  pattern: CanvasPattern | null,
) {
  for (const { arc } of arcs) {
    if (!collectedIds.has(arc.node.id)) continue;
    context.save();
    drawArcPath(context, arc);
    context.save();
    context.clip();
    context.fillStyle = "rgba(8, 14, 19, 0.42)";
    context.fillRect(0, 0, CLEANUP_MAP_SIZE, CLEANUP_MAP_SIZE);
    if (pattern) {
      context.fillStyle = pattern;
      context.fillRect(0, 0, CLEANUP_MAP_SIZE, CLEANUP_MAP_SIZE);
    }
    context.restore();
    context.setLineDash([]);
    context.strokeStyle = "rgba(255, 125, 115, 0.98)";
    context.lineWidth = 2.25;
    context.stroke();
    context.restore();
  }
}

function cleanupCanvasThemeKey(canvas: HTMLCanvasElement): string {
  const root = canvas.ownerDocument.documentElement;
  return [
    root.dataset.theme ?? "default",
    root.dataset.interfaceScale ?? "comfortable",
    canvas.ownerDocument.defaultView?.getComputedStyle(canvas).colorScheme ??
      "normal",
  ].join(":");
}
