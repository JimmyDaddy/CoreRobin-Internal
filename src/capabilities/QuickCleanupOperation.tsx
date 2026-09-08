import { useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  FileText,
  FolderSearch,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import type {
  QuickCleanCategory,
} from "../types";
import { formatBytes } from "../utils";
import "../components/QuickCleanupWorkspace.css";
import { useQuickCleanup } from "./useQuickCleanup";

const ALL_CATEGORIES: QuickCleanCategory[] = [
  "user_cache",
  "logs",
  "temp_files",
  "trash",
];

const CATEGORY_ICONS = {
  user_cache: Boxes,
  logs: FileText,
  temp_files: Zap,
  trash: Trash2,
} satisfies Record<QuickCleanCategory, typeof Boxes>;


function useAnimatedCount(target: number, active: boolean): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }
    let frame = 0;
    const startedAt = performance.now();
    const duration = 1_200;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(target * eased));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active]);
  return value;
}

export function QuickCleanupOperation() {
  const { t } = useAppTranslation();
  const { phase, summaries, selected, progress, result, error, cancelled, toggleCategory, analyze, clean, cancel, reset } = useQuickCleanup();

  const titleId = useId();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const selectionKey = JSON.stringify([summaries, [...selected].sort()]);

  const totalBytes = summaries.reduce(
    (total, summary) =>
      selected.has(summary.category) ? total + summary.byteSize : total,
    0,
  );
  const activeCategories = new Set(
    summaries
      .filter((summary) => summary.available)
      .map((summary) => summary.category),
  );
  const cleanedBytes = result?.freedBytes ?? progress?.freedBytes ?? 0;
  const displayedFreed = useAnimatedCount(cleanedBytes, phase === "done");
  const processedCategory = progress?.category ?? null;

  return (
    <div className="quick-clean" aria-labelledby={titleId}>
        <header className="quick-clean__header">
          <span className="quick-clean__icon" aria-hidden="true">
            <Wand2 size={18} />
          </span>
          <div>
            <span className="eyebrow">{t("cleanup:quickClean.kicker")}</span>
            <h3 id={titleId}>{t("cleanup:quickClean.title")}</h3>
            <p>{t("cleanup:quickClean.description")}</p>
          </div>
        </header>

      {phase === "idle" ? (
        <div className="quick-clean__idle">
          <p className="quick-clean__promise">
            <Sparkles size={14} />
            {t("cleanup:quickClean.noRiskNote")}
          </p>
          <button
            className="button button--primary"
            type="button"
            onClick={() => void analyze()}
          >
            <FolderSearch size={15} />
            {t("cleanup:quickClean.analyze")}
          </button>
        </div>
      ) : null}

      {phase === "analyzing" ? (
        <div className="quick-clean__analyzing" role="status" aria-live="polite">
          <div className="quick-clean__radar" aria-hidden="true">
            <div className="quick-clean__radar-sweep" />
            <div className="quick-clean__radar-ring is-outer" />
            <div className="quick-clean__radar-ring is-inner" />
            {ALL_CATEGORIES.map((category, index) => {
              const Icon = CATEGORY_ICONS[category];
              return (
                <span
                  className={`quick-clean__radar-orbit is-${category}`}
                  key={category}
                  style={
                    { "--orbit-angle": `${index * 90 + 45}deg` } as React.CSSProperties
                  }
                >
                  <Icon size={14} />
                </span>
              );
            })}
            <div className="quick-clean__radar-core">
              <Wand2 size={20} />
            </div>
          </div>
          <div className="quick-clean__working-copy">
            <strong>{t("cleanup:quickClean.analyzing")}</strong>
            <span>{t("cleanup:quickClean.analyzingHint")}</span>
          </div>
        </div>
      ) : null}

      {phase === "selection" ? (
        <div className="quick-clean__selection">
          <ul className="quick-clean__categories">
            {summaries.map((summary) => {
              const Icon = CATEGORY_ICONS[summary.category];
              const isSelected = selected.has(summary.category);
              return (
                <li key={summary.category}>
                  <button
                    className={isSelected ? "is-selected" : undefined}
                    type="button"
                    disabled={!summary.available}
                    onClick={() => toggleCategory(summary.category)}
                  >
                    <span className="quick-clean__check" aria-hidden="true">
                      {isSelected ? <Check size={12} /> : null}
                    </span>
                    <Icon size={16} />
                    <span className="quick-clean__category-name">
                      {t(`cleanup:quickClean.category.${summary.category}`)}
                    </span>
                    <em>
                      {summary.available
                        ? formatBytes(summary.byteSize)
                        : t("cleanup:quickClean.unavailable")}
                    </em>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="quick-clean__total">
            <span>{t("cleanup:quickClean.total")}</span>
            <strong>{formatBytes(totalBytes)}</strong>
          </div>
          <div className="quick-clean__actions">
            <button
              className="button button--primary"
              type="button"
              disabled={totalBytes === 0}
              onClick={() => setConfirmation(selectionKey)}
            >
              <Wand2 size={15} />
              {t("cleanup:quickClean.clean", { size: formatBytes(totalBytes) })}
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => void analyze()}
            >
              <RefreshCw size={14} />
              {t("cleanup:quickClean.analyzeAgain")}
            </button>
          </div>
          {confirmation === selectionKey && <section className="capability-confirm" role="alertdialog" aria-label={t("capabilities:quickConfirmTitle")}>
            <strong>{t("capabilities:quickConfirmTitle")}</strong>
            <p>{t("capabilities:quickConfirmRisk")}</p>
            <ul>{summaries.filter((item) => selected.has(item.category)).map((item) => <li key={item.category}>{t(`cleanup:quickClean.category.${item.category}`)} · {formatBytes(item.byteSize)}</li>)}</ul>
            <div className="quick-clean__actions">
              <button type="button" className="button button--secondary" onClick={() => setConfirmation(null)}>{t("common:cancel")}</button>
              <button type="button" className="button button--danger" onClick={() => { setConfirmation(null); void clean(); }}>{t("capabilities:quickConfirmAction")}</button>
            </div>
          </section>}
          <small className="quick-clean__note">{t("cleanup:quickClean.noRiskNote")}</small>
        </div>
      ) : null}

      {phase === "cleaning" ? (
        <div className="quick-clean__working" role="status" aria-live="polite">
          <div className="quick-clean__vortex" aria-hidden="true">
            <div className="quick-clean__vortex-halo" />
            <div className="quick-clean__vortex-ring is-outer" />
            <div className="quick-clean__vortex-ring is-inner" />
            {ALL_CATEGORIES.map((category, index) => (
              <i
                className={`quick-clean__particle is-${category}${activeCategories.has(category) && (processedCategory === null || category === processedCategory) ? " is-active" : ""}`}
                key={category}
                style={{
                  "--particle-delay": `${index * -0.35}s`,
                  "--particle-angle": `${index * 90 + 24}deg`,
                } as React.CSSProperties}
              />
            ))}
            <div className="quick-clean__vortex-core">
              <Wand2 size={22} />
            </div>
          </div>
          <div className="quick-clean__working-copy">
            <strong>{t("cleanup:quickClean.cleaning")}</strong>
            <span>
              {t(
                progress
                  ? `cleanup:quickClean.category.${progress.category}`
                  : "cleanup:quickClean.cleaning",
              )}
            </span>
            {progress?.currentPath ? (
              <small className="quick-clean__working-path" title={progress.currentPath}>
                {progress.currentPath}
              </small>
            ) : null}
            <em>
              {t("cleanup:quickClean.freedSoFar", {
                size: formatBytes(cleanedBytes),
              })}
            </em>
          </div>
          <button
            className="button button--secondary quick-clean__cancel"
            type="button"
            onClick={() => void cancel()}
          >
            <Square size={12} />
            {t("cleanup:quickClean.cancel")}
          </button>
        </div>
      ) : null}

      {phase === "done" ? (
        <div className="quick-clean__result" role="status" aria-live="polite">
          <div className="quick-clean__result-burst" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
              <i key={index} style={{ "--burst-angle": `${index * 45}deg` } as React.CSSProperties} />
            ))}
            <span className="quick-clean__result-star">
              <Sparkles size={26} />
            </span>
          </div>
          <div className="quick-clean__result-copy">
            <span className="eyebrow">{t("cleanup:quickClean.done")}</span>
            <strong>{formatBytes(displayedFreed)}</strong>
            <p>
              {result && result.freedItems > 0
                ? t("cleanup:quickClean.freedSummary", {
                    count: result.freedItems,
                    size: formatBytes(result.freedBytes),
                  })
                : t("cleanup:quickClean.empty")}
            </p>
            {result && result.skippedItems > 0 ? (
              <small>
                {t("cleanup:quickClean.skippedNote", {
                  count: result.skippedItems,
                })}
              </small>
            ) : null}
          </div>
          <div className="quick-clean__result-list">
            {result?.results.map((item) => {
              const Icon = CATEGORY_ICONS[item.category];
              return (
                <div key={item.category}>
                  <Icon size={14} />
                  <span>{t(`cleanup:quickClean.category.${item.category}`)}</span>
                  <em>{formatBytes(item.freedBytes)}</em>
                </div>
              );
            })}
          </div>
          <div className="quick-clean__actions">
            <button
              className="button button--primary"
              type="button"
              onClick={() => void analyze()}
            >
              <Wand2 size={15} />
              {t("cleanup:quickClean.again")}
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={reset}
            >
              {t("cleanup:quickClean.close")}
            </button>
          </div>
        </div>
      ) : null}

      {cancelled && <p role="status">{t("capabilities:cancelled")}</p>}
      {error ? (
        <div className="quick-clean__error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      ) : null}
      </div>


  );
}
