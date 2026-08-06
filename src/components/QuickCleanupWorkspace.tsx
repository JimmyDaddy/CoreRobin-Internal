import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
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

import {
  analyzeQuickCleanup,
  cancelQuickCleanup,
  runQuickCleanup,
} from "../api";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type {
  QuickCleanCategory,
  QuickCleanCategorySummary,
  QuickCleanProgress,
  QuickCleanResult,
} from "../types";
import { formatBytes, normalizeCommandError } from "../utils";
import "./QuickCleanupWorkspace.css";

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

type QuickCleanPhase = "idle" | "analyzing" | "selection" | "cleaning" | "done";

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

export function QuickCleanupPage({ onBack }: { onBack: () => void }) {
  const { t } = useAppTranslation();
  const [phase, setPhase] = useState<QuickCleanPhase>("idle");
  const [summaries, setSummaries] = useState<QuickCleanCategorySummary[]>([]);
  const [selected, setSelected] = useState<Set<QuickCleanCategory>>(
    new Set(ALL_CATEGORIES),
  );
  const [progress, setProgress] = useState<QuickCleanProgress | null>(null);
  const [result, setResult] = useState<QuickCleanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const toggleCategory = useCallback((category: QuickCleanCategory) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const analyze = useCallback(async () => {
    setError(null);
    setPhase("analyzing");
    try {
      const next = await analyzeQuickCleanup();
      setSummaries(next);
      const available = next.filter((summary) => summary.available);
      setSelected(new Set(available.map((summary) => summary.category)));
      setPhase(available.length > 0 ? "selection" : "done");
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError).message);
      setPhase("idle");
    }
  }, []);

  const clean = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setResult(null);
    setProgress(null);
    setPhase("cleaning");
    const categories = ALL_CATEGORIES.filter((category) =>
      selected.has(category),
    );
    try {
      const outcome = await runQuickCleanup(categories, setProgress);
      setResult(outcome);
      setPhase("done");
    } catch (caughtError) {
      const normalized = normalizeCommandError(caughtError);
      if (normalized.code !== "cleanup_cancelled") {
        setError(normalized.message);
        setPhase("selection");
      }
    } finally {
      runningRef.current = false;
    }
  }, [selected]);

  const cancel = useCallback(async () => {
    await cancelQuickCleanup();
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setProgress(null);
    setSummaries([]);
    setError(null);
    setPhase("idle");
  }, []);

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
    <section className="quick-clean-page" aria-labelledby="quick-clean-title">
      <div className="quick-clean">
        <header className="quick-clean__header">
          <span className="quick-clean__icon" aria-hidden="true">
            <Wand2 size={18} />
          </span>
          <div>
            <span className="eyebrow">{t("cleanup:quickClean.kicker")}</span>
            <h3 id="quick-clean-title">{t("cleanup:quickClean.title")}</h3>
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
              onClick={() => void clean()}
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

      {error ? (
        <div className="quick-clean__error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      ) : null}
      </div>

      <div className="quick-clean-page__guide">
        <span className="quick-clean-page__guide-icon" aria-hidden="true">
          <FolderSearch size={20} />
        </span>
        <div>
          <strong>{t("cleanup:quickClean.guideTitle")}</strong>
          <p>{t("cleanup:quickClean.guideDescription")}</p>
        </div>
        <button className="button button--primary" type="button" onClick={onBack}>
          {t("cleanup:quickClean.guideAction")}
          <ArrowRight size={14} />
        </button>
      </div>
    </section>
  );
}

export function QuickCleanLauncher({ onOpen }: { onOpen: () => void }) {
  const { t } = useAppTranslation();
  return (
    <button
      className="quick-clean-launcher"
      type="button"
      onClick={onOpen}
    >
      <span className="quick-clean-launcher__icon" aria-hidden="true">
        <Wand2 size={17} />
      </span>
      <span className="quick-clean-launcher__copy">
        <strong>{t("cleanup:quickClean.title")}</strong>
        <small>{t("cleanup:quickClean.launcherDescription")}</small>
      </span>
      <span className="quick-clean-launcher__action">
        {t("cleanup:quickClean.open")}
        <ArrowRight size={13} />
      </span>
    </button>
  );
}
