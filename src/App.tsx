import {
  CircleHelp,
  CircleGauge,
  Cpu,
  Database,
  Gauge,
  History,
  House,
  Languages,
  ListTree,
  MemoryStick,
  Network,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Settings2,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  createProcessControlLease,
  executeProcessAction,
  getProcessDetail,
  isDesktopRuntime,
  releaseProcessControlLease,
} from "./api";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { DeviceWellbeing } from "./components/DeviceWellbeing";
import { DailyHome } from "./components/DailyHome";
import { MetricCard } from "./components/MetricCard";
import { ProcessInspector } from "./components/ProcessInspector";
import { ProcessTable } from "./components/ProcessTable";
import { ResourceHistory } from "./components/ResourceHistory";
import { SmartDiagnosis } from "./components/SmartDiagnosis";
import { aggregateApplications, analyzeSystemHealth } from "./diagnosis";
import {
  buildDailyAttentionItems,
  dailyOverallLevel,
  type DailyIntent,
  type DailyRecheck,
} from "./dailyExperience";
import { useNetworkConnections } from "./hooks/useNetworkConnections";
import { useCleanupScan } from "./hooks/useCleanupScan";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { usePersistentHistory } from "./hooks/usePersistentHistory";
import { useMainVisibility } from "./hooks/useMainVisibility";
import { useResourceAlerts } from "./hooks/useResourceAlerts";
import { useSelectedProcessHistory } from "./hooks/useSelectedProcessHistory";
import { useSystemMonitor } from "./hooks/useSystemMonitor";
import { useStartupItems } from "./hooks/useStartupItems";
import { normalizeLanguage } from "./i18n";
import brandMark from "./assets/brand-mark.png";
import {
  defaultProcessExplorerPreferences,
  loadProcessExplorerPreferences,
  pruneExpandedIdentities,
  saveProcessExplorerPreferences,
  type ProcessExplorerPreferences,
} from "./processExplorer";
import type { ResourceAlertResource } from "./resourceAlerts";
import {
  applyAppAppearance,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "./settings";
import {
  buildLightTraySummary,
  buildTraySummary,
  type TraySummary,
} from "./traySummary";
import type {
  CommandError,
  ProcessAction,
  ProcessControlLease,
  ProcessDetail,
  ProcessKey,
  ProcessRow,
} from "./types";
import {
  formatBytes,
  formatPercent,
  formatRate,
  detailMatchesProcess,
  memoryUsagePercent,
  normalizeCommandError,
  processIdentity,
  processKeysEqual,
  resourceUsageLevel,
} from "./utils";
import "./App.css";

type ActiveView = "overview" | "processes" | "storage" | "cleanup" | "network" | "startup" | "history" | "settings" | "more";

const MAIN_SURFACE_STARTED_AT = performance.now();
const MINIMUM_SPLASH_DURATION_MS = 1300;

const CleanupAssistant = lazy(async () => ({ default: (await import("./components/CleanupAssistant")).CleanupAssistant }));
const DailyApplications = lazy(async () => ({ default: (await import("./components/DailyApplications")).DailyApplications }));
const DailyGuide = lazy(async () => ({ default: (await import("./components/DailyGuide")).DailyGuide }));
const DailyRecords = lazy(async () => ({ default: (await import("./components/DailyRecords")).DailyRecords }));
const DailySettings = lazy(async () => ({ default: (await import("./components/DailySettings")).DailySettings }));
const DailySolve = lazy(async () => ({ default: (await import("./components/DailySolve")).DailySolve }));
const DailySpace = lazy(async () => ({ default: (await import("./components/DailySpace")).DailySpace }));
const HistoryExplorer = lazy(async () => ({ default: (await import("./components/HistoryExplorer")).HistoryExplorer }));
const NetworkExplorer = lazy(async () => ({ default: (await import("./components/NetworkExplorer")).NetworkExplorer }));
const SettingsExplorer = lazy(async () => ({ default: (await import("./components/SettingsExplorer")).SettingsExplorer }));
const StorageExplorer = lazy(async () => ({ default: (await import("./components/StorageExplorer")).StorageExplorer }));
const StartupExplorer = lazy(async () => ({ default: (await import("./components/StartupExplorer")).StartupExplorer }));

function isActiveView(value: unknown): value is ActiveView {
  return typeof value === "string" && [
    "overview",
    "processes",
    "storage",
    "cleanup",
    "network",
    "startup",
    "history",
    "settings",
    "more",
  ].includes(value);
}

interface PendingProcessAction {
  source: "process" | "diagnosis";
  displayName: string;
  action: ProcessAction;
  selectionIdentity: string;
  key: ProcessKey;
  lease: ProcessControlLease;
  detail: ProcessDetail;
  dailyIntent: DailyIntent | null;
}

function App() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() =>
    loadAppSettings(normalizeLanguage(i18n.resolvedLanguage)),
  );
  const [companionVisible, setCompanionVisible] = useState(
    settings.companionShowOnStartup,
  );
  const mainVisible = useMainVisibility();
  const {
    snapshot,
    summary: systemSummary,
    history,
    error,
    paused,
    setPaused,
    loading,
    refreshNow,
  } = useSystemMonitor(settings.systemSampleIntervalMs, mainVisible);
  const [activeView, setActiveView] = useState<ActiveView>("overview");
  const [dailyIntent, setDailyIntent] = useState<DailyIntent | null>(null);
  const [dailyRecheck, setDailyRecheck] = useState<DailyRecheck | null>(null);
  const [modeTransition, setModeTransition] = useState<AppSettings["experienceMode"] | null>(null);
  const [diagnosisExpanded, setDiagnosisExpanded] = useState(false);
  const handleOpenAlertEvidence = useCallback((resource: ResourceAlertResource) => {
    if (resource === "volume") {
      setActiveView("storage");
      return;
    }
    setActiveView("overview");
    setDiagnosisExpanded(true);
  }, []);
  const persistentHistory = usePersistentHistory(
    history,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
    mainVisible,
  );
  const resourceAlerts = useResourceAlerts(
    snapshot,
    settings.usageThresholds,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
    settings.historyApplicationNamesEnabled,
  );
  const desktopNotifications = useDesktopNotifications(
    resourceAlerts.events,
    settings.desktopNotificationsEnabled,
    settings.language,
    settings.mutedNotificationResources,
    handleOpenAlertEvidence,
  );
  const cleanupScan = useCleanupScan();
  const startupItems = useStartupItems(
    activeView === "startup" || dailyIntent === "startup" || dailyIntent === "checkup",
  );
  const {
    snapshot: connectionsSnapshot,
    error: connectionsError,
    loading: connectionsLoading,
    refreshNow: refreshConnections,
  } = useNetworkConnections(
    activeView === "network" ||
      (activeView === "overview" && diagnosisExpanded) ||
      dailyIntent === "slow" || dailyIntent === "network" || dailyIntent === "checkup",
    paused,
    settings.connectionRefreshIntervalMs,
    mainVisible,
  );
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [lastSelected, setLastSelected] = useState<ProcessRow | null>(null);
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [detailError, setDetailError] = useState<CommandError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [processPreferences, setProcessPreferences] =
    useState<ProcessExplorerPreferences>(() => ({
      ...loadProcessExplorerPreferences(),
      viewMode: settings.defaultProcessView,
    }));
  const [pendingAction, setPendingAction] = useState<PendingProcessAction | null>(null);
  const [preparingAction, setPreparingAction] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [bestEffortOptIn, setBestEffortOptIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedIdentityRef = useRef(selectedIdentity);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const activeDetailKeyRef = useRef<ProcessKey | null>(null);
  const preparingActionRef = useRef(false);
  const submittingActionRef = useRef(false);
  const startupCompletedRef = useRef(false);
  const modeTransitionTimeoutRef = useRef<number | null>(null);
  const latestTraySummaryRef = useRef<TraySummary | null>(null);
  const selectedHistory = useSelectedProcessHistory(snapshot, selectedIdentity);
  const diagnosis = useMemo(
    () => snapshot
      ? analyzeSystemHealth({
          snapshot,
          history,
          connections: connectionsSnapshot,
        })
      : null,
    [connectionsSnapshot, history, snapshot],
  );
  const refreshActiveView = useCallback(async () => {
    await Promise.all([
      refreshNow(),
      ...(activeView === "network" ||
      (activeView === "overview" && diagnosisExpanded)
        ? [refreshConnections()]
        : []),
    ]);
  }, [activeView, diagnosisExpanded, refreshConnections, refreshNow]);

  const selectedProcess = useMemo(
    () =>
      snapshot?.processes.find(
        (process) => processIdentity(process) === selectedIdentity,
      ) ?? null,
    [selectedIdentity, snapshot],
  );
  const selectionMissing = selectedIdentity !== null && !selectedProcess;
  const activeDetail = detailMatchesProcess(detail, selectedProcess) ? detail : null;
  selectedIdentityRef.current = selectedIdentity;
  activeDetailKeyRef.current = activeDetail?.key ?? null;

  useEffect(() => {
    mainContentRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeView]);

  useEffect(() => () => {
    if (modeTransitionTimeoutRef.current !== null) {
      window.clearTimeout(modeTransitionTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || loading || startupCompletedRef.current) return;
    startupCompletedRef.current = true;
    const remaining = Math.max(
      0,
      MINIMUM_SPLASH_DURATION_MS - (performance.now() - MAIN_SURFACE_STARTED_AT),
    );
    const timeout = window.setTimeout(() => {
      void invoke("complete_startup");
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [loading]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<unknown>("status-orbit:navigate", ({ payload }) => {
        if (!disposed && isActiveView(payload)) setActiveView(payload);
      }),
      listen<boolean>("status-orbit:set-paused", ({ payload }) => {
        if (!disposed) setPaused(Boolean(payload));
      }),
      listen<boolean>("status-orbit:companion-visibility", ({ payload }) => {
        if (!disposed) setCompanionVisible(Boolean(payload));
      }),
      listen("status-orbit:refresh", () => {
        if (!disposed) void refreshNow();
      }),
      listen<unknown>("status-orbit:open-daily", ({ payload }) => {
        if (!disposed && isActiveView(payload)) {
          setSettings((current) => ({ ...current, experienceMode: "simple" }));
          setDailyIntent(null);
          setActiveView(payload);
        }
      }),
    ]).then((nextUnlisteners) => {
      if (disposed) nextUnlisteners.forEach((unlisten) => unlisten());
      else unlisteners.push(...nextUnlisteners);
    });
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refreshNow, setPaused]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const summary = mainVisible
      ? snapshot && diagnosis
        ? buildTraySummary(snapshot, paused, diagnosis)
        : null
      : systemSummary
        ? buildLightTraySummary(
            systemSummary,
            paused,
            latestTraySummaryRef.current,
          )
        : null;
    if (!summary) return;
    latestTraySummaryRef.current = summary;
    void Promise.all([
      emitTo("tray", "status-orbit:tray-summary", summary),
      emitTo("companion", "status-orbit:tray-summary", summary),
    ]);
  }, [diagnosis, mainVisible, paused, snapshot, systemSummary]);

  const updateProcessPreferences = useCallback(
    (update: Partial<Omit<ProcessExplorerPreferences, "version">>) => {
      setProcessPreferences((current) => ({ ...current, ...update }));
      if (update.viewMode) {
        setSettings((current) => ({
          ...current,
          defaultProcessView: update.viewMode ?? current.defaultProcessView,
        }));
      }
    },
    [],
  );

  const updateSettings = useCallback(
    (update: Partial<Omit<AppSettings, "version">>) => {
      setSettings((current) => ({ ...current, ...update }));
      if (update.experienceMode === "simple") {
        setDailyIntent(null);
        setActiveView("overview");
      }
      if (update.defaultProcessView) {
        setProcessPreferences((current) => ({
          ...current,
          viewMode: update.defaultProcessView ?? current.viewMode,
        }));
      }
    },
    [],
  );

  useEffect(() => {
    saveAppSettings(settings);
    applyAppAppearance(settings);
  }, [settings]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void invoke("configure_companion_window", {
      alwaysOnTop: settings.companionAlwaysOnTop,
      show: settings.companionShowOnStartup,
    });
  }, [settings.companionAlwaysOnTop, settings.companionShowOnStartup]);

  useEffect(() => {
    if (normalizeLanguage(i18n.resolvedLanguage) !== settings.language) {
      void i18n.changeLanguage(settings.language);
    }
  }, [i18n, settings.language]);

  useEffect(() => {
    saveProcessExplorerPreferences(processPreferences);
  }, [processPreferences]);

  useEffect(() => {
    if (!snapshot) return;
    setProcessPreferences((current) => {
      const expandedIdentities = pruneExpandedIdentities(
        current.expandedIdentities,
        snapshot.processes,
      );
      if (
        expandedIdentities.length === current.expandedIdentities.length &&
        expandedIdentities.every(
          (identity, index) => identity === current.expandedIdentities[index],
        )
      ) {
        return current;
      }
      return { ...current, expandedIdentities };
    });
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || selectedIdentity !== null) return;
    const firstProcess = snapshot.processes.find((process) => !process.protected) ?? snapshot.processes[0];
    if (firstProcess) {
      setSelectedIdentity(processIdentity(firstProcess));
      setLastSelected(firstProcess);
    }
  }, [selectedIdentity, snapshot]);

  useEffect(() => {
    if (selectedProcess) setLastSelected(selectedProcess);
  }, [selectedProcess]);

  useEffect(() => {
    if (!selectedProcess) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    void getProcessDetail({
      pid: selectedProcess.pid,
      snapshotStartTime: selectedProcess.startTime,
      snapshotBirthToken: selectedProcess.birthToken,
    })
      .then((nextDetail) => {
        if (!cancelled) setDetail(nextDetail);
      })
      .catch((caughtError) => {
        if (!cancelled) setDetailError(normalizeCommandError(caughtError));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProcess?.birthToken, selectedProcess?.pid, selectedProcess?.startTime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".search-field input")?.focus();
      }
      if (
        event.key === " " &&
        event.target === document.body &&
        settings.experienceMode === "professional"
      ) {
        event.preventDefault();
        setPaused((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPaused, settings.experienceMode]);

  const discardPendingAction = useCallback((pending: PendingProcessAction | null) => {
    if (!pending) return;
    void releaseProcessControlLease({ leaseId: pending.lease.id }).catch(() => undefined);
  }, []);

  const cancelPendingAction = useCallback(() => {
    discardPendingAction(pendingAction);
    setPendingAction(null);
  }, [discardPendingAction, pendingAction]);

  const selectProcess = useCallback(
    (process: ProcessRow) => {
      discardPendingAction(pendingAction);
      setSelectedIdentity(processIdentity(process));
      setLastSelected(process);
      setPendingAction(null);
      setNotice(null);
    },
    [discardPendingAction, pendingAction],
  );

  const beginProcessAction = useCallback(
    async (action: ProcessAction) => {
      if (
        preparingActionRef.current ||
        !selectedIdentity ||
        !activeDetail?.key
      ) {
        return;
      }

      const selectionIdentity = selectedIdentity;
      const key = activeDetail.key;
      preparingActionRef.current = true;
      setPreparingAction(true);
      setNotice(null);
      try {
        const lease = await createProcessControlLease({
          key,
          action,
          acknowledgeBestEffort:
            snapshot?.capabilities.processControl.targeting !== "best_effort_pid" ||
            bestEffortOptIn,
        });
        if (
          selectedIdentityRef.current !== selectionIdentity ||
          !processKeysEqual(activeDetailKeyRef.current, key)
        ) {
          await releaseProcessControlLease({ leaseId: lease.id }).catch(() => undefined);
          setNotice(t("app.staleTarget"));
          return;
        }
        setPendingAction({
          source: "process",
          displayName: activeDetail.name,
          action,
          selectionIdentity,
          key,
          lease,
          detail: activeDetail,
          dailyIntent: null,
        });
      } catch (caughtError) {
        setNotice(normalizeCommandError(caughtError).message);
      } finally {
        preparingActionRef.current = false;
        setPreparingAction(false);
      }
    },
    [activeDetail, bestEffortOptIn, selectedIdentity, snapshot?.capabilities.processControl.targeting],
  );

  const beginDiagnosisRequestClose = useCallback(
    async (identity: string, applicationName: string, requestedDailyIntent?: DailyIntent) => {
      if (preparingActionRef.current || !snapshot) return;
      const process = snapshot.processes.find(
        (candidate) => processIdentity(candidate) === identity,
      );
      if (!process || process.protected || !process.birthToken) {
        setNotice(t("diagnosis.recommendations.actionUnavailable"));
        return;
      }

      discardPendingAction(pendingAction);
      setPendingAction(null);
      selectedIdentityRef.current = identity;
      setSelectedIdentity(identity);
      setLastSelected(process);
      setNotice(null);
      preparingActionRef.current = true;
      setPreparingAction(true);
      try {
        const nextDetail = await getProcessDetail({
          pid: process.pid,
          snapshotStartTime: process.startTime,
          snapshotBirthToken: process.birthToken,
        });
        if (
          selectedIdentityRef.current !== identity ||
          !detailMatchesProcess(nextDetail, process) ||
          !nextDetail.key
        ) {
          setNotice(t("app.staleTarget"));
          return;
        }
        if (!nextDetail.canTerminate) {
          setNotice(
            nextDetail.protectedReason ??
            nextDetail.identityError ??
            t("diagnosis.recommendations.actionUnavailable"),
          );
          return;
        }

        const lease = await createProcessControlLease({
          key: nextDetail.key,
          action: "request_close",
          // The diagnosis confirmation dialog explains the best-effort target
          // boundary before execution, so preparing this lease is an explicit
          // user-initiated acknowledgement and still sends no signal itself.
          acknowledgeBestEffort: true,
        });
        if (selectedIdentityRef.current !== identity) {
          await releaseProcessControlLease({ leaseId: lease.id }).catch(() => undefined);
          setNotice(t("app.staleTarget"));
          return;
        }
        setDetail(nextDetail);
        setPendingAction({
          source: "diagnosis",
          displayName: applicationName,
          action: "request_close",
          selectionIdentity: identity,
          key: nextDetail.key,
          lease,
          detail: nextDetail,
          dailyIntent: settings.experienceMode === "simple"
            ? requestedDailyIntent ?? dailyIntent ?? "slow"
            : null,
        });
      } catch (caughtError) {
        setNotice(normalizeCommandError(caughtError).message);
      } finally {
        preparingActionRef.current = false;
        setPreparingAction(false);
      }
    },
    [dailyIntent, discardPendingAction, pendingAction, settings.experienceMode, snapshot, t],
  );

  const handleAction = async () => {
    if (!pendingAction || submittingActionRef.current) return;
    const currentKey = pendingAction.source === "diagnosis"
      ? selectedProcess && processIdentity(selectedProcess) === pendingAction.selectionIdentity
        ? pendingAction.key
        : null
      : activeDetail?.key ?? null;
    if (
      selectedIdentity !== pendingAction.selectionIdentity ||
      !processKeysEqual(currentKey, pendingAction.key)
    ) {
      await releaseProcessControlLease({ leaseId: pendingAction.lease.id }).catch(() => undefined);
      setNotice(t("app.staleTarget"));
      setPendingAction(null);
      return;
    }

    submittingActionRef.current = true;
    setSubmittingAction(true);
    try {
      const result = await executeProcessAction({
        leaseId: pendingAction.lease.id,
        key: pendingAction.key,
        action: pendingAction.action,
      });
      setNotice(result.message);
      if (pendingAction.dailyIntent) {
        setDailyRecheck({
          intent: pendingAction.dailyIntent,
          outcome: result.outcome,
          checkedAtMs: Date.now(),
        });
      }
      setPendingAction(null);
      await refreshNow();
    } catch (caughtError) {
      const actionError = normalizeCommandError(caughtError);
      void releaseProcessControlLease({ leaseId: pendingAction.lease.id }).catch(() => undefined);
      setNotice(actionError.message);
      setPendingAction(null);
    } finally {
      submittingActionRef.current = false;
      setSubmittingAction(false);
    }
  };

  if (!snapshot && loading) {
    return (
      <main className="boot-screen">
        <span className="brand-mark"><img src={brandMark} alt="" /></span>
        <strong>StatusOrbit</strong>
        <span><i className="live-status-dot" />{t("app.samplerConnecting")}</span>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="boot-screen boot-screen--error">
        <span className="brand-mark"><img src={brandMark} alt="" /></span>
        <strong>{t("app.samplerFailed")}</strong>
        <span>{error?.message ?? t("app.samplerNoData")}</span>
        <button className="button button--primary" type="button" onClick={() => void refreshNow()}>{t("common.retry")}</button>
      </main>
    );
  }

  const memoryPercent = memoryUsagePercent(
    snapshot.memory.usedBytes,
    snapshot.memory.totalBytes,
  );
  const diskRate =
    snapshot.disk.readBytesPerSecond === null || snapshot.disk.writeBytesPerSecond === null
      ? null
      : snapshot.disk.readBytesPerSecond + snapshot.disk.writeBytesPerSecond;
  const networkRate =
    snapshot.network.receivedBytesPerSecond === null ||
    snapshot.network.transmittedBytesPerSecond === null
      ? null
      : snapshot.network.receivedBytesPerSecond +
        snapshot.network.transmittedBytesPerSecond;
  const dailyMode = settings.experienceMode === "simple";
  const activeDiagnosis = diagnosis!;
  const dailyLevel = dailyOverallLevel(activeDiagnosis, snapshot);
  const recommendedDailyIntent = buildDailyAttentionItems(
    activeDiagnosis,
    snapshot,
    1,
  )[0]?.intent ?? null;
  const openDailyIntent = (intent: DailyIntent) => {
    setDailyIntent(intent);
    setActiveView("overview");
    setDailyRecheck((current) => current?.intent === intent ? current : null);
  };
  const navigateDaily = (view: ActiveView) => {
    setDailyIntent(null);
    setActiveView(view);
  };
  const openDailyCleanup = () => {
    navigateDaily("cleanup");
  };
  const switchExperienceMode = (experienceMode: AppSettings["experienceMode"]) => {
    if (experienceMode === settings.experienceMode || modeTransition !== null) return;
    if (modeTransitionTimeoutRef.current !== null) {
      window.clearTimeout(modeTransitionTimeoutRef.current);
    }
    setModeTransition(experienceMode);
    updateSettings({ experienceMode });
    modeTransitionTimeoutRef.current = window.setTimeout(() => {
      setModeTransition(null);
      modeTransitionTimeoutRef.current = null;
    }, settings.reduceMotion ? 40 : 820);
  };
  const openProfessional = (view: ActiveView = "overview") => {
    setDailyIntent(null);
    setActiveView(view === "more" ? "overview" : view);
    switchExperienceMode("professional");
  };
  const runDailyRefresh = async (intent: DailyIntent) => {
    setDailyRecheck(null);
    await Promise.all([
      refreshNow(),
      ...(intent === "slow" || intent === "network" || intent === "checkup"
        ? [refreshConnections()]
        : []),
      ...(intent === "startup" || intent === "checkup"
        ? [startupItems.refresh()]
        : []),
    ]);
    setDailyRecheck({ intent, outcome: "refreshed", checkedAtMs: Date.now() });
  };
  const refreshDailyGuide = async () => {
    if (dailyIntent) await runDailyRefresh(dailyIntent);
  };
  const checkFromDailyHome = async () => {
    await runDailyRefresh("checkup");
    setDailyIntent("checkup");
    setActiveView("overview");
  };
  const refreshDailyApplications = async () => {
    const nextSnapshot = await refreshNow();
    const captured = nextSnapshot ?? snapshot;
    return {
      applications: aggregateApplications(captured.processes),
      totalMemoryBytes: captured.memory.totalBytes,
      sampledAtMs: captured.sampledAtMs,
    };
  };
  return (
    <div className={`app-shell${dailyMode ? " app-shell--daily" : " app-shell--professional"}${modeTransition ? ` is-mode-transitioning mode-transition--to-${modeTransition}` : ""}`}>
      <nav className="sidebar" aria-label={t("app.mainNavigation")}>
        <div className="brand">
          <span className="brand-mark"><img src={brandMark} alt="" /></span>
          <span><strong>StatusOrbit</strong><small>{dailyMode ? t("daily.shell.label") : "LOCAL MONITOR"}</small></span>
        </div>

        {dailyMode ? (
          <>
            <div className="nav-group daily-nav">
              <button className={activeView === "overview" ? "is-active" : ""} type="button" onClick={() => navigateDaily("overview")}><House size={18} />{t("daily.nav.today")}</button>
              <button className={activeView === "more" || activeView === "processes" || activeView === "storage" ? "is-active" : ""} type="button" onClick={() => navigateDaily("more")}><CircleHelp size={18} />{t("daily.nav.solve")}</button>
              <button className={activeView === "cleanup" ? "is-active" : ""} type="button" onClick={openDailyCleanup}><Sparkles size={18} />{t("daily.nav.cleanup")}</button>
              <button className={activeView === "history" ? "is-active" : ""} type="button" onClick={() => navigateDaily("history")}><History size={18} />{t("daily.nav.records")}</button>
            </div>
          </>
        ) : (
          <>
            <div className="nav-group">
              <span className="nav-label">{t("app.monitor")}</span>
              <button className={activeView === "overview" ? "is-active" : ""} type="button" onClick={() => setActiveView("overview")}><CircleGauge size={17} />{t("app.overview")}</button>
              <button className={activeView === "processes" ? "is-active" : ""} type="button" onClick={() => setActiveView("processes")}><ListTree size={17} />{t("app.processes")}</button>
              <button className={activeView === "storage" ? "is-active" : ""} type="button" onClick={() => setActiveView("storage")}><Database size={17} />{t("app.storage")}</button>
              <button className={activeView === "cleanup" ? "is-active" : ""} type="button" onClick={() => setActiveView("cleanup")}><Sparkles size={17} />{t("app.cleanup")}</button>
              <button className={activeView === "network" ? "is-active" : ""} type="button" onClick={() => setActiveView("network")}><Network size={17} />{t("app.network")}</button>
            </div>
            <div className="nav-group">
              <span className="nav-label">{t("app.diagnostics")}</span>
              <button className={activeView === "startup" ? "is-active" : ""} type="button" onClick={() => setActiveView("startup")}><Rocket size={17} />{t("app.startup")}</button>
              <button className={activeView === "history" ? "is-active" : ""} type="button" onClick={() => setActiveView("history")}><History size={17} />{t("app.history")}{resourceAlerts.activeAlerts.length > 0 ? <small className="nav-alert-badge" aria-label={t("history.alerts.active", { count: resourceAlerts.activeAlerts.length })}>{resourceAlerts.activeAlerts.length}</small> : null}</button>
              <button className={activeView === "settings" ? "is-active" : ""} type="button" onClick={() => setActiveView("settings")}><Settings2 size={17} />{t("app.settings")}</button>
            </div>
            <div className="sidebar-footer">
              <span className="live-indicator"><i />{t("app.localSampling")}</span>
            </div>
          </>
        )}
      </nav>

      <div className="workspace">
        <header className="topbar">
          {dailyMode ? (
            <>
              <div className="daily-topbar-heading">
                <span className="eyebrow">{dailyIntent
                  ? t(`daily.intents.${dailyIntent}.title`)
                  : t(`daily.nav.${activeView === "more"
                    ? "solve"
                    : activeView === "cleanup" || activeView === "storage"
                      ? "cleanup"
                      : activeView === "history"
                        ? "records"
                        : activeView === "settings"
                          ? "settings"
                          : activeView === "processes"
                            ? "applications"
                            : "today"}`)}</span>
                <h1>{snapshot.host.osName.toLocaleLowerCase().includes("darwin") ? t("daily.topbar.thisMac") : t("daily.topbar.thisComputer")}</h1>
              </div>
              <div className="daily-topbar-actions">
                <span className={`daily-topbar-status is-${dailyLevel}`}><i />{t(`daily.status.${dailyLevel}.short`)}</span>
                {isDesktopRuntime() ? <button
                  className={`icon-button companion-toggle${companionVisible ? " is-active" : ""}`}
                  type="button"
                  data-tooltip={t(`app.companion.${companionVisible ? "hide" : "show"}`)}
                  aria-label={t(`app.companion.${companionVisible ? "hide" : "show"}`)}
                  aria-pressed={companionVisible}
                  onClick={() => void invoke("toggle_companion_window")}
                >
                  <Orbit size={16} />
                </button> : null}
                <button
                  className="button mode-switch mode-switch--to-professional"
                  type="button"
                  title={t("app.mode.switchTo.professional")}
                  aria-label={t("app.mode.switchTo.professional")}
                  aria-busy={modeTransition !== null}
                  disabled={modeTransition !== null}
                  onClick={() => openProfessional("overview")}
                >
                  <span className="mode-switch__icon" aria-hidden="true"><SlidersHorizontal size={15} /></span>
                  <span>{t("app.mode.short.professional")}</span>
                </button>
                <button className={`icon-button${activeView === "settings" ? " is-active" : ""}`} type="button" title={t("daily.nav.settings")} aria-label={t("daily.nav.settings")} onClick={() => navigateDaily("settings")}><Settings2 size={16} /></button>
              </div>
            </>
          ) : (
            <>
              <div className="host-heading">
                <span className="eyebrow">{t(`app.viewEyebrow.${activeView === "more" ? "overview" : activeView}`)}</span>
                <h1>{snapshot.host.hostname}</h1>
                <p>{snapshot.host.osName} {snapshot.host.osVersion} · {snapshot.host.architecture}</p>
              </div>
              <div className="topbar-actions">
            {!isDesktopRuntime() ? <span className="demo-badge">{t("app.demoData")}</span> : null}
            <span className={`sample-status${paused ? " is-paused" : ""}`}>
              <i />{paused ? t("app.paused") : snapshot.warmingUp ? t("common.warmup") : t("app.live")}
            </span>
            {isDesktopRuntime() ? <button
              className={`icon-button companion-toggle${companionVisible ? " is-active" : ""}`}
              type="button"
              data-tooltip={t(`app.companion.${companionVisible ? "hide" : "show"}`)}
              aria-label={t(`app.companion.${companionVisible ? "hide" : "show"}`)}
              aria-pressed={companionVisible}
              onClick={() => void invoke("toggle_companion_window")}
            >
              <Orbit size={16} />
            </button> : null}
            <button
              className="button mode-switch mode-switch--to-simple"
              type="button"
              title={t("app.mode.switchTo.simple")}
              aria-label={t("app.mode.switchTo.simple")}
              aria-busy={modeTransition !== null}
              disabled={modeTransition !== null}
              onClick={() => switchExperienceMode("simple")}
            >
              <span className="mode-switch__icon" aria-hidden="true"><Sparkles size={15} /></span>
              <span>{t("app.mode.short.simple")}</span>
            </button>
            <button className="icon-button" type="button" title={t("app.refreshNow")} aria-label={t("app.refreshNow")} onClick={() => void refreshActiveView()}>
              <RefreshCw size={16} />
            </button>
            <button
              className="button button--secondary language-button"
              type="button"
              title={t("app.switchLanguage")}
              aria-label={t("app.switchLanguage")}
              onClick={() => updateSettings({ language: settings.language === "en" ? "zh-CN" : "en" })}
            >
              <Languages size={15} />
              {i18n.resolvedLanguage === "en" ? "中文" : "EN"}
            </button>
            <button className="button button--secondary" type="button" onClick={() => setPaused(!paused)}>
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused ? t("app.resume") : t("app.pause")}
            </button>
              </div>
            </>
          )}
        </header>

        {error ? <div className="global-error">{t("app.sampleFailed", { message: error.message })}</div> : null}
        {notice ? <div className="global-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>{t("common.close")}</button></div> : null}

        <div className={`content-layout${dailyMode || activeView === "cleanup" || activeView === "network" || activeView === "startup" || activeView === "history" || activeView === "settings" ? " content-layout--wide" : ""}`}>
          <main className="main-content" ref={mainContentRef}>
            <Suspense fallback={<div className="surface-loading"><span className="live-status-dot" />{t("common.loading")}</div>}>
            {dailyMode ? (
              dailyIntent ? (
                <DailyGuide
                  intent={dailyIntent}
                  diagnosis={activeDiagnosis}
                  snapshot={snapshot}
                  cleanupSnapshot={cleanupScan.snapshot}
                  cleanupLoading={cleanupScan.loading}
                  startupSnapshot={startupItems.snapshot}
                  startupError={startupItems.error}
                  startupLoading={startupItems.loading}
                  connectionsSnapshot={connectionsSnapshot}
                  connectionsError={connectionsError}
                  connectionsLoading={connectionsLoading}
                  preparingAction={preparingAction}
                  recheck={dailyRecheck}
                  onBack={() => setDailyIntent(null)}
                  onRefresh={refreshDailyGuide}
                  onOpenCleanup={openDailyCleanup}
                  onOpenSpace={() => navigateDaily("storage")}
                  onOpenApplications={() => navigateDaily("processes")}
                  onOpenIntent={openDailyIntent}
                  onRefreshStartup={startupItems.refresh}
                  onRequestClose={(identity, name) => void beginDiagnosisRequestClose(identity, name, dailyIntent)}
                />
              ) : activeView === "overview" ? (
                <DailyHome
                  diagnosis={activeDiagnosis}
                  snapshot={snapshot}
                  alertEvents={resourceAlerts.events}
                  onOpenIntent={openDailyIntent}
                  onOpenSolve={() => navigateDaily("more")}
                  onOpenRecords={() => navigateDaily("history")}
                  onRefresh={checkFromDailyHome}
                />
              ) : activeView === "processes" ? (
                <DailyApplications
                  applications={activeDiagnosis.applications}
                  totalMemoryBytes={snapshot.memory.totalBytes}
                  sampledAtMs={snapshot.sampledAtMs}
                  preparingAction={preparingAction}
                  recheck={dailyRecheck?.intent === "slow" ? dailyRecheck : null}
                  onRefresh={refreshDailyApplications}
                  onRequestClose={(identity, name) => void beginDiagnosisRequestClose(identity, name, "slow")}
                />
              ) : activeView === "storage" ? (
                <DailySpace
                  snapshot={snapshot}
                  cleanupSnapshot={cleanupScan.snapshot}
                  cleanupLoading={cleanupScan.loading}
                  onOpenCleanup={openDailyCleanup}
                  onRefresh={async () => { await refreshNow(); }}
                />
              ) : activeView === "cleanup" ? (
                <CleanupAssistant
                  snapshot={cleanupScan.snapshot}
                  error={cleanupScan.error}
                  loading={cleanupScan.loading}
                  cancelling={cleanupScan.cancelling}
                  progress={cleanupScan.progress}
                  snapshotStatus={cleanupScan.snapshotStatus}
                  onScan={() => void cleanupScan.scan()}
                  onCancel={() => void cleanupScan.cancel()}
                  onDeletionApplied={cleanupScan.applyDeletion}
                />
              ) : activeView === "more" ? (
                <DailySolve
                  onOpenIntent={openDailyIntent}
                  onOpenApplications={() => navigateDaily("processes")}
                  recommendedIntent={recommendedDailyIntent}
                />
              ) : activeView === "history" ? (
                <DailyRecords alertEvents={resourceAlerts.events} />
              ) : activeView === "settings" ? (
                <DailySettings settings={settings} notificationStatus={desktopNotifications.status} onChange={updateSettings} />
              ) : (
                <DailySolve
                  onOpenIntent={openDailyIntent}
                  onOpenApplications={() => navigateDaily("processes")}
                  recommendedIntent={recommendedDailyIntent}
                />
              )
            ) : activeView === "overview" ? (
              <>
                {diagnosis ? (
                  <SmartDiagnosis
                    result={diagnosis}
                    expanded={diagnosisExpanded}
                    connectionScanLoading={connectionsLoading && !paused}
                    connectionScanUnavailable={connectionsError !== null}
                    preparingAction={preparingAction}
                    onToggle={() => {
                      const nextExpanded = !diagnosisExpanded;
                      setDiagnosisExpanded(nextExpanded);
                      if (nextExpanded && !paused) void refreshConnections();
                    }}
                    onOpenTarget={setActiveView}
                    onInspectProcess={(identity) => {
                      const process = snapshot.processes.find(
                        (candidate) => processIdentity(candidate) === identity,
                      );
                      if (process) selectProcess(process);
                      setActiveView("processes");
                    }}
                    onRequestClose={(identity, applicationName) => {
                      void beginDiagnosisRequestClose(identity, applicationName);
                    }}
                  />
                ) : null}
                <DeviceWellbeing
                  sensors={snapshot.sensors}
                  applications={diagnosis?.applications ?? []}
                />
                <>
                    <section className="metric-grid" aria-label={t("app.metricsLabel")}>
                      <MetricCard
                        icon={Cpu}
                        label="CPU"
                        value={formatPercent(snapshot.cpu.usagePercent)}
                        context={t("app.metrics.cpuContext", { count: snapshot.cpu.logicalCoreCount })}
                        tone="blue"
                        progress={snapshot.cpu.usagePercent ?? 0}
                        usageLevel={resourceUsageLevel(snapshot.cpu.usagePercent, settings.usageThresholds)}
                      />
                      <MetricCard
                        icon={MemoryStick}
                        label={t("app.metrics.memory")}
                        value={formatBytes(snapshot.memory.usedBytes)}
                        context={t("app.metrics.memoryContext", {
                          total: formatBytes(snapshot.memory.totalBytes),
                          swap: formatBytes(snapshot.memory.swapUsedBytes),
                        })}
                        tone="violet"
                        progress={memoryPercent}
                        usageLevel={resourceUsageLevel(memoryPercent, settings.usageThresholds)}
                      />
                      <MetricCard
                        icon={Database}
                        label={t("app.metrics.disk")}
                        value={formatRate(diskRate)}
                        context={t("app.metrics.diskContext", {
                          read: formatRate(snapshot.disk.readBytesPerSecond),
                          write: formatRate(snapshot.disk.writeBytesPerSecond),
                        })}
                        tone="amber"
                      />
                      <MetricCard
                        icon={Network}
                        label={t("app.metrics.network")}
                        value={formatRate(networkRate)}
                        context={t("app.metrics.networkContext", {
                          receive: formatRate(snapshot.network.receivedBytesPerSecond),
                          send: formatRate(snapshot.network.transmittedBytesPerSecond),
                        })}
                        tone="green"
                      />
                    </section>
                    <ResourceHistory history={history} usageThresholds={settings.usageThresholds} />
                </>
                <ProcessTable
                    compact
                    processes={snapshot.processes}
                    selectedIdentity={selectedIdentity}
                    onSelect={selectProcess}
                    query={processPreferences.query}
                    onQueryChange={(query) => updateProcessPreferences({ query })}
                    sortKey={processPreferences.sortKey}
                    direction={processPreferences.sortDirection}
                    onSortChange={(sortKey, sortDirection) =>
                      updateProcessPreferences({ sortKey, sortDirection })
                    }
                />
              </>
            ) : activeView === "processes" ? (
              <ProcessTable
                  processes={snapshot.processes}
                  selectedIdentity={selectedIdentity}
                  onSelect={selectProcess}
                  query={processPreferences.query}
                  onQueryChange={(query) => updateProcessPreferences({ query })}
                  sortKey={processPreferences.sortKey}
                  direction={processPreferences.sortDirection}
                  onSortChange={(sortKey, sortDirection) =>
                    updateProcessPreferences({ sortKey, sortDirection })
                  }
                  viewMode={processPreferences.viewMode}
                  onViewModeChange={(viewMode) =>
                    updateProcessPreferences({ viewMode })
                  }
                  expandedIdentities={processPreferences.expandedIdentities}
                  onExpandedIdentitiesChange={(expandedIdentities) =>
                    updateProcessPreferences({ expandedIdentities })
                  }
                  followSelection={processPreferences.followSelection}
                  onFollowSelectionChange={(followSelection) =>
                    updateProcessPreferences({ followSelection })
                  }
                  onResetPreferences={() =>
                    setProcessPreferences({
                      ...defaultProcessExplorerPreferences(),
                      viewMode: settings.defaultProcessView,
                    })
                  }
              />
            ) : activeView === "storage" ? (
              <StorageExplorer
                disk={snapshot.disk}
                history={history}
                processes={snapshot.processes}
                selectedIdentity={selectedIdentity}
                onSelectProcess={(process) => {
                  selectProcess(process);
                }}
                usageThresholds={settings.usageThresholds}
                onOpenCleanup={() => setActiveView("cleanup")}
              />
            ) : activeView === "cleanup" ? (
              <CleanupAssistant
                snapshot={cleanupScan.snapshot}
                error={cleanupScan.error}
                loading={cleanupScan.loading}
                cancelling={cleanupScan.cancelling}
                progress={cleanupScan.progress}
                snapshotStatus={cleanupScan.snapshotStatus}
                onScan={() => void cleanupScan.scan()}
                onCancel={() => void cleanupScan.cancel()}
                onDeletionApplied={cleanupScan.applyDeletion}
              />
            ) : activeView === "network" ? (
              <NetworkExplorer
                network={snapshot.network}
                history={history}
                connections={connectionsSnapshot}
                connectionsError={connectionsError}
                connectionsLoading={connectionsLoading}
                onRefreshConnections={() => void refreshConnections()}
                connectionRefreshIntervalMs={settings.connectionRefreshIntervalMs}
                processes={snapshot.processes}
                onSelectProcess={(process) => {
                  selectProcess(process);
                  setActiveView("processes");
                }}
              />
            ) : activeView === "startup" ? (
              <StartupExplorer
                snapshot={startupItems.snapshot}
                error={startupItems.error}
                loading={startupItems.loading}
                applications={diagnosis?.applications ?? []}
                totalMemoryBytes={snapshot.memory.totalBytes}
                onRefresh={startupItems.refresh}
              />
            ) : activeView === "history" ? (
              <HistoryExplorer
                points={persistentHistory.points}
                storedPointCount={persistentHistory.storedPoints.length}
                alertEvents={resourceAlerts.events}
                storedAlertEventCount={resourceAlerts.storedEvents.length}
                activeAlertCount={resourceAlerts.activeAlerts.length}
                persistenceEnabled={settings.historyPersistenceEnabled}
                retentionDays={settings.historyRetentionDays}
                usageThresholds={settings.usageThresholds}
                onPersistenceEnabledChange={(historyPersistenceEnabled) =>
                  updateSettings({ historyPersistenceEnabled })
                }
                onRetentionDaysChange={(historyRetentionDays) =>
                  updateSettings({ historyRetentionDays })
                }
                onClear={() => {
                  persistentHistory.clear();
                  resourceAlerts.clearSaved();
                }}
              />
            ) : (
              <SettingsExplorer
                settings={settings}
                notificationStatus={desktopNotifications.status}
                onChange={updateSettings}
              />
            )}
            </Suspense>
          </main>

          {settings.experienceMode === "professional" && (activeView === "overview" || activeView === "processes" || activeView === "storage") ? (
            <ProcessInspector
              selected={selectedProcess ?? (selectionMissing ? lastSelected : null)}
              selectionMissing={selectionMissing}
              detail={activeDetail}
              detailError={detailError}
              detailLoading={detailLoading}
              history={selectedHistory}
              capabilities={snapshot.capabilities}
              bestEffortOptIn={bestEffortOptIn}
              preparingAction={preparingAction}
              onBestEffortOptInChange={setBestEffortOptIn}
              onAction={(action) => void beginProcessAction(action)}
            />
          ) : null}
        </div>

        {!dailyMode ? <footer className="statusbar">
          <span><Gauge size={13} />{t("app.status.interval", { interval: snapshot.sampleIntervalMs })}</span>
          <span>
            {activeView === "network"
              ? t("app.status.interfacesAndConnections", {
                  interfaces: snapshot.network.interfaceCount,
                  connections: connectionsSnapshot?.summary.totalCount ?? "—",
                })
              : activeView === "history"
                ? t("app.status.savedHistory", {
                    count: persistentHistory.storedPoints.length,
                  })
              : activeView === "cleanup"
                ? t("app.status.cleanupEntries", {
                    count: cleanupScan.progress?.scannedEntryCount ?? cleanupScan.snapshot?.scannedEntryCount ?? 0,
                  })
              : t("app.status.processCount", { count: snapshot.processes.length })}
          </span>
          <span>{snapshot.host.cpuName || snapshot.host.kernelVersion}</span>
          <span className="statusbar__sequence">#{snapshot.sequence}</span>
        </footer> : null}
      </div>

      {pendingAction ? (
        <ConfirmActionDialog
          action={pendingAction.action}
          source={pendingAction.source}
          displayName={pendingAction.displayName}
          detail={pendingAction.detail}
          targeting={pendingAction.lease.targeting}
          semantic={
            pendingAction.action === "request_close"
              ? snapshot.capabilities.processControl.requestClose.semantic
              : snapshot.capabilities.processControl.forceKill.semantic
          }
          submitting={submittingAction}
          onCancel={cancelPendingAction}
          onConfirm={() => void handleAction()}
        />
      ) : null}
    </div>
  );
}

export default App;
