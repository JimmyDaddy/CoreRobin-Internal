import { AlertTriangle, ArchiveRestore, CheckCircle2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cleanupAvailableDelta, cleanupOutcomeStatus, type CleanupDeleteOutcome } from "../cleanupOutcome";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { formatBytes } from "../utils";
import { Button } from "./Button";
import { CleanupActivityVisual } from "./CleanupActivityVisual";

export function CleanupSettlementDialog({ outcome, celebrate = true, onClose }: {
  outcome: CleanupDeleteOutcome;
  celebrate?: boolean;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const status = cleanupOutcomeStatus(outcome);
  const measured = outcome.availableBytesBefore !== null && outcome.availableBytesAfter !== null;
  const released = cleanupAvailableDelta(outcome);
  const primaryBytes = outcome.mode === "permanent" && measured ? released : outcome.deletedBytes;
  const metricLabel = t(outcome.mode === "trash" ? "cleanup:settlement.movedLabel"
    : measured ? "cleanup:settlement.availableLabel" : "cleanup:settlement.processedLabel");

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop cleanup-settlement-backdrop" onMouseDown={onClose}>
      <section ref={dialog} className={`cleanup-settlement is-${status}`} role="dialog" aria-modal="true" aria-labelledby="cleanup-settlement-title" onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeButton} className="icon-button cleanup-settlement__close" type="button" aria-label={t("common:close")} onClick={onClose}><X size={18} /></button>
        <CleanupActivityVisual state={status} mode={outcome.mode} celebrate={celebrate} />
        <h2 id="cleanup-settlement-title">{t(`cleanup:settlement.status.${status}`)}</h2>
        <div className="cleanup-settlement__metric">
          <span>{metricLabel}</span>
          <AnimatedBytes value={primaryBytes} animate={celebrate && status === "success"} />
        </div>
        <div className="cleanup-settlement__facts">
          <span><CheckCircle2 size={14} />{t("cleanup:settlement.completed", { count: outcome.deletedCount })}</span>
          <span>{t("cleanup:settlement.processed", { size: formatBytes(outcome.deletedBytes) })}</span>
          {outcome.failed.length > 0 ? <span className="is-warning"><AlertTriangle size={14} />{t("cleanup:settlement.failed", { count: outcome.failed.length })}</span> : null}
        </div>
        <p className="cleanup-settlement__note">
          {outcome.mode === "trash" ? <ArchiveRestore size={15} /> : <AlertTriangle size={15} />}
          <span>{t(outcome.mode === "trash" ? "cleanup:settlement.trashNote"
            : !measured ? "cleanup:settlement.unmeasuredNote"
            : released < outcome.deletedBytes * 0.8 ? "cleanup:settlement.pendingNote"
            : "cleanup:settlement.measuredNote")}</span>
        </p>
        {outcome.failed.length > 0 ? <ul className="cleanup-settlement__failures">{outcome.failed.slice(0, 3).map((failure) => (
          <li key={failure.path} title={`${failure.path}: ${failure.message}`}>{failure.path}</li>
        ))}</ul> : null}
        <footer><Button variant="primary" onClick={onClose}>{t("common:close")}</Button></footer>
      </section>
    </div>
  );
}

function AnimatedBytes({ value, animate }: { value: number; animate: boolean }) {
  const text = useRef<HTMLSpanElement>(null);
  const formatted = formatBytes(value);
  useEffect(() => {
    const element = text.current;
    if (!element) return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const finish = () => {
      window.cancelAnimationFrame?.(frame);
      element.textContent = formatted;
    };
    if (!animate || media?.matches || document.documentElement.dataset.reduceMotion === "true" || !window.requestAnimationFrame) { finish(); return; }
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const ratio = Math.min(1, (now - start) / 950);
      element.textContent = formatBytes(value * (1 - (1 - ratio) ** 3));
      if (ratio < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    const reduce = () => { if (media?.matches || document.documentElement.dataset.reduceMotion === "true") finish(); };
    const observer = new MutationObserver(reduce);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    media?.addEventListener("change", reduce);
    return () => { finish(); observer.disconnect(); media?.removeEventListener("change", reduce); };
  }, [animate, formatted, value]);
  return <strong aria-label={formatted}><span ref={text} aria-hidden="true">{formatted}</span></strong>;
}
