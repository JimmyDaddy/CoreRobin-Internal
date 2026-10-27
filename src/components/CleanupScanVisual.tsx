import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./CleanupScanVisual.css";

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

/** Visibility and both motion preferences control the sole canvas clock. */
export function useCleanupMotionAllowed() {
  const read = () => document.visibilityState !== "hidden" &&
    document.documentElement.dataset.reduceMotion !== "true" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [allowed, setAllowed] = useState(read);
  useEffect(() => {
    const update = () => setAllowed(read());
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", update);
    media?.addEventListener?.("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    update();
    return () => {
      document.removeEventListener("visibilitychange", update);
      media?.removeEventListener?.("change", update);
      observer.disconnect();
    };
  }, []);
  return allowed;
}
