import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeQuickCleanup, cancelQuickCleanup, getQuickCleanupState, isDesktopRuntime, runQuickCleanup } from "../api";
import type { QuickCleanCategory, QuickCleanCategorySummary, QuickCleanProgress, QuickCleanResult } from "../types";
import { normalizeCommandError } from "../utils";
import { useCapabilityChanges } from "./useCapabilityChanges";

export const QUICK_CLEAN_CATEGORIES: QuickCleanCategory[] = ["user_cache", "logs", "temp_files", "trash"];
export type QuickCleanPhase = "idle" | "analyzing" | "selection" | "cleaning" | "done";
export interface QuickCleanSnapshot {
  revision: number; phase: QuickCleanPhase; summaries: QuickCleanCategorySummary[];
  progress: QuickCleanProgress | null; result: QuickCleanResult | null;
  error: { code: string; message: string } | null; cancelled: boolean;
}

export function useQuickCleanup() {
  const [phase, setPhase] = useState<QuickCleanPhase>("idle");
  const [summaries, setSummaries] = useState<QuickCleanCategorySummary[]>([]);
  const [selected, setSelected] = useState<Set<QuickCleanCategory>>(new Set(QUICK_CLEAN_CATEGORIES));
  const [progress, setProgress] = useState<QuickCleanProgress | null>(null);
  const [result, setResult] = useState<QuickCleanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const desktop = isDesktopRuntime();
  const mounted = useRef(true);
  const running = useRef(false);
  const revision = useRef(-1);
  const mutation = useRef(0);
  const lastSummaries = useRef("");
  const reload = useCallback(async () => {
    if (!desktop) return;
    const sequence = mutation.current;
    const view = await getQuickCleanupState();
    if (!mounted.current || mutation.current !== sequence || view.revision < revision.current) return;
    revision.current = view.revision;
    setPhase(view.phase); setProgress(view.progress); setResult(view.result);
    setError(view.error?.code === "cleanup_cancelled" ? null : view.error?.message ?? null);
    setCancelled(view.cancelled);
    const signature = JSON.stringify(view.summaries);
    if (signature !== lastSummaries.current) {
      lastSummaries.current = signature;
      setSummaries(view.summaries);
      setSelected(new Set(view.summaries.filter((item) => item.available).map((item) => item.category)));
    }
    return view;
  }, [desktop]);
  useCapabilityChanges("quick_clean", reload);
  useEffect(() => {
    mounted.current = true; void reload().catch(() => {});
    return () => { mounted.current = false; };
  }, [reload]);
  const toggleCategory = useCallback((category: QuickCleanCategory) => {
    setSelected((current) => { const next = new Set(current); if (next.has(category)) next.delete(category); else next.add(category); return next; });
  }, []);
  const analyze = useCallback(async () => {
    if (running.current) return;
    const startedAtRevision = revision.current;
    running.current = true; ++mutation.current;
    setError(null); setPhase("analyzing"); setCancelled(false);
    try {
      const next = await analyzeQuickCleanup();
      if (!mounted.current) return;
      if (desktop) await reload();
      else { setSummaries(next); setSelected(new Set(next.filter((item) => item.available).map((item) => item.category))); setPhase(next.some((item) => item.available) ? "selection" : "done"); }
    } catch (reason) {
      if (desktop) {
        const view = await reload().catch(() => undefined);
        if (view && view.revision <= startedAtRevision && !view.error && view.phase !== "analyzing" && view.phase !== "cleaning") {
          const issue = normalizeCommandError(reason);
          if (issue.code !== "cleanup_cancelled") setError(issue.message);
        }
      }
      else if (mounted.current) { const issue = normalizeCommandError(reason); setError(issue.code === "cleanup_cancelled" ? null : issue.message); setPhase("idle"); }
    } finally { running.current = false; }
  }, [desktop, reload]);
  const clean = useCallback(async () => {
    if (running.current || phase !== "selection") return;
    const startedAtRevision = revision.current;
    running.current = true; ++mutation.current;
    setError(null); setResult(null); setProgress(null); setPhase("cleaning"); setCancelled(false);
    try {
      const outcome = await runQuickCleanup(QUICK_CLEAN_CATEGORIES.filter((category) => selected.has(category)), (value) => { if (mounted.current && !desktop) setProgress(value); });
      if (!mounted.current) return;
      if (desktop) await reload(); else { setResult(outcome); setPhase("done"); }
    } catch (reason) {
      if (desktop) {
        const view = await reload().catch(() => undefined);
        if (view && view.revision <= startedAtRevision && !view.error && view.phase !== "analyzing" && view.phase !== "cleaning") setError(normalizeCommandError(reason).message);
      }
      else if (mounted.current) { setError(normalizeCommandError(reason).message); setPhase("selection"); }
    } finally { running.current = false; }
  }, [desktop, phase, reload, selected]);
  const cancel = useCallback(async () => {
    try { await cancelQuickCleanup(); await reload(); }
    catch (reason) { if (mounted.current) setError(normalizeCommandError(reason).message); }
  }, [reload]);
  const reset = useCallback(() => {
    ++mutation.current; lastSummaries.current = ""; setResult(null); setProgress(null); setSummaries([]); setError(null); setPhase("idle");
  }, []);
  return { phase, summaries, selected, progress, result, error, cancelled, toggleCategory, analyze, clean, cancel, reset };
}
