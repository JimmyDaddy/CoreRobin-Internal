import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import "../styles/animated-robin.css";

export type RobinMood = "normal" | "attention" | "urgent" | "loading" | "observing";

interface AnimatedRobinProps {
  active?: boolean;
  className?: string;
  dragRegion?: boolean;
  interactive?: boolean;
  mood?: RobinMood;
  size?: number | string;
}

export function AnimatedRobin({
  active = false,
  className,
  dragRegion = false,
  interactive = true,
  mood = "normal",
  size = 120,
}: AnimatedRobinProps) {
  const style = { width: size, height: size } as CSSProperties;

  return (
    <span
      className={`animated-robin${interactive ? " is-interactive" : ""}${className ? ` ${className}` : ""}`}
      data-active={active ? "true" : "false"}
      data-mood={mood}
      data-tauri-drag-region={dragRegion ? "" : undefined}
      style={style}
      aria-hidden="true"
      onPointerMove={interactive ? trackRobinPointer : undefined}
      onPointerLeave={interactive ? resetRobinPointer : undefined}
    >
      <svg viewBox="0 0 220 220" focusable="false" data-tauri-drag-region={dragRegion ? "" : undefined}>
        <ellipse className="animated-robin__shadow" cx="106" cy="190" rx="50" ry="8" />

        <g className="animated-robin__tail">
          <path className="animated-robin__tail-back" d="M82 133 27 176 76 164 97 142Z" />
          <path className="animated-robin__tail-coral" d="m79 151-37 30 38-15 16-22Z" />
        </g>

        <g className="animated-robin__body">
          <path className="animated-robin__body-fill" d="m68 76 38-23 35 14 15 39-18 51-33 25-39-17-15-38 6-32Z" />
          <path className="animated-robin__breast" d="m72 108 39-17 31 16-12 47-26 21-29-16-15-31Z" />
          <path className="animated-robin__wing" d="m68 96 40-10 19 22-21 32-34 10-12-25Z" />
          <path className="animated-robin__wing-fold" d="m72 126 32 13 17-28" />
          <path className="animated-robin__status" d="m53 100 6-6 6 6-6 6Z" />
        </g>

        <g className="animated-robin__head-track">
          <g className="animated-robin__head">
            <path className="animated-robin__head-fill" d="m87 62 18-27 35 1 19 18-9 28-28 14-29-14Z" />
            <path className="animated-robin__cheek" d="m121 72 32-16-3 25-20 11-15-10Z" />
            <path className="animated-robin__beak" d="m153 57 22 10-24 8Z" />
            <g className="animated-robin__eye">
              <ellipse cx="132" cy="55" rx="5" ry="5.5" />
              <circle className="animated-robin__eye-light" cx="133.5" cy="53.5" r="1.35" />
            </g>
          </g>
        </g>

        <g className="animated-robin__scanner">
          <path className="animated-robin__scanner-track" d="M34 111h151" />
          <path className="animated-robin__scanner-beam" d="M34 111h50" />
        </g>
      </svg>
    </span>
  );
}

function trackRobinPointer(event: ReactPointerEvent<HTMLSpanElement>) {
  if (
    event.pointerType !== "mouse" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.dataset.reduceMotion === "true"
  ) return;

  const bounds = event.currentTarget.getBoundingClientRect();
  const horizontal = clamp((event.clientX - bounds.left) / bounds.width - 0.5, -0.5, 0.5) * 2;
  const vertical = clamp((event.clientY - bounds.top) / bounds.height - 0.5, -0.5, 0.5) * 2;

  event.currentTarget.style.setProperty("--robin-head-x", `${(horizontal * 4.5).toFixed(2)}px`);
  event.currentTarget.style.setProperty("--robin-head-y", `${(vertical * 2.5).toFixed(2)}px`);
  event.currentTarget.style.setProperty("--robin-head-turn", `${(horizontal * 3.4).toFixed(2)}deg`);
  event.currentTarget.style.setProperty("--robin-eye-x", `${(horizontal * 1.7).toFixed(2)}px`);
  event.currentTarget.style.setProperty("--robin-eye-y", `${(vertical * 1.2).toFixed(2)}px`);
}

function resetRobinPointer(event: ReactPointerEvent<HTMLSpanElement>) {
  event.currentTarget.style.removeProperty("--robin-head-x");
  event.currentTarget.style.removeProperty("--robin-head-y");
  event.currentTarget.style.removeProperty("--robin-head-turn");
  event.currentTarget.style.removeProperty("--robin-eye-x");
  event.currentTarget.style.removeProperty("--robin-eye-y");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
