import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { CapabilityActionIntent, CapabilityResult } from "./contracts";
import { CleanupItemSummary } from "./CleanupItemSummary";
import { formatBytes } from "../utils";

type DiskResult = Extract<CapabilityResult, { kind: "disk" }>;
const COLORS = ["#7d9eff", "#57c8b5", "#b69aef", "#e9b76d", "#df8fb5", "#6cbddf", "#b4c977", "#e89979", "#999ee0", "#74c4ce", "#d6a6db", "#bdba87"];

function ringSlice(start: number, end: number): string {
  const point = (radius: number, angle: number) => `${120 + radius * Math.sin(angle)},${120 - radius * Math.cos(angle)}`;
  const middle = (start + end) / 2;
  // Two arcs per edge also handle a single directory occupying the full circle.
  return `M${point(98, start)} A98,98 0 0 1 ${point(98, middle)} A98,98 0 0 1 ${point(98, end)} L${point(70, end)} A70,70 0 0 0 ${point(70, middle)} A70,70 0 0 0 ${point(70, start)} Z`;
}

/** Uses only native receipt references; chart interaction never executes cleanup. */
export function DiskUsageCard({ result, canAct, stale, actionsEnabled, onAction }: {
  result: DiskResult;
  canAct: boolean;
  stale: boolean;
  actionsEnabled: boolean;
  onAction?: (intent: CapabilityActionIntent) => void;
}) {
  const { t, i18n } = useTranslation("capabilities");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inspected, setInspected] = useState<string | null>(null);
  const maxBytes = Math.max(0, ...result.items.map((item) => item.allocatedBytes));
  const weight = (bytes: number) => maxBytes > 0 ? bytes / maxBytes : 0;
  const totalWeight = result.items.reduce((sum, item) => sum + weight(item.allocatedBytes), 0);
  const totalBytes = result.items.reduce((sum, item) => sum + item.allocatedBytes, 0);
  const selectedBytes = result.items.reduce((sum, item) => sum + (selected.has(item.targetRef) ? item.allocatedBytes : 0), 0);
  const percent = (bytes: number) => new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 1 }).format(totalWeight > 0 ? weight(bytes) / totalWeight : 0);
  const shownBytes = (bytes: number) => Number.isFinite(bytes) ? formatBytes(bytes) : "—";
  const focused = result.items.find((item) => item.targetRef === inspected);
  const toggle = (targetRef: string) => {
    if (!canAct) return;
    setInspected(targetRef);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(targetRef)) next.delete(targetRef);
      else next.add(targetRef);
      return next;
    });
  };
  let offset = 0;
  const slices = result.items.map((item, index) => {
    const start = offset;
    offset += totalWeight > 0 ? weight(item.allocatedBytes) / totalWeight * Math.PI * 2 : 0;
    return { item, color: COLORS[index % COLORS.length], path: ringSlice(start, offset) };
  });

  return <>
    <div className="capability-scan-summary"><strong>{t("scanned", { count: result.scannedEntries })}</strong>{result.unreadableEntries > 0 && <span className="capability-warning">{t("unreadable", { count: result.unreadableEntries })}</span>}</div>
    <div className="capability-disk-layout">
      <figure className="capability-disk-chart">
        <div className="capability-disk-ring">
          <svg viewBox="0 0 240 240" role="group" aria-label={t("diskChartTitle")}>
            <circle cx="120" cy="120" r="84" fill="none" stroke="var(--border)" strokeWidth="28" />
            {slices.filter(({ item }) => item.allocatedBytes > 0).map(({ item, color, path }) => <path
              key={item.targetRef}
              d={path}
              fill={color}
              role="button"
              tabIndex={0}
              aria-label={`${item.name} · ${shownBytes(item.allocatedBytes)} · ${percent(item.allocatedBytes)}`}
              aria-pressed={selected.has(item.targetRef)}
              aria-disabled={!canAct}
              className={`capability-disk-slice${selected.has(item.targetRef) ? " is-selected" : ""}${inspected === item.targetRef ? " is-inspected" : ""}`}
              onPointerEnter={() => setInspected(item.targetRef)}
              onFocus={() => setInspected(item.targetRef)}
              onClick={() => toggle(item.targetRef)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggle(item.targetRef);
                }
              }}
            ><title>{`${item.name} · ${shownBytes(item.allocatedBytes)} · ${percent(item.allocatedBytes)}`}</title></path>)}
          </svg>
          <div className="capability-disk-center" aria-hidden="true">
            <span>{focused?.name ?? t("diskReturnedTotal")}</span>
            <strong>{shownBytes(focused?.allocatedBytes ?? totalBytes)}</strong>
            {focused && <small>{percent(focused.allocatedBytes)}</small>}
          </div>
        </div>
        <figcaption>{t("diskReturnedTotal")} · {shownBytes(totalBytes)}</figcaption>
      </figure>
      <ul className="capability-cleanup-list capability-disk-legend" aria-label={t("diskChartTitle")}>
        {slices.map(({ item, color }) => <li key={item.targetRef} className={selected.has(item.targetRef) ? "is-selected" : undefined} style={{ "--disk-color": color } as CSSProperties} onPointerEnter={() => setInspected(item.targetRef)}>
          <label className="capability-select"><input type="checkbox" aria-label={item.name} disabled={!canAct} checked={selected.has(item.targetRef)} onFocus={() => setInspected(item.targetRef)} onChange={() => toggle(item.targetRef)} /></label>
          <CleanupItemSummary name={item.name} bytes={item.allocatedBytes} safety={item.safety} caption={`${percent(item.allocatedBytes)} · ${t("items", { count: item.itemCount })}`} />
        </li>)}
      </ul>
    </div>
    {result.items.length === 0 && <p>{t("noData")}</p>}
    <div className="capability-actions"><span>{t("selected", { count: selected.size })} · {shownBytes(selectedBytes)}</span><button type="button" className="button button--secondary" disabled={!canAct || selected.size === 0} onClick={() => onAction?.({ action: "trash", targetRefs: result.items.filter((item) => selected.has(item.targetRef)).map((item) => item.targetRef) })}><Trash2 size={14} />{t("trashSelected")}</button></div>
    <p className="capability-hint">{t("diskScope")}</p>
    {(stale || !actionsEnabled) && <p className="capability-warning" role="status">{t(stale ? "stale" : "expired")}</p>}
  </>;
}
