import {
  memo,
  useEffect,
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

interface DrawableArc {
  arc: CleanupMapArc;
  visual: CleanupNodeVisual;
}

interface CollectedLayerCacheEntry {
  arcs: readonly DrawableArc[];
  backingSize: number;
  collectedIds: ReadonlySet<string>;
  layer: HTMLCanvasElement;
  pixelRatio: number;
  themeKey: string;
}

interface CleanupSunburstCanvasProps {
  arcs: readonly CleanupMapArc[];
  hues: ReadonlyMap<string, number>;
  selectedId: string;
  changedIds: ReadonlySet<string>;
  collectedIds: ReadonlySet<string>;
  focusKey: string;
  ariaLabel: string;
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
  onSelect,
  onActivate,
  onCollect,
  onPointerDown,
  onPointerCancel,
}: CleanupSunburstCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef(0);
  const previousArcsRef = useRef<DrawableArc[]>([]);
  const previousFocusRef = useRef(focusKey);
  const hoveredIdRef = useRef<string | null>(null);
  const collectedLayerCacheRef = useRef<CollectedLayerCacheEntry[]>([]);
  const [canvasWidth, setCanvasWidth] = useState(CLEANUP_MAP_SIZE);
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

  useEffect(() => {
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

    window.cancelAnimationFrame(animationFrameRef.current);
    const previous = previousArcsRef.current;
    const focusChanged = previousFocusRef.current !== focusKey;
    const shouldAnimate = previous.length > 0 &&
      (focusChanged || previous !== drawableArcs) &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const currentCollectedLayer = collectedLayer(
      collectedLayerCacheRef.current,
      canvas,
      drawableArcs,
      collectedIds,
      backingSize,
      pixelRatio,
      themeKey,
    );
    const previousCollectedLayer = shouldAnimate
      ? collectedLayer(
          collectedLayerCacheRef.current,
          canvas,
          previous,
          collectedIds,
          backingSize,
          pixelRatio,
          themeKey,
        )
      : null;
    const restrictedPattern = cleanupHatchPattern(context, {
      color: "rgba(232, 220, 255, 0.72)",
      lineWidth: 2,
      pixelRatio,
      spacing: 8,
      themeKey,
    });

    const paint = (progress: number) => {
      resetCanvas(context, backingSize);
      configureLogicalCoordinates(context, canvasWidth, pixelRatio);
      if (shouldAnimate) {
        drawArcCollection(context, previous, 1 - progress, 1 - progress * 0.035, selectedId, changedIds, collectedIds, previousCollectedLayer, restrictedPattern);
        drawArcCollection(context, drawableArcs, progress, 0.94 + progress * 0.06, selectedId, changedIds, collectedIds, currentCollectedLayer, restrictedPattern);
      } else {
        drawArcCollection(context, drawableArcs, 1, 1, selectedId, changedIds, collectedIds, currentCollectedLayer, restrictedPattern);
      }
    };

    if (shouldAnimate) {
      const startedAt = performance.now();
      const tick = (now: number) => {
        const linear = Math.min(1, (now - startedAt) / 240);
        paint(easeOutCubic(linear));
        if (linear < 1) animationFrameRef.current = window.requestAnimationFrame(tick);
      };
      animationFrameRef.current = window.requestAnimationFrame(tick);
    } else {
      paint(1);
    }

    previousArcsRef.current = drawableArcs;
    previousFocusRef.current = focusKey;
    return () => window.cancelAnimationFrame(animationFrameRef.current);
  }, [canvasWidth, changedIds, collectedIds, drawableArcs, focusKey, selectedId]);

  const arcAtPointer = (event: {
    currentTarget: HTMLCanvasElement;
    clientX: number;
    clientY: number;
  }) => {
    const point = logicalPointerPoint(event);
    return hitTestCleanupMap(arcs, point.x, point.y);
  };

  return (
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
        const nextId = hit?.node.id ?? null;
        if (hoveredIdRef.current === nextId) return;
        hoveredIdRef.current = nextId;
        onSelect(hit?.node ?? null);
      }}
      onPointerLeave={() => {
        hoveredIdRef.current = null;
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

function drawArcCollection(
  context: CanvasRenderingContext2D,
  arcs: readonly DrawableArc[],
  alpha: number,
  scale: number,
  selectedId: string,
  changedIds: ReadonlySet<string>,
  collectedIds: ReadonlySet<string>,
  collectedLayer: HTMLCanvasElement | null,
  restrictedPattern: CanvasPattern | null,
) {
  if (alpha <= 0) return;
  context.save();
  context.globalAlpha = alpha;
  context.translate(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER);
  context.scale(scale, scale);
  context.translate(-CLEANUP_MAP_CENTER, -CLEANUP_MAP_CENTER);
  for (const drawable of arcs) {
    drawArcBase(
      context,
      drawable,
      restrictedPattern,
    );
  }
  if (collectedLayer) {
    context.drawImage(
      collectedLayer,
      0,
      0,
      CLEANUP_MAP_SIZE,
      CLEANUP_MAP_SIZE,
    );
  } else {
    drawCollectedOverlays(context, arcs, collectedIds, null);
  }
  for (const drawable of arcs) {
    drawArcState(
      context,
      drawable,
      drawable.arc.node.id === selectedId,
      changedIds.has(drawable.arc.node.id),
    );
  }
  context.restore();
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

function collectedLayer(
  cache: CollectedLayerCacheEntry[],
  canvas: HTMLCanvasElement,
  arcs: readonly DrawableArc[],
  collectedIds: ReadonlySet<string>,
  backingSize: number,
  pixelRatio: number,
  themeKey: string,
): HTMLCanvasElement | null {
  if (collectedIds.size === 0) return null;
  const cached = cache.find(
    (entry) =>
      entry.arcs === arcs &&
      entry.collectedIds === collectedIds &&
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
  const pattern = cleanupHatchPattern(context, {
    color: "rgba(255, 125, 115, 0.62)",
    lineWidth: 2.4,
    pixelRatio,
    spacing: 11,
    themeKey,
  });
  drawCollectedOverlays(context, arcs, collectedIds, pattern);
  cache.push({
    arcs,
    backingSize,
    collectedIds,
    layer,
    pixelRatio,
    themeKey,
  });
  if (cache.length > 4) cache.splice(0, cache.length - 4);
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

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}
