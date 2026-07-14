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

interface DrawableArc {
  arc: CleanupMapArc;
  visual: CleanupNodeVisual;
}

interface CleanupSunburstCanvasProps {
  arcs: readonly CleanupMapArc[];
  hues: ReadonlyMap<string, number>;
  selectedId: string;
  changedIds: ReadonlySet<string>;
  focusKey: string;
  ariaLabel: string;
  onSelect: (node: CleanupMapNode | null) => void;
  onActivate: (node: CleanupMapNode) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>, node: CleanupMapNode) => void;
  onPointerCancel: (pointerId: number) => void;
}

export const CleanupSunburstCanvas = memo(function CleanupSunburstCanvas({
  arcs,
  hues,
  selectedId,
  changedIds,
  focusKey,
  ariaLabel,
  onSelect,
  onActivate,
  onPointerDown,
  onPointerCancel,
}: CleanupSunburstCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef(0);
  const previousArcsRef = useRef<DrawableArc[]>([]);
  const previousFocusRef = useRef(focusKey);
  const hoveredIdRef = useRef<string | null>(null);
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

    window.cancelAnimationFrame(animationFrameRef.current);
    const previous = previousArcsRef.current;
    const focusChanged = previousFocusRef.current !== focusKey;
    const shouldAnimate = previous.length > 0 &&
      (focusChanged || previous !== drawableArcs) &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const paint = (progress: number) => {
      resetCanvas(context, backingSize);
      configureLogicalCoordinates(context, canvasWidth, pixelRatio);
      if (shouldAnimate) {
        drawArcCollection(context, previous, 1 - progress, 1 - progress * 0.035, selectedId, changedIds);
        drawArcCollection(context, drawableArcs, progress, 0.94 + progress * 0.06, selectedId, changedIds);
      } else {
        drawArcCollection(context, drawableArcs, 1, 1, selectedId, changedIds);
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
  }, [canvasWidth, changedIds, drawableArcs, focusKey, selectedId]);

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
) {
  if (alpha <= 0) return;
  context.save();
  context.globalAlpha = alpha;
  context.translate(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER);
  context.scale(scale, scale);
  context.translate(-CLEANUP_MAP_CENTER, -CLEANUP_MAP_CENTER);
  for (const drawable of arcs) {
    drawArc(context, drawable, drawable.arc.node.id === selectedId, changedIds.has(drawable.arc.node.id));
  }
  context.restore();
}

function drawArc(
  context: CanvasRenderingContext2D,
  { arc, visual }: DrawableArc,
  selected: boolean,
  changed: boolean,
) {
  const endAngle = Math.min(arc.endAngle, arc.startAngle + Math.PI * 2 - 0.000_001);
  context.save();
  context.beginPath();
  context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, arc.outerRadius, arc.startAngle, endAngle);
  context.arc(CLEANUP_MAP_CENTER, CLEANUP_MAP_CENTER, arc.innerRadius, endAngle, arc.startAngle, true);
  context.closePath();
  const collectionAlpha = context.globalAlpha;
  context.fillStyle = visual.fill;
  context.globalAlpha = collectionAlpha * (arc.node.kind === "file" ? 0.76 : 0.96);
  context.fill();

  if (arc.node.kind === "restricted") {
    context.save();
    context.clip();
    context.strokeStyle = "rgba(232, 220, 255, 0.72)";
    context.lineWidth = 2;
    for (let offset = -CLEANUP_MAP_SIZE; offset < CLEANUP_MAP_SIZE * 2; offset += 8) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset + CLEANUP_MAP_SIZE, CLEANUP_MAP_SIZE);
      context.stroke();
    }
    context.restore();
  }

  context.globalAlpha = collectionAlpha;
  context.strokeStyle = "rgba(7, 16, 23, 0.9)";
  context.lineWidth = 1.35;
  context.stroke();

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

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}
