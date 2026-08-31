import { Check, CircleStop, Minus, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { CleanupDeleteMode } from "../types";
import "./CleanupActivity.css";

export type CleanupActivityState = "working" | "cancelling" | "success" | "partial" | "cancelled" | "failed" | "empty";

interface CleanupActivityVisualProps {
  state: CleanupActivityState;
  mode: CleanupDeleteMode;
  percent?: number | null;
  celebrate?: boolean;
}

function CleanupDiscardVisual({ mode }: { mode: CleanupDeleteMode }) {
  return (
    <div className="cleanup-activity__discard">
      <div className="cleanup-activity__packets">
        {[-1, 1, -1].map((direction, index) => (
          <span key={index} className="cleanup-activity__packet" style={{
            "--packet-start-x": `${direction * 108}px`,
            "--packet-lift-x": `${direction * 62}px`,
            "--packet-turn": `${direction * 32}deg`,
            animationDelay: `${-index * 0.8}s`,
          } as CSSProperties}><i /><i /><i /></span>
        ))}
      </div>
      <div className="cleanup-activity__bin">
        <div className="cleanup-activity__bin-mouth" />
        <svg className="cleanup-activity__bin-body" viewBox="0 0 96 104" focusable="false">
          <path className="cleanup-activity__bin-face" d="M10 16h76l-7 72c-.5 6-5 10-11 10H28c-6 0-10.5-4-11-10Z" />
          <path className="cleanup-activity__bin-edge" d="m14 20 7 67c.5 4 3 7 8 7h13" />
          <path className="cleanup-activity__bin-slots" d="m32 34 3 43m13-44v46m16-45-3 43" />
          <path className="cleanup-activity__bin-rim" d="M9 16q39 12 78 0" />
        </svg>
        <svg className="cleanup-activity__bin-lid" viewBox="0 0 108 36" focusable="false">
          <path className="cleanup-activity__bin-handle" d="M40 14V9c0-3 2-5 5-5h18c3 0 5 2 5 5v5" />
          <path className="cleanup-activity__bin-face" d="M10 15q44-7 88 0l4 10q-48 10-96 0Z" />
          <path className="cleanup-activity__bin-edge" d="M13 18q41-6 82 0" />
        </svg>
        <div className="cleanup-activity__bin-impact" />
      </div>
      {mode === "permanent" ? (
        <div className="cleanup-activity__shreds">
          {Array.from({ length: 9 }, (_, index) => (
            <i key={index} className="cleanup-activity__shred" style={{
              "--shred-x": `${(index - 4) * 12}px`,
              "--shred-y": `${24 + index % 3 * 8}px`,
              "--shred-turn": `${(index - 4) * 31}deg`,
              animationDelay: `${(index % 3) * -0.07}s`,
            } as CSSProperties} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CleanupActivityVisual({ state, mode, percent = null, celebrate = true }: CleanupActivityVisualProps) {
  const working = state === "working";
  const successful = state === "success";
  return (
    <div className={`cleanup-activity is-${state}${successful && celebrate ? " is-celebrating" : ""}`} data-mode={mode} aria-hidden="true">
      <div className="cleanup-activity__halo" />
      <div className="cleanup-activity__orbit" />
      <div className="cleanup-activity__orbit is-inner" />
      <svg className="cleanup-activity__ring" viewBox="0 0 240 240" focusable="false">
        <circle className="cleanup-activity__ring-track" cx="120" cy="120" r="94" />
        <circle
          className={`cleanup-activity__ring-value${working && percent === null ? " is-indeterminate" : ""}`}
          cx="120" cy="120" r="94" pathLength="100"
          strokeDasharray={`${successful ? 100 : percent === null ? 24 : Math.max(0, Math.min(100, percent))} 100`}
        />
      </svg>
      {working ? <CleanupDiscardVisual mode={mode} /> : null}
      {successful && celebrate ? (
        <div className="cleanup-activity__burst">
          <i className="cleanup-activity__wave" /><i className="cleanup-activity__wave is-second" />
          {Array.from({ length: 16 }, (_, index) => (
            <i key={index} className="cleanup-activity__spark" style={{
              "--spark-x": `${Math.cos(index * Math.PI / 8) * (index % 2 ? 126 : 108)}px`,
              "--spark-y": `${Math.sin(index * Math.PI / 8) * (index % 2 ? 106 : 90)}px`,
              "--spark-turn": `${index * 47}deg`,
              animationDelay: `${(index % 4) * 0.05}s`,
            } as CSSProperties} />
          ))}
        </div>
      ) : null}
      {!working ? <div className="cleanup-activity__core">
        <div className="cleanup-activity__core-sheen" />
        {successful ? <Check className="cleanup-activity__check" size={43} strokeWidth={2.4} />
          : state === "failed" ? <X size={38} />
          : state === "empty" ? <Minus size={38} />
          : <CircleStop size={38} />}
      </div> : null}
      <div className="cleanup-activity__floor" />
    </div>
  );
}
