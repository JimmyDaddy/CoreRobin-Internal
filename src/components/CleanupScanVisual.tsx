import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CLEANUP_MAP_CENTER, CLEANUP_MAP_SIZE, type CleanupMapArc } from "../cleanupMap";
import type { CleanupScanJobPhase } from "../types";
import "./CleanupScanVisual.css";

const center = CLEANUP_MAP_CENTER;
const point = (radius: number, angle: number) => [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius];
const diameter = (radius: number) => `${radius * 200 / CLEANUP_MAP_SIZE}%`;

export function CleanupScanValue({ value, format }: { value: number; format: (value: number) => string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  const label = format(value);
  useLayoutEffect(() => {
    const from = previous.current;
    if (!textRef.current || value <= from || document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      || document.documentElement.dataset.reduceMotion === "true") { previous.current = value; return; }
    textRef.current.textContent = format(from);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const fraction = Math.min(1, (now - start) / 340);
      previous.current = from + (value - from) * (1 - (1 - fraction) ** 3);
      if (textRef.current) textRef.current.textContent = format(previous.current);
      if (fraction < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [value, format]);
  return <span aria-label={label}><span aria-hidden="true" ref={textRef}>{label}</span></span>;
}

function arrivalPaths(arc: CleanupMapArc, outer: number) {
  const a = arc.startAngle + .008, b = Math.min(arc.endAngle - .008, a + Math.PI * 2 - .01);
  const angle = (a + b) / 2, radius = arc.outerRadius - 1, inner = arc.innerRadius + 1, large = b - a > Math.PI ? 1 : 0;
  const impact = point((inner + radius) / 2, angle);
  return {
    impact,
    stream: `M ${point(outer + 9, angle - .2).join(" ")} Q ${point(outer + 5, angle + .14).join(" ")} ${impact.join(" ")}`,
    edge: `M ${point(radius, a).join(" ")} A ${radius} ${radius} 0 ${large} 1 ${point(radius, b).join(" ")}`,
    sector: `M ${point(radius, a).join(" ")} A ${radius} ${radius} 0 ${large} 1 ${point(radius, b).join(" ")} L ${point(inner, b).join(" ")} A ${inner} ${inner} 0 ${large} 0 ${point(inner, a).join(" ")} Z`,
  };
}

/** The worker owns scan phases; presentation pauses must preserve the animation clock. */
export function useCleanupScanMotion(phase: CleanupScanJobPhase | null) {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible && (phase === "preparing" || phase === "scanning" || phase === "finalizing");
}

export function CleanupScanField({ revision }: { revision: number }) {
  const previous = useRef(revision);
  const [surge, setSurge] = useState<number | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = revision;
    if (revision <= before) return;
    setSurge(revision);
    const timer = window.setTimeout(() => setSurge(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [revision]);
  return <div className="cleanup-scan-field" aria-hidden="true">
    <div className="scan-field-nebula" />
    <div className="scan-field-projection" />
    <div className="scan-field-platform"><div className="scan-field-lattice" /><div className="scan-field-ring" /><div className="scan-field-chase" /></div>
    <div className="scan-field-light is-left" /><div className="scan-field-light is-right" />
    {surge !== null ? <div className="scan-field-surge" key={surge} /> : null}
  </div>;
}

export function CleanupScanEffects({ arcs, phase, scanKey, focusKey, running }: {
  arcs: readonly CleanupMapArc[];
  phase: CleanupScanJobPhase | null;
  scanKey: string;
  focusKey: string;
  running: boolean;
}) {
  const previous = useRef({ scanKey, focusKey, sizes: new Map<string, number>() });
  const runningRef = useRef(running);
  runningRef.current = running;
  const burstSequence = useRef(0);
  const [burst, setBurst] = useState<{ id: number; paths: ReturnType<typeof arrivalPaths>[] } | null>(null);
  const [settling, setSettling] = useState(false);
  const previousPhase = useRef(phase);
  const outer = Math.max(83, ...arcs.map((arc) => arc.outerRadius));
  useEffect(() => {
    const before = previous.current;
    previous.current = { scanKey, focusKey, sizes: new Map(arcs.map((arc) => [arc.node.id, arc.node.allocatedSizeBytes])) };
    if (!runningRef.current || (before.scanKey === scanKey && before.focusKey !== focusKey)) { setBurst(null); return; }
    const sizes = before.scanKey === scanKey ? before.sizes : new Map<string, number>();
    const arrivals = arcs.filter((arc) => arc.node.allocatedSizeBytes > (sizes.get(arc.node.id) ?? 0) && arc.endAngle - arc.startAngle > .035)
      .sort((left, right) => right.depth - left.depth).slice(0, 5);
    if (!arrivals.length) { setBurst(null); return; }
    setBurst({ id: ++burstSequence.current, paths: arrivals.map((arc) => arrivalPaths(arc, outer)) });
    const timer = window.setTimeout(() => setBurst(null), 1_350);
    return () => window.clearTimeout(timer);
  }, [arcs, scanKey, focusKey]);
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = phase;
    if (phase !== "completed" || !before || ["completed", "cancelled", "failed"].includes(before)) { setSettling(false); return; }
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [phase]);
  return <div className="cleanup-scan-effects" aria-hidden="true">
    <div className="scan-fx-aurora" style={{ width: diameter(outer + 12) }} />
      <div className="scan-fx-sweep" style={{ width: diameter(outer + 4) }} />
      <div className="scan-fx-track" style={{ width: diameter(outer + 8) }} />
      <div className="scan-fx-orbit" style={{ width: diameter(outer + 8) }} />
      <div className="scan-fx-orbit is-secondary" style={{ width: diameter(outer + 12) }} />
      <div className="scan-fx-core" />
    {phase === "completed" ? <div className="scan-fx-seal" style={{ width: diameter(outer + 8) }} /> : null}
    {burst ? <svg className="scan-fx-arrival" viewBox={`0 0 ${CLEANUP_MAP_SIZE} ${CLEANUP_MAP_SIZE}`} key={burst.id}>
      {burst.paths.map((path, i) => <g key={i} style={{ "--scan-delay": `${i * 65}ms`, "--scan-spark-x": `${path.impact[0]}px`, "--scan-spark-y": `${path.impact[1]}px` } as CSSProperties}>
        <path className="scan-fx-shine" d={path.sector} />
        <path className="scan-fx-bloom" d={path.stream} pathLength="100" />
        <path className="scan-fx-stream" d={path.stream} pathLength="100" />
        <path className="scan-fx-edge" d={path.edge} />
        <circle className="scan-fx-spark" cx={path.impact[0]} cy={path.impact[1]} r="2.8" />
      </g>)}
    </svg> : null}
    {settling ? <><div className="scan-fx-wave" style={{ width: diameter(outer + 4) }} /><div className="scan-fx-flash" /></> : null}
  </div>;
}
