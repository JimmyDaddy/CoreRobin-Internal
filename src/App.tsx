import {
  CircleHelp,
  CircleGauge,
  Cpu,
  Database,
  Gauge,
  History,
  House,
  ListTree,
  MemoryStick,
  Network,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Settings2,
  Sparkles,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppTranslation } from "./i18n/useAppTranslation";
import {
  isActiveView,
  parseOpenDailyRequest,
  PROFESSIONAL_VIEW_EYEBROW,
  type ActiveView,
} from "./appNavigation";

import {
  canRelaunchApplication,
  createProcessControlLease,
  executeProcessAction,
  getSystemSnapshot,
  getLaunchAtLogin,
  getProcessDetail,
  isDesktopRuntime,
  openSystemSettings,
  releaseProcessControlLease,
  relaunchApplication,
  setDockIconVisible,
  setLaunchAtLogin,
} from "./api";
import { BrandWordmark } from "./components/BrandWordmark";
import { MetricCard } from "./components/MetricCard";
import { LocaleSelect } from "./components/LocaleSelect";
import { RobinIcon } from "./components/RobinIcon";
import { aggregateApplications, analyzeSystemHealth } from "./diagnosis";
import { applicationWatchSamplingIntervalMs } from "./applicationWatchRules";
import {
  type DailyIntent,
  type DailyRecheck,
} from "./dailyExperience";
import {
  type DailyIncident,
} from "./dailyIncidents";
import { buildHealthStateUpdate } from "./healthState";
import { useNetworkConnections } from "./hooks/useNetworkConnections";
import { useCleanupScan } from "./hooks/useCleanupScan";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { useDailyIncidents } from "./hooks/useDailyIncidents";
import { usePublishHealthState } from "./hooks/usePublishHealthState";
import { usePersistentHistory } from "./hooks/usePersistentHistory";
import { useMainVisibility } from "./hooks/useMainVisibility";
import { useResourceAlerts } from "./hooks/useResourceAlerts";
import { useSelectedProcessHistory } from "./hooks/useSelectedProcessHistory";
import {
  HIDDEN_SYSTEM_SNAPSHOT_INTERVAL_MS,
  useSystemMonitor,
} from "./hooks/useSystemMonitor";
import { useStartupItems } from "./hooks/useStartupItems";
import { useStartupImpactMeasurement } from "./hooks/useStartupImpactMeasurement";
import { useApplicationWatchRules } from "./hooks/useApplicationWatchRules";
import { useApplicationImpactHistory } from "./hooks/useApplicationImpactHistory";
import { useConnectionHistory } from "./hooks/useConnectionHistory";
import { useFileInsightsScan } from "./hooks/useFileInsightsScan";
import { useUserActionHistory } from "./hooks/useUserActionHistory";
import { useProductDataPrivacy } from "./hooks/useProductDataPrivacy";
import { useNetworkQualityMonitor } from "./hooks/useNetworkQualityMonitor";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useTrashApplicationWatcher } from "./hooks/useTrashApplicationWatcher";
import { useBackgroundSupervisor } from "./hooks/useBackgroundSupervisor";
import { useWeeklyReviewNotification } from "./hooks/useWeeklyReviewNotification";
import { normalizeLanguage } from "./i18n";
import brandMark from "./assets/brand-mark.png";
import {
  defaultProcessExplorerPreferences,
  loadProcessExplorerPreferences,
  pruneExpandedIdentities,
  saveProcessExplorerPreferences,
  selectDefaultInspectorProcess,
  type ProcessExplorerPreferences,
} from "./processExplorer";
import {
  waitForProcessIdentityExit,
  waitForProcessReplacement,
} from "./processRestart";
import type { ResourceAlertResource } from "./resourceAlerts";
import type { UserActionKind } from "./userActionHistory";
import type { ProductDataClearResult } from "./productDataClear";
import {
  applyAppAppearance,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "./settings";
import {
  beginProductDataReset,
  clearCoreRobinWebData,
  completeOnboarding,
  CURRENT_APP_VERSION,
  hasCompletedOnboarding,
} from "./productSupport";
import type {
  CommandError,
  ProcessAction,
  ProcessControlLease,
  ProcessDetail,
  ProcessKey,
  ProcessRow,
  SystemSettingsDestination,
} from "./types";
import { buildWeeklyReview } from "./weeklyReview";
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
import "./styles/daily-guide.css";

const MAIN_SURFACE_STARTED_AT = performance.now();
const MINIMUM_SPLASH_DURATION_MS = 1300;

const CleanupAssistant = lazy(async () => ({ default: (await import("./components/CleanupAssistant")).CleanupAssistant }));
const ApplicationCenter = lazy(async () => ({ default: (await import("./components/ApplicationCenter")).ApplicationCenter }));
const ConfirmActionDialog = lazy(async () => ({ default: (await import("./components/ConfirmActionDialog")).ConfirmActionDialog }));
const DailyApplications = lazy(async () => ({ default: (await import("./components/DailyApplications")).DailyApplications }));
const DailyGuide = lazy(async () => ({ default: (await import("./components/DailyGuide")).DailyGuide }));
const DailyHome = lazy(() => import("./components/DailyHome"));
const DailyRecords = lazy(async () => ({ default: (await import("./components/DailyRecords")).DailyRecords }));
const DailySettings = lazy(async () => ({ default: (await import("./components/DailySettings")).DailySettings }));
const DailySolve = lazy(async () => ({ default: (await import("./components/DailySolve")).DailySolve }));
const DailySpace = lazy(async () => ({ default: (await import("./components/DailySpace")).DailySpace }));
const DeviceWellbeing = lazy(() => import("./components/DeviceWellbeing"));
const HistoryExplorer = lazy(async () => ({ default: (await import("./components/HistoryExplorer")).HistoryExplorer }));
const FirstRunGuide = lazy(async () => ({ default: (await import("./components/FirstRunGuide")).FirstRunGuide }));
const GpuEnergyPanel = lazy(async () => ({ default: (await import("./components/GpuEnergyPanel")).GpuEnergyPanel }));
const GlobalUpdateTask = lazy(async () => ({ default: (await import("./components/GlobalUpdateTask")).GlobalUpdateTask }));
const GlobalTaskCenter = lazy(async () => ({ default: (await import("./components/GlobalTaskCenter")).GlobalTaskCenter }));
const NetworkExplorer = lazy(async () => ({ default: (await import("./components/NetworkExplorer")).NetworkExplorer }));
const PersonalBaselinePanel = lazy(async () => ({ default: (await import("./components/PersonalBaselinePanel")).PersonalBaselinePanel }));
const ProcessInspector = lazy(async () => ({ default: (await import("./components/ProcessInspector")).ProcessInspector }));
const ProcessTable = lazy(async () => ({ default: (await import("./components/ProcessTable")).ProcessTable }));
const BackgroundProcessCard = lazy(async () => ({ default: (await import("./components/BackgroundProcessCard")).BackgroundProcessCard }));
const ResourceHistory = lazy(async () => ({ default: (await import("./components/ResourceHistory")).ResourceHistory }));
const SettingsExplorer = lazy(async () => ({ default: (await import("./components/SettingsExplorer")).SettingsExplorer }));
const SmartDiagnosis = lazy(() => import("./components/SmartDiagnosis"));
const StorageExplorer = lazy(async () => ({ default: (await import("./components/StorageExplorer")).StorageExplorer }));
const StartupExplorer = lazy(async () => ({ default: (await import("./components/StartupExplorer")).StartupExplorer }));

interface PendingProcessAction {
  source: "process" | "diagnosis" | "restart";
  displayName: string;
  action: ProcessAction;
  selectionIdentity: string;
  key: ProcessKey;
  lease: ProcessControlLease;
  detail: ProcessDetail;
  dailyIntent: DailyIntent | null;
  relaunchExecutable: string | null;
}

type SettingsOperationFailure =
  | { kind: "launchAtLogin"; desired: boolean }
  | { kind: "showDockIcon"; desired: boolean }
  | {
      kind: "companion";
      desired: { alwaysOnTop: boolean; show: boolean };
    };

type LaunchAtLoginStatus = "loading" | "ready" | "updating" | "error";

function App() {
  const { t, i18n } = useAppTranslation();
  const [settings, setSettings] = useState<AppSettings>(() =>
    loadAppSettings(normalizeLanguage(i18n.resolvedLanguage)),
  );
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => !hasCompletedOnboarding(),
  );
  const [launchAtLoginStatus, setLaunchAtLoginStatus] =
    useState<LaunchAtLoginStatus>(() => isDesktopRuntime() ? "loading" : "ready");
  const launchAtLoginActualRef = useRef<boolean | null>(null);
  const launchAtLoginIntentRef = useRef<boolean | null>(null);
  const launchAtLoginEpochRef = useRef(0);
  const dockIconActualRef = useRef<boolean | null>(null);
  const dockIconEpochRef = useRef(0);
  const companionActualRef = useRef<{
    alwaysOnTop: boolean;
    show: boolean;
  } | null>(null);
  const companionEpochRef = useRef(0);
  const [settingsOperationFailure, setSettingsOperationFailure] =
    useState<SettingsOperationFailure | null>(null);
  const [settingsOperationRetryRevision, setSettingsOperationRetryRevision] =
    useState(0);
  const [companionVisible, setCompanionVisible] = useState(
    settings.companionShowOnStartup,
  );
  const mainVisible = useMainVisibility();

  const hiddenApplicationSamplingIntervalMs =
    applicationWatchSamplingIntervalMs(settings.applicationWatchRules);
  const hiddenFullSnapshotIntervalMs =
    hiddenApplicationSamplingIntervalMs ??
    (settings.networkConnectionHistoryEnabled
      || (
        settings.historyPersistenceEnabled
        && settings.historyApplicationNamesEnabled
        && settings.applicationImpactHistoryEnabled
      )
      ? HIDDEN_SYSTEM_SNAPSHOT_INTERVAL_MS
      : null);
  const {
    snapshot,
    healthSnapshot,
    history,
    error,
    paused,
    setPaused,
    loading,
    samplerStatus,
    refreshNow,
  } = useSystemMonitor(
    settings.systemSampleIntervalMs,
    mainVisible,
    hiddenFullSnapshotIntervalMs,
    settings.historyApplicationNamesEnabled,
  );
  const [activeView, setActiveView] = useState<ActiveView>("overview");
  const [cleanupWorkspace, setCleanupWorkspace] = useState<"space" | "quick">("space");
  const [cleanupWorkspaceRequest, setCleanupWorkspaceRequest] = useState<{
    workspace: "space" | "quick";
    id: number;
  } | null>(null);
  const startupImpactMeasurements = useStartupImpactMeasurement(snapshot);
  const [dailyIntent, setDailyIntent] = useState<DailyIntent | null>(null);
  const [selectedDailyIncident, setSelectedDailyIncident] =
    useState<DailyIncident | null>(null);
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
  const handleOpenApplicationWatchEvidence = useCallback(() => {
    setActiveView("applications");
    if (isDesktopRuntime()) {
      void invoke("show_main_window").catch(() => undefined);
    }
  }, []);
  const openNotificationSettings = useCallback(() => {
    void openSystemSettings("notifications").catch((caughtError) => {
      setNotice(normalizeCommandError(caughtError).message);
    });
  }, []);
  const persistentHistory = usePersistentHistory(
    history,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
  );
  const applicationImpactHistory = useApplicationImpactHistory(
    snapshot,
    settings.historyPersistenceEnabled
      && settings.historyApplicationNamesEnabled
      && settings.applicationImpactHistoryEnabled,
    settings.historyApplicationNamesEnabled,
  );
  const resourceAlerts = useResourceAlerts(
    healthSnapshot,
    settings.usageThresholds,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
    settings.historyApplicationNamesEnabled,
  );
  const userActions = useUserActionHistory(
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
    settings.historyApplicationNamesEnabled,
  );
  const updater = useAppUpdater({
    onOperationStart: (version) => userActions.start({
      kind: "application_update",
      targetName: `CoreRobin v${version}`,
      targetCount: 1,
    }),
    onOperationComplete: (id, status) => userActions.complete(id, {
      status,
      verification: status === "succeeded" ? "verified" : "not_confirmed",
      targetCount: status === "succeeded" ? 1 : 0,
      failedCount: status === "failed" ? 1 : 0,
      outcome: {
        selectedCount: 1,
        succeededCount: status === "succeeded" ? 1 : 0,
        updateDownloaded: status === "succeeded",
        updateInstalled: status === "succeeded",
        updateRestarted: false,
      },
    }),
  });
  useEffect(() => {
    if (!updater.updatedFromVersion) return;
    userActions.confirmLatestApplicationUpdate(CURRENT_APP_VERSION);
  }, [
    updater.updatedFromVersion,
    userActions.confirmLatestApplicationUpdate,
  ]);
  const trashApplicationWatcher = useTrashApplicationWatcher(
    settings.trashApplicationWatcherEnabled,
    normalizeLanguage(settings.language),
  );
  const desktopNotifications = useDesktopNotifications(
    resourceAlerts.events,
    settings.desktopNotificationsEnabled,
    settings.language,
    settings.mutedNotificationResources,
    handleOpenAlertEvidence,
  );
  const translateSupervisor = useCallback(
    (key: string) => t(key as never),
    [t],
  );
  useBackgroundSupervisor(
    settings,
    desktopNotifications.status,
    translateSupervisor,
  );
  const applicationWatchRules = useApplicationWatchRules(
    snapshot,
    settings.applicationWatchRules,
    settings.desktopNotificationsEnabled,
    desktopNotifications.status,
    settings.language,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
    settings.historyApplicationNamesEnabled,
    handleOpenApplicationWatchEvidence,
  );
  const notificationDelivery = [
    desktopNotifications.delivery,
    applicationWatchRules.notificationDelivery,
  ].filter((delivery): delivery is NonNullable<typeof delivery> => delivery !== null)
    .sort((left, right) => right.attemptedAtMs - left.attemptedAtMs)[0] ?? null;
  const cleanupScan = useCleanupScan();
  const fileInsights = useFileInsightsScan();
  const startupItems = useStartupItems(
    activeView === "startup" || activeView === "applications"
      || dailyIntent === "startup" || dailyIntent === "checkup",
  );
  const {
    snapshot: connectionsSnapshot,
    error: connectionsError,
    loading: connectionsLoading,
    refreshNow: refreshConnections,
  } = useNetworkConnections(
    activeView === "processes" ||
      activeView === "network" ||
      activeView === "applications" ||
      (activeView === "overview" && diagnosisExpanded) ||
      dailyIntent === "slow" || dailyIntent === "network" ||
      dailyIntent === "checkup" ||
      settings.networkConnectionHistoryEnabled,
    paused,
    settings.connectionRefreshIntervalMs,
    mainVisible,
    settings.networkConnectionHistoryEnabled,
  );
  const connectionHistory = useConnectionHistory(
    connectionsSnapshot,
    snapshot?.processes ?? [],
    settings.networkConnectionHistoryEnabled,
    settings.networkConnectionHistoryRetentionDays,
  );
  const networkQuality = useNetworkQualityMonitor({
    active: activeView === "network" && mainVisible,
    historyEnabled: settings.networkQualityHistoryEnabled,
    historyHours: settings.networkQualityHistoryHours,
    networkSignature: snapshot?.network.interfaces
      .filter((networkInterface) => networkInterface.operationalState === "up")
      .map((networkInterface) => networkInterface.name)
      .sort()
      .join("|") ?? "",
  });
  const weeklyReview = useMemo(() => buildWeeklyReview({
    points: persistentHistory.points,
    alerts: resourceAlerts.events,
    networkQualityPoints: networkQuality.history,
    actions: userActions.records,
  }), [
    networkQuality.history,
    persistentHistory.points,
    resourceAlerts.events,
    userActions.records,
  ]);
  useWeeklyReviewNotification({
    enabled:
      settings.desktopNotificationsEnabled
      && settings.weeklyReviewNotificationEnabled,
    notificationStatus: desktopNotifications.status,
    title: t("daily:weekly.notificationTitle"),
    body: t("daily:weekly.notificationBody", {
      anomalies: weeklyReview.sevenDays.anomalyCount,
      improvements: weeklyReview.sevenDays.observedImprovementCount,
    }),
  });
  const productDataPrivacy = useProductDataPrivacy({
    resourceItemCount:
      persistentHistory.storedPoints.length
      + resourceAlerts.storedEvents.length
      + applicationWatchRules.storedEvents.length
      + userActions.storedRecords.length
      + applicationImpactHistory.storedPointCount,
    resourceUpdatedAtMs: latestNonZeroTimestamp([
      ...persistentHistory.storedPoints.map((point) => point.timestamp),
      ...resourceAlerts.storedEvents.map((event) => event.timestamp),
      ...applicationWatchRules.storedEvents.map((event) => event.timestamp),
      ...userActions.storedRecords.map(
        (record) => record.completedAtMs ?? record.startedAtMs,
      ),
      ...applicationImpactHistory.points.map((point) => point.sampledAtMs),
    ]),
    resourceRetentionDays: settings.historyRetentionDays,
    connectionItemCount: connectionHistory.entries.length,
    connectionUpdatedAtMs: latestNonZeroTimestamp(
      connectionHistory.entries.map((entry) => entry.lastSeenAtMs),
    ),
    connectionRetentionDays: settings.networkConnectionHistoryRetentionDays,
    networkQualityItemCount: networkQuality.history.length,
    networkQualityUpdatedAtMs: latestNonZeroTimestamp(
      networkQuality.history.map((point) => point.sampledAtMs),
    ),
    cleanupItemCount: cleanupScan.snapshot?.scannedEntryCount ?? 0,
    cleanupUpdatedAtMs: cleanupScan.snapshot?.sampledAtMs ?? null,
    fileInsightsItemCount: fileInsights.snapshot?.scannedEntryCount ?? 0,
    fileInsightsUpdatedAtMs: fileInsights.snapshot?.sampledAtMs ?? null,
    onClearResourceHistory: async () => {
      await Promise.all([
        persistentHistory.clear(),
        resourceAlerts.clearSaved(),
        applicationWatchRules.clearSaved(),
        userActions.clearSaved(),
        applicationImpactHistory.clear(),
      ]);
    },
    onClearConnectionHistory: async () => {
      await Promise.all([
        connectionHistory.clear(),
        networkQuality.clearHistory(),
      ]);
    },
    onClearCleanupScan: cleanupScan.clear,
    onClearFileInsights: fileInsights.clear,
  });
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [lastSelected, setLastSelected] = useState<ProcessRow | null>(null);
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [detailError, setDetailError] = useState<CommandError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRetryRevision, setDetailRetryRevision] = useState(0);
  const detailIdentityRef = useRef<string | null>(null);
  const [processPreferences, setProcessPreferences] =
    useState<ProcessExplorerPreferences>(() => ({
      ...loadProcessExplorerPreferences(),
      viewMode: settings.defaultProcessView,
    }));
  const [pendingAction, setPendingAction] = useState<PendingProcessAction | null>(null);
  const [preparingAction, setPreparingAction] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedIdentityRef = useRef(selectedIdentity);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const activeDetailKeyRef = useRef<ProcessKey | null>(null);
  const preparingActionRef = useRef(false);
  const submittingActionRef = useRef(false);
  const startupCompletedRef = useRef(false);
  const modeTransitionTimeoutRef = useRef<number | null>(null);
  const experienceModeRef = useRef(settings.experienceMode);
  const selectedHistory = useSelectedProcessHistory(snapshot, selectedIdentity);
  const diagnosticConnections = mainVisible ? connectionsSnapshot : null;
  const diagnosis = useMemo(
    () => healthSnapshot
      ? analyzeSystemHealth({
          snapshot: healthSnapshot,
          history,
          connections: diagnosticConnections,
        })
      : null,
    [diagnosticConnections, healthSnapshot, history],
  );
  const dailyIncidents = useDailyIncidents(
    diagnosis,
    healthSnapshot,
    diagnosticConnections,
  );
  const dailyIncidentsRef = useRef(dailyIncidents.retained);
  dailyIncidentsRef.current = dailyIncidents.retained;
  experienceModeRef.current = settings.experienceMode;
  const healthStateUpdate = useMemo(
    () => healthSnapshot && diagnosis
      ? buildHealthStateUpdate(
          healthSnapshot,
          paused,
          dailyIncidents.active,
          dailyIncidents.pendingCount,
          diagnosis.baselineReady,
          mainVisible ? "foreground" : "background",
        )
      : null,
    [
      dailyIncidents.active,
      dailyIncidents.pendingCount,
      diagnosis,
      healthSnapshot,
      mainVisible,
      paused,
    ],
  );
  usePublishHealthState(healthStateUpdate);

  useEffect(() => {
    setSelectedDailyIncident((current) => {
      if (!current) return null;
      return dailyIncidents.retained.find(
        ({ occurrenceId }) => occurrenceId === current.occurrenceId,
      ) ?? current;
    });
  }, [dailyIncidents.retained]);
  const refreshActiveView = useCallback(async () => {
    await refreshNow();
  }, [refreshNow]);

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

  useEffect(() => {
    const openSettingsShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setActiveView("settings");
      }
    };
    window.addEventListener("keydown", openSettingsShortcut);
    return () => window.removeEventListener("keydown", openSettingsShortcut);
  }, []);

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
      listen<unknown>("core-robin:navigate", ({ payload }) => {
        if (!disposed && isActiveView(payload)) setActiveView(payload);
      }),
      listen<boolean>("core-robin:set-paused", ({ payload }) => {
        if (!disposed) setPaused(Boolean(payload));
      }),
      listen<boolean>("core-robin:companion-visibility", ({ payload }) => {
        if (!disposed) setCompanionVisible(Boolean(payload));
      }),
      listen("core-robin:refresh", () => {
        if (!disposed) void refreshNow();
      }),
      listen<unknown>("core-robin:open-daily", ({ payload }) => {
        if (disposed) return;
        const request = parseOpenDailyRequest(payload, experienceModeRef.current);
        if (!request) return;
        if (experienceModeRef.current === "professional") {
          setSelectedDailyIncident(null);
          setDailyIntent(null);
          setActiveView(request.view);
          return;
        }
        const incident = request.occurrenceId
          ? dailyIncidentsRef.current.find(
              ({ occurrenceId }) => occurrenceId === request.occurrenceId,
            ) ?? null
          : null;
        setSelectedDailyIncident(incident);
        setDailyIntent(incident?.item.intent ?? null);
        setActiveView(request.view);
      }),
      listen("core-robin:open-quick-clean", () => {
        if (disposed) return;
        openCleanupWorkspace("quick");
      }),
      listen("core-robin:open-about", () => {
        if (disposed) return;
        setActiveView("settings");
        window.setTimeout(() => {
          document.getElementById("about-support-title")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }, 80);
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
        setSelectedDailyIncident(null);
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

  const updateLaunchAtLogin = useCallback((desired: boolean) => {
    launchAtLoginIntentRef.current = desired;
    setSettings((current) => current.launchAtLogin === desired
      ? current
      : { ...current, launchAtLogin: desired });
    setLaunchAtLoginStatus((current) => current === "loading" ? current : "ready");
  }, []);

  const closeOnboarding = useCallback(() => {
    completeOnboarding();
    setOnboardingOpen(false);
  }, []);

  const clearAllProductData = useCallback(async () => {
    const categories = [
        "resourceHistory",
        "connectionHistory",
        "applicationInventory",
        "scanCaches",
      ] as const;
    const outcomes = await Promise.all(
      categories.map((category) => productDataPrivacy.clearCategory(category)),
    );
    const results: ProductDataClearResult[] = categories.map((scope, index) => ({
      scope,
      status: outcomes[index] ? "succeeded" : "failed",
    }));
    if (outcomes.some((succeeded) => !succeeded)) {
      return [
        ...results,
        { scope: "preferences", status: "skipped" },
      ] satisfies ProductDataClearResult[];
    }
    beginProductDataReset();
    clearCoreRobinWebData();
    results.push({ scope: "preferences", status: "succeeded" });
    window.setTimeout(() => {
      clearCoreRobinWebData();
      window.location.reload();
    }, 120);
    return results;
  }, [
    productDataPrivacy,
  ]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const epoch = launchAtLoginEpochRef.current + 1;
    launchAtLoginEpochRef.current = epoch;
    void getLaunchAtLogin()
      .then((enabled) => {
        if (disposed || launchAtLoginEpochRef.current !== epoch) return;
        launchAtLoginActualRef.current = enabled;
        setSettings((current) => current.launchAtLogin === enabled
          ? current
          : { ...current, launchAtLogin: enabled });
        setLaunchAtLoginStatus("ready");
      })
      .catch(() => {
        if (!disposed && launchAtLoginEpochRef.current === epoch) {
          launchAtLoginActualRef.current = null;
          setLaunchAtLoginStatus("error");
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (
      !isDesktopRuntime()
      || launchAtLoginStatus === "loading"
      || launchAtLoginStatus === "updating"
    ) return;
    const explicitDesired = launchAtLoginIntentRef.current;
    if (launchAtLoginStatus === "error" && explicitDesired === null) return;
    const desired = explicitDesired ?? settings.launchAtLogin;
    if (launchAtLoginActualRef.current === desired) {
      launchAtLoginIntentRef.current = null;
      return;
    }
    const previous = launchAtLoginActualRef.current;
    const epoch = launchAtLoginEpochRef.current + 1;
    launchAtLoginEpochRef.current = epoch;
    launchAtLoginActualRef.current = desired;
    setLaunchAtLoginStatus("updating");
    setSettingsOperationFailure(null);
    void setLaunchAtLogin(desired)
      .then(() => getLaunchAtLogin())
      .then((verified) => {
        if (launchAtLoginEpochRef.current !== epoch) return;
        if (verified !== desired) throw new Error("launch_at_login_verification_failed");
        launchAtLoginActualRef.current = verified;
        launchAtLoginIntentRef.current = null;
        setLaunchAtLoginStatus("ready");
        setSettingsOperationFailure((current) =>
          current?.kind === "launchAtLogin" ? null : current
        );
        setSettings((current) => current.launchAtLogin === verified
          ? current
          : { ...current, launchAtLogin: verified });
      })
      .catch(() => {
        if (launchAtLoginEpochRef.current !== epoch) return;
        launchAtLoginActualRef.current = previous;
        launchAtLoginIntentRef.current = null;
        setLaunchAtLoginStatus("error");
        setSettingsOperationFailure({ kind: "launchAtLogin", desired });
        if (previous !== null) {
          setSettings((current) => current.launchAtLogin === desired
            ? { ...current, launchAtLogin: previous }
            : current);
        }
      });
  }, [
    launchAtLoginStatus,
    settings.launchAtLogin,
    settingsOperationRetryRevision,
  ]);

  useEffect(() => {
    saveAppSettings(settings);
    applyAppAppearance(settings);
  }, [settings]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const desired = settings.showDockIcon;
    if (dockIconActualRef.current === desired) return;
    const previous = dockIconActualRef.current;
    const epoch = dockIconEpochRef.current + 1;
    dockIconEpochRef.current = epoch;
    dockIconActualRef.current = desired;
    setSettingsOperationFailure(null);
    void setDockIconVisible(desired)
      .then(() => setSettingsOperationFailure((current) =>
        current?.kind === "showDockIcon" ? null : current
      ))
      .catch(() => {
        if (dockIconEpochRef.current !== epoch) return;
        dockIconActualRef.current = previous;
        setSettingsOperationFailure({ kind: "showDockIcon", desired });
        if (previous !== null) {
          setSettings((current) => current.showDockIcon === desired
            ? { ...current, showDockIcon: previous }
            : current);
        }
      });
  }, [settings.showDockIcon, settingsOperationRetryRevision]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const desired = {
      alwaysOnTop: settings.companionAlwaysOnTop,
      show: settings.companionShowOnStartup,
    };
    const previous = companionActualRef.current;
    if (
      previous?.alwaysOnTop === desired.alwaysOnTop &&
      previous?.show === desired.show
    ) return;
    const epoch = companionEpochRef.current + 1;
    companionEpochRef.current = epoch;
    companionActualRef.current = desired;
    setSettingsOperationFailure(null);
    void invoke("configure_companion_window", desired)
      .then(() => setSettingsOperationFailure((current) =>
        current?.kind === "companion" ? null : current
      ))
      .catch(() => {
        if (companionEpochRef.current !== epoch) return;
        companionActualRef.current = previous;
        setSettingsOperationFailure({ kind: "companion", desired });
        if (previous) {
          setSettings((current) => ({
            ...current,
            companionAlwaysOnTop: previous.alwaysOnTop,
            companionShowOnStartup: previous.show,
          }));
        }
      });
  }, [
    settings.companionAlwaysOnTop,
    settings.companionShowOnStartup,
    settingsOperationRetryRevision,
  ]);

  const retrySettingsOperation = useCallback(() => {
    const failure = settingsOperationFailure;
    if (!failure) return;
    setSettingsOperationFailure(null);
    if (failure.kind === "launchAtLogin") {
      launchAtLoginIntentRef.current = failure.desired;
      setLaunchAtLoginStatus("ready");
      setSettings((current) => current.launchAtLogin === failure.desired
        ? current
        : { ...current, launchAtLogin: failure.desired });
    } else if (failure.kind === "showDockIcon") {
      dockIconActualRef.current = null;
      setSettings((current) => ({
        ...current,
        showDockIcon: failure.desired,
      }));
    } else {
      companionActualRef.current = null;
      setSettings((current) => ({
        ...current,
        companionAlwaysOnTop: failure.desired.alwaysOnTop,
        companionShowOnStartup: failure.desired.show,
      }));
    }
    setSettingsOperationRetryRevision((current) => current + 1);
  }, [settingsOperationFailure]);

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
    const defaultProcess = selectDefaultInspectorProcess(snapshot.processes);
    if (defaultProcess) {
      setSelectedIdentity(processIdentity(defaultProcess));
      setLastSelected(defaultProcess);
    }
  }, [selectedIdentity, snapshot]);

  useEffect(() => {
    if (selectedProcess) setLastSelected(selectedProcess);
  }, [selectedProcess]);

  useEffect(() => {
    if (!selectedProcess) {
      setDetail(null);
      setDetailError(null);
      detailIdentityRef.current = null;
      return;
    }

    let cancelled = false;
    const identity = processIdentity(selectedProcess);
    setDetailLoading(true);
    if (detailIdentityRef.current !== identity) setDetail(null);
    detailIdentityRef.current = identity;
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
  }, [
    detailRetryRevision,
    selectedProcess?.birthToken,
    selectedProcess?.pid,
    selectedProcess?.startTime,
  ]);

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
          acknowledgeBestEffort: true,
        });
        if (
          selectedIdentityRef.current !== selectionIdentity ||
          !processKeysEqual(activeDetailKeyRef.current, key)
        ) {
          await releaseProcessControlLease({ leaseId: lease.id }).catch(() => undefined);
          setNotice(t("app:staleTarget"));
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
          relaunchExecutable: null,
        });
      } catch (caughtError) {
        setNotice(processActionErrorMessage(caughtError, t));
      } finally {
        preparingActionRef.current = false;
        setPreparingAction(false);
      }
    },
    [activeDetail, selectedIdentity],
  );

  const beginDiagnosisRequestClose = useCallback(
    async (
      identity: string,
      applicationName: string,
      requestedDailyIntent?: DailyIntent,
      restartAfterClose = false,
    ) => {
      if (preparingActionRef.current || !snapshot) return;
      const process = snapshot.processes.find(
        (candidate) => processIdentity(candidate) === identity,
      );
      if (!process || process.protected || !process.birthToken) {
        setNotice(t("diagnosis:recommendations.actionUnavailable"));
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
          setNotice(t("app:staleTarget"));
          return;
        }
        if (!nextDetail.canTerminate) {
          setNotice(
            nextDetail.protectedReason ??
            nextDetail.identityError ??
            t("diagnosis:recommendations.actionUnavailable"),
          );
          return;
        }
        if (
          restartAfterClose &&
          (!nextDetail.executable || !await canRelaunchApplication(nextDetail.executable))
        ) {
          setNotice(t("daily:applications.restartUnavailable", { name: applicationName }));
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
          setNotice(t("app:staleTarget"));
          return;
        }
        setDetail(nextDetail);
        setPendingAction({
          source: restartAfterClose ? "restart" : "diagnosis",
          displayName: applicationName,
          action: "request_close",
          selectionIdentity: identity,
          key: nextDetail.key,
          lease,
          detail: nextDetail,
          dailyIntent: settings.experienceMode === "simple"
            ? requestedDailyIntent ?? dailyIntent ?? "slow"
            : null,
          relaunchExecutable: restartAfterClose ? nextDetail.executable : null,
        });
      } catch (caughtError) {
        setNotice(processActionErrorMessage(caughtError, t));
      } finally {
        preparingActionRef.current = false;
        setPreparingAction(false);
      }
    },
    [dailyIntent, discardPendingAction, pendingAction, settings.experienceMode, snapshot, t],
  );

  const handleAction = async () => {
    if (!pendingAction || submittingActionRef.current) return;
    const pending = pendingAction;
    const currentKey = pending.source !== "process"
      ? selectedProcess && processIdentity(selectedProcess) === pending.selectionIdentity
        ? pending.key
        : null
      : activeDetail?.key ?? null;
    if (
      selectedIdentity !== pending.selectionIdentity ||
      !processKeysEqual(currentKey, pending.key)
    ) {
      await releaseProcessControlLease({ leaseId: pending.lease.id }).catch(() => undefined);
      setNotice(t("app:staleTarget"));
      setPendingAction(null);
      return;
    }

    submittingActionRef.current = true;
    setSubmittingAction(true);
    let executionLease: ProcessControlLease | null = null;
    let actionRecordId: string | null = null;
    try {
      executionLease = await createProcessControlLease({
        key: pending.key,
        action: pending.action,
        acknowledgeBestEffort: true,
      });
      const latestKey = pending.source !== "process"
        ? selectedProcess && processIdentity(selectedProcess) === pending.selectionIdentity
          ? pending.key
          : null
        : activeDetailKeyRef.current;
      if (
        selectedIdentityRef.current !== pending.selectionIdentity ||
        !processKeysEqual(latestKey, pending.key)
      ) {
        await releaseProcessControlLease({ leaseId: executionLease.id })
          .catch(() => undefined);
        executionLease = null;
        setNotice(t("app:staleTarget"));
        setPendingAction(null);
        return;
      }
      await releaseProcessControlLease({ leaseId: pending.lease.id })
        .catch(() => undefined);
      setPendingAction((current) =>
        current?.lease.id === pending.lease.id && executionLease
          ? { ...current, lease: executionLease }
          : current,
      );
      actionRecordId = userActions.start({
        kind: pending.source === "restart"
          ? "process_restart"
          : pending.action === "force_kill"
            ? "process_force_quit"
            : "process_close",
        targetName: pending.displayName,
        targetCount: 1,
      });
      const result = await executeProcessAction({
        leaseId: executionLease.id,
        key: pending.key,
        action: pending.action,
      });
      let resultMessage = result.message;
      let actionStatus: "succeeded" | "failed" = "succeeded";
      let actionVerification: "verified" | "not_confirmed" = "verified";
      if (pending.relaunchExecutable) {
        const exited = result.outcome === "exited" ||
          result.outcome === "already_exited" ||
          await waitForProcessIdentityExit(
            pending.selectionIdentity,
            getSystemSnapshot,
          );
        if (exited) {
          await relaunchApplication(pending.relaunchExecutable);
          const relaunched = await waitForProcessReplacement(
            pending.selectionIdentity,
            pending.displayName,
            getSystemSnapshot,
          );
          resultMessage = t("daily:applications.restartComplete", {
            name: pending.displayName,
          });
          actionVerification = relaunched ? "verified" : "not_confirmed";
        } else {
          resultMessage = t("daily:applications.restartStillRunning", {
            name: pending.displayName,
          });
          actionStatus = "failed";
        }
      } else {
        const exited = result.outcome === "exited" ||
          result.outcome === "already_exited" ||
          await waitForProcessIdentityExit(
            pending.selectionIdentity,
            getSystemSnapshot,
          );
        actionStatus = exited ? "succeeded" : "failed";
      }
      userActions.complete(actionRecordId, {
        status: actionStatus,
        verification: actionVerification,
        targetCount: 1,
        outcome: {
          selectedCount: 1,
          succeededCount: actionStatus === "succeeded" ? 1 : 0,
          processExited: actionStatus === "succeeded",
          processRestarted: pending.source === "restart"
            && actionStatus === "succeeded"
            && actionVerification === "verified",
        },
      });
      setNotice(resultMessage);
      if (pending.dailyIntent) {
        setDailyRecheck({
          intent: pending.dailyIntent,
          outcome: result.outcome,
          checkedAtMs: Date.now(),
        });
      }
      setPendingAction(null);
      await refreshNow();
    } catch (caughtError) {
      const actionError = normalizeCommandError(caughtError);
      if (actionRecordId) {
        userActions.complete(actionRecordId, {
          status: "failed",
          verification: "not_confirmed",
          targetCount: 1,
        });
      }
      const leaseId = executionLease?.id ?? pending.lease.id;
      void releaseProcessControlLease({ leaseId }).catch(() => undefined);
      setNotice(processActionErrorMessage(actionError, t));
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
        <BrandWordmark />
        <span><i className="live-status-dot" />{t("app:samplerConnecting")}</span>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="boot-screen boot-screen--error">
        <span className="brand-mark"><img src={brandMark} alt="" /></span>
        <strong>{t("app:samplerFailed")}</strong>
        <span>{error?.message ?? t("app:samplerNoData")}</span>
        <button className="button button--primary" type="button" onClick={() => void refreshNow()}>{t("common:retry")}</button>
      </main>
    );
  }

  const memoryPercent = memoryUsagePercent(
    snapshot.memory.usedBytes,
    snapshot.memory.totalBytes,
  );
  const primaryVolume = snapshot.disk.volumes.find(({ mountPoint }) => mountPoint === "/") ??
    [...snapshot.disk.volumes].sort((left, right) => right.totalBytes - left.totalBytes)[0] ??
    null;
  const primaryVolumeUsedBytes = primaryVolume
    ? Math.max(0, primaryVolume.totalBytes - primaryVolume.availableBytes)
    : null;
  const primaryVolumeUsagePercent = primaryVolume && primaryVolume.totalBytes > 0
    ? (primaryVolumeUsedBytes! / primaryVolume.totalBytes) * 100
    : null;
  const networkRate =
    snapshot.network.receivedBytesPerSecond === null ||
    snapshot.network.transmittedBytesPerSecond === null
      ? null
      : snapshot.network.receivedBytesPerSecond +
        snapshot.network.transmittedBytesPerSecond;
  const dailyMode = settings.experienceMode === "simple";
  const activeDiagnosis = diagnosis!;
  const dailyLevel = healthStateUpdate?.health ?? "observing";
  const recommendedDailyIntent = dailyIncidents.active[0]?.item.intent ?? null;
  const openDailyIntent = (intent: DailyIntent) => {
    setSelectedDailyIncident(null);
    setDailyIntent(intent);
    setActiveView("overview");
    setDailyRecheck((current) => current?.intent === intent ? current : null);
  };
  const openDailyIncident = (incident: DailyIncident) => {
    setSelectedDailyIncident(incident);
    setDailyIntent(incident.item.intent);
    setActiveView("overview");
    setDailyRecheck(null);
  };
  const navigateDaily = (view: ActiveView) => {
    setSelectedDailyIncident(null);
    setDailyIntent(null);
    setActiveView(view);
  };
  const openCleanupWorkspace = (workspace: "space" | "quick") => {
    setSelectedDailyIncident(null);
    setDailyIntent(null);
    setActiveView("cleanup");
    setCleanupWorkspaceRequest((current) => ({
      workspace,
      id: (current?.id ?? 0) + 1,
    }));
  };
  const openDailyCleanup = () => {
    openCleanupWorkspace("space");
  };
  const openUserActionDestination = (kind: UserActionKind) => {
    if (kind === "cleanup_delete") {
      navigateDaily("cleanup");
      return;
    }
    if (kind === "application_uninstall") {
      navigateDaily("applications");
      return;
    }
    if (kind === "volume_eject") {
      navigateDaily("storage");
      return;
    }
    if (kind === "application_update") {
      navigateDaily("settings");
      return;
    }
    if (kind === "startup_disable" || kind === "startup_enable") {
      if (dailyMode) openDailyIntent("startup");
      else setActiveView("startup");
      return;
    }
    navigateDaily("processes");
  };
  const openSystemSettingsPage = async (destination: SystemSettingsDestination) => {
    setNotice(null);
    try {
      await openSystemSettings(destination);
    } catch (caughtError) {
      setNotice(normalizeCommandError(caughtError).message);
    }
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
    setSelectedDailyIncident(null);
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
      {updater.promptVisible || updater.action === "installing" || updater.action === "ready"
      || updater.action === "installError" || updater.action === "restartError"
      || updater.updatedFromVersion ? (
        <Suspense fallback={null}>
          <GlobalUpdateTask updater={updater} />
        </Suspense>
      ) : null}
      <nav className="sidebar" aria-label={t("app:mainNavigation")}>
        <div className="brand">
          <span className="brand-mark"><img src={brandMark} alt="" /></span>
          <span>
            <BrandWordmark />
            <small className={`brand-context${dailyMode ? " is-daily" : " is-professional"}`}>
              <i aria-hidden="true" />
              {dailyMode
                ? t("app:mode.short.simple")
                : t("app:mode.short.professional")}
            </small>
          </span>
        </div>

        {dailyMode ? (
          <>
            <div className="nav-group daily-nav">
              <button className={activeView === "overview" ? "is-active" : ""} type="button" onClick={() => navigateDaily("overview")}><House size={18} />{t("daily:nav.today")}</button>
              <button className={activeView === "more" || activeView === "processes" || activeView === "storage" ? "is-active" : ""} type="button" onClick={() => navigateDaily("more")}><CircleHelp size={18} />{t("daily:nav.solve")}</button>
              <button className={activeView === "applications" ? "is-active" : ""} type="button" onClick={() => navigateDaily("applications")}>
                <ListTree size={18} />{t("app:applications")}
                {trashApplicationWatcher.applications.length > 0 ? (
                  <small
                    className="nav-alert-badge"
                    aria-label={`${trashApplicationWatcher.applications.length} ${t("applications:trashWatcher.title")}`}
                  >
                    {trashApplicationWatcher.applications.length}
                  </small>
                ) : null}
              </button>
              <button
                className={activeView === "cleanup" && cleanupWorkspace === "quick" ? "is-active" : ""}
                type="button"
                onClick={() => openCleanupWorkspace("quick")}
              >
                <Wand2 size={18} />{t("daily:nav.cleanupQuick")}
              </button>
              <button
                className={activeView === "cleanup" && cleanupWorkspace !== "quick" ? "is-active" : ""}
                type="button"
                onClick={() => openCleanupWorkspace("space")}
              >
                <Sparkles size={18} />{t("daily:nav.cleanupScan")}
              </button>
              <button className={activeView === "history" ? "is-active" : ""} type="button" onClick={() => navigateDaily("history")}><History size={18} />{t("daily:nav.records")}</button>
            </div>
          </>
        ) : (
          <>
            <div className="nav-group">
              <span className="nav-label">{t("app:monitor")}</span>
              <button className={activeView === "overview" ? "is-active" : ""} type="button" onClick={() => setActiveView("overview")}><CircleGauge size={17} />{t("app:overview")}</button>
              <button className={activeView === "applications" ? "is-active" : ""} type="button" onClick={() => setActiveView("applications")}>
                <ListTree size={17} />{t("app:applications")}
                {trashApplicationWatcher.applications.length > 0 ? (
                  <small
                    className="nav-alert-badge"
                    aria-label={`${trashApplicationWatcher.applications.length} ${t("applications:trashWatcher.title")}`}
                  >
                    {trashApplicationWatcher.applications.length}
                  </small>
                ) : null}
              </button>
              <button className={activeView === "processes" ? "is-active" : ""} type="button" onClick={() => setActiveView("processes")}><Cpu size={17} />{t("app:processes")}</button>
              <button className={activeView === "storage" ? "is-active" : ""} type="button" onClick={() => setActiveView("storage")}><Database size={17} />{t("app:storage")}</button>
              <button
                className={activeView === "cleanup" && cleanupWorkspace === "quick" ? "is-active" : ""}
                type="button"
                onClick={() => openCleanupWorkspace("quick")}
              >
                <Wand2 size={17} />{t("app:cleanupQuick")}
              </button>
              <button
                className={activeView === "cleanup" && cleanupWorkspace !== "quick" ? "is-active" : ""}
                type="button"
                onClick={() => openCleanupWorkspace("space")}
              >
                <Sparkles size={17} />{t("app:cleanupScan")}
              </button>
              <button className={activeView === "network" ? "is-active" : ""} type="button" onClick={() => setActiveView("network")}><Network size={17} />{t("app:network")}</button>
            </div>
            <div className="nav-group">
              <span className="nav-label">{t("app:diagnostics")}</span>
              <button className={activeView === "startup" ? "is-active" : ""} type="button" onClick={() => setActiveView("startup")}><Rocket size={17} />{t("app:startup")}</button>
              <button className={activeView === "history" ? "is-active" : ""} type="button" onClick={() => setActiveView("history")}><History size={17} />{t("app:history")}{resourceAlerts.activeAlerts.length > 0 ? <small className="nav-alert-badge" aria-label={t("history:alerts.active", { count: resourceAlerts.activeAlerts.length })}>{resourceAlerts.activeAlerts.length}</small> : null}</button>
              <button className={activeView === "settings" ? "is-active" : ""} type="button" onClick={() => setActiveView("settings")}>
                <Settings2 size={17} />{t("app:settings")}
                {updater.availableVersion ? <small className="nav-update-badge">v{updater.availableVersion}</small> : null}
              </button>
            </div>
          </>
        )}
        <div className="sidebar-mode-switch" role="group" aria-label={t("app:mode.label")}>
          <span
            className={`sidebar-mode-switch__indicator is-${dailyMode ? "simple" : "professional"}`}
            aria-hidden="true"
          />
          <button
            className={dailyMode ? "is-active" : ""}
            type="button"
            aria-pressed={dailyMode}
            aria-label={dailyMode
              ? t("app:mode.simple")
              : t("app:mode.switchTo.simple")}
            disabled={modeTransition !== null || dailyMode}
            onClick={() => switchExperienceMode("simple")}
          >
            <Sparkles size={15} /><span>{t("app:mode.short.simple")}</span>
          </button>
          <button
            className={!dailyMode ? "is-active" : ""}
            type="button"
            aria-pressed={!dailyMode}
            aria-label={!dailyMode
              ? t("app:mode.professional")
              : t("app:mode.switchTo.professional")}
            disabled={modeTransition !== null || !dailyMode}
            onClick={() => openProfessional("overview")}
          >
            <SlidersHorizontal size={15} /><span>{t("app:mode.short.professional")}</span>
          </button>
        </div>
      </nav>

      <div className="workspace">
        <header className="topbar">
          {dailyMode ? (
            <>
              <div className="daily-topbar-heading">
                <span className="eyebrow">{dailyIntent
                  ? t(`daily:intents.${dailyIntent}.title`)
                  : t(`daily:nav.${activeView === "more"
                    ? "solve"
                    : activeView === "cleanup" || activeView === "storage"
                      ? cleanupWorkspace === "quick"
                        ? "cleanupQuick"
                        : "cleanupScan"
                      : activeView === "history"
                        ? "records"
                        : activeView === "settings"
                          ? "settings"
                          : activeView === "processes" || activeView === "applications"
                            ? "applications"
                            : "today"}`)}</span>
                <h1>{snapshot.host.osName.toLocaleLowerCase().includes("darwin") ? t("daily:topbar.thisMac") : t("daily:topbar.thisComputer")}</h1>
              </div>
              <div className="daily-topbar-actions">
                <span className={`daily-topbar-status is-${dailyLevel}`}><i />{t(`daily:status.${dailyLevel}.short`)}</span>
                {fileInsights.loading ? (
                  <button
                    className="background-task-chip"
                    type="button"
                    onClick={() => {
                      setDailyIntent(null);
                      setActiveView("cleanup");
                    }}
                  >
                    <RefreshCw className="is-spinning" size={14} />
                    {t("cleanup:fileInsights.running")}
                  </button>
                ) : null}
                <GlobalTaskCenter
                  cleanup={cleanupScan}
                  fileInsights={fileInsights}
                  startup={startupItems}
                  updater={updater}
                  onOpenCleanup={() => navigateDaily("cleanup")}
                  onOpenStartup={() => navigateDaily("startup")}
                  onOpenUpdates={() => navigateDaily("settings")}
                />
                {isDesktopRuntime() ? <button
                  className={`icon-button companion-toggle${companionVisible ? " is-active" : ""}`}
                  type="button"
                  data-tooltip={t(`app:companion.${companionVisible ? "hide" : "show"}`)}
                  aria-label={t(`app:companion.${companionVisible ? "hide" : "show"}`)}
                  aria-pressed={companionVisible}
                  onClick={() => void invoke("toggle_companion_window")}
                >
                  <RobinIcon size={18} />
                </button> : null}
                <LocaleSelect
                  compact
                  withIcon
                  className="language-button daily-language-button"
                  value={settings.language}
                  label={t("app:switchLanguage")}
                  onChange={(language) => updateSettings({ language })}
                />
                <button
                  className={`icon-button update-aware-button${activeView === "settings" ? " is-active" : ""}${updater.availableVersion ? " has-update" : ""}`}
                  type="button"
                  title={updater.availableVersion
                    ? t("settings:about.updateAvailable", { version: updater.availableVersion })
                    : t("daily:nav.settings")}
                  aria-label={updater.availableVersion
                    ? t("settings:about.updateAvailable", { version: updater.availableVersion })
                    : t("daily:nav.settings")}
                  onClick={() => navigateDaily("settings")}
                >
                  <Settings2 size={16} />
                  {updater.availableVersion ? <i aria-hidden="true" /> : null}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="host-heading">
                <span className="eyebrow">{t(PROFESSIONAL_VIEW_EYEBROW[activeView])}</span>
                <h1>{snapshot.host.hostname}</h1>
                <p>{snapshot.host.osName} {snapshot.host.osVersion} · {snapshot.host.architecture}</p>
              </div>
              <div className="topbar-actions">
            {!isDesktopRuntime() ? <span className="demo-badge">{t("app:demoData")}</span> : null}
            <span className={`sample-status${paused ? " is-paused" : ""}`}>
              <i />{paused ? t("app:paused") : snapshot.warmingUp ? t("common:warmup") : t("app:live")}
            </span>
            {fileInsights.loading ? (
              <button
                className="background-task-chip"
                type="button"
                onClick={() => setActiveView("cleanup")}
              >
                <RefreshCw className="is-spinning" size={14} />
                {t("cleanup:fileInsights.running")}
              </button>
            ) : null}
            <GlobalTaskCenter
              cleanup={cleanupScan}
              fileInsights={fileInsights}
              startup={startupItems}
              updater={updater}
              onOpenCleanup={() => setActiveView("cleanup")}
              onOpenStartup={() => setActiveView("startup")}
              onOpenUpdates={() => setActiveView("settings")}
            />
            {isDesktopRuntime() ? <button
              className={`icon-button companion-toggle${companionVisible ? " is-active" : ""}`}
              type="button"
              data-tooltip={t(`app:companion.${companionVisible ? "hide" : "show"}`)}
              aria-label={t(`app:companion.${companionVisible ? "hide" : "show"}`)}
              aria-pressed={companionVisible}
              onClick={() => void invoke("toggle_companion_window")}
            >
              <RobinIcon size={18} />
            </button> : null}
            <LocaleSelect
              compact
              withIcon
              className="language-button"
              value={settings.language}
              label={t("app:switchLanguage")}
              onChange={(language) => updateSettings({ language })}
            />
            {activeView === "overview" || activeView === "processes" || activeView === "storage" ? (
              <button className="icon-button" type="button" title={t("app:refreshNow")} aria-label={t("app:refreshNow")} onClick={() => void refreshActiveView()}>
                <RefreshCw size={16} />
              </button>
            ) : null}
            <button
              className="button button--secondary"
              type="button"
              aria-label={`${paused ? t("app:resume") : t("app:pause")} · ${t("app:monitor")}`}
              title={`${paused ? t("app:resume") : t("app:pause")} · ${t("app:monitor")}`}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused ? t("app:resume") : t("app:pause")} · {t("app:monitor")}
            </button>
              </div>
            </>
          )}
        </header>

        {error ? <div className="global-error">{t("app:sampleFailed", { message: error.message })}</div> : null}
        {settingsOperationFailure ? (
          <div className="global-error" role="alert">
            {t("common:unavailable")}:{" "}
            {t(
              settingsOperationFailure.kind === "launchAtLogin"
                ? "settings:background.launchAtLogin"
                : settingsOperationFailure.kind === "showDockIcon"
                  ? "settings:background.showDockIcon"
                  : "settings:background.title",
            )}
            <button type="button" onClick={retrySettingsOperation}>
              {t("common:retry")}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOperationFailure(null)}
            >
              {t("common:close")}
            </button>
          </div>
        ) : null}
        {notice ? <div className="global-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>{t("common:close")}</button></div> : null}

        <div className={`content-layout${dailyMode || activeView === "applications" || activeView === "cleanup" || activeView === "network" || activeView === "startup" || activeView === "history" || activeView === "settings" ? " content-layout--wide" : ""}`}>
          <main className="main-content" ref={mainContentRef}>
            <Suspense fallback={<div className="surface-loading"><span className="live-status-dot" />{t("common:loading")}</div>}>
            {dailyMode ? (
              dailyIntent ? (
                <DailyGuide
                  intent={dailyIntent}
                  incident={selectedDailyIncident}
                  incidents={dailyIncidents.active}
                  pendingIncidentCount={dailyIncidents.pendingCount}
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
                  onBack={() => {
                    setSelectedDailyIncident(null);
                    setDailyIntent(null);
                  }}
                  onRefresh={refreshDailyGuide}
                  onOpenCleanup={openDailyCleanup}
                  onOpenSpace={() => navigateDaily("storage")}
                  onOpenApplications={() => navigateDaily("processes")}
                  onOpenNetworkDetails={() => openProfessional("network")}
                  onOpenIntent={openDailyIntent}
                  onOpenIncident={openDailyIncident}
                  onRefreshStartup={startupItems.refresh}
                  onRequestClose={(identity, name) => void beginDiagnosisRequestClose(identity, name, dailyIntent)}
                  onOpenSystemSettings={(destination) => void openSystemSettingsPage(destination)}
                  onUserActionStart={userActions.start}
                  onUserActionComplete={userActions.complete}
                />
              ) : activeView === "overview" ? (
                <DailyHome
                  diagnosis={activeDiagnosis}
                  snapshot={snapshot}
                  incidents={dailyIncidents.active}
                  alertEvents={resourceAlerts.events}
                  onOpenIncident={openDailyIncident}
                  onOpenCheck={(kind) => {
                    if (kind === "speed") {
                      navigateDaily("processes");
                    } else if (kind === "space") {
                      navigateDaily("storage");
                    } else {
                      openDailyIntent("heat");
                    }
                  }}
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
                  onRequestRestart={(identity, name) => void beginDiagnosisRequestClose(identity, name, "slow", true)}
                />
              ) : activeView === "storage" ? (
                <DailySpace
                  snapshot={snapshot}
                  cleanupSnapshot={cleanupScan.snapshot}
                  cleanupLoading={cleanupScan.loading}
                  onOpenCleanup={openDailyCleanup}
                  onRefresh={async () => { await refreshNow(); }}
                />
              ) : activeView === "applications" ? (
                <ApplicationCenter
                  applications={activeDiagnosis.applications}
                  processes={snapshot.processes}
                  totalMemoryBytes={snapshot.memory.totalBytes}
                  historyPoints={applicationImpactHistory.points}
                  historyEnabled={settings.historyPersistenceEnabled && settings.historyApplicationNamesEnabled && settings.applicationImpactHistoryEnabled}
                  historyStorageStatus={applicationImpactHistory.storageStatus}
                  onHistoryEnabledChange={(enabled) => updateSettings({ applicationImpactHistoryEnabled: enabled })}
                  startupSnapshot={startupItems.snapshot}
                  connectionsSnapshot={connectionsSnapshot}
                  onOpenStartup={() => navigateDaily("startup")}
                  onOpenNetwork={() => navigateDaily("network")}
                  trashWatcherEnabled={settings.trashApplicationWatcherEnabled}
                  onTrashWatcherEnabledChange={(trashApplicationWatcherEnabled) =>
                    updateSettings({ trashApplicationWatcherEnabled })}
                  trashedApplications={trashApplicationWatcher.applications}
                  trashWatcherError={trashApplicationWatcher.error}
                  onUserActionStart={userActions.start}
                  onUserActionComplete={userActions.complete}
                />
              ) : activeView === "cleanup" ? (
                <CleanupAssistant
                  snapshot={cleanupScan.snapshot}
                  error={cleanupScan.error}
                  loading={cleanupScan.loading}
                  cancelling={cleanupScan.cancelling}
                  phase={cleanupScan.phase}
                  progress={cleanupScan.progress}
                  snapshotStatus={cleanupScan.snapshotStatus}
                  growthComparison={cleanupScan.growthComparison}
                  volumes={snapshot.disk.volumes}
                  onScan={(target) => void cleanupScan.scan(target)}
                  onCancel={() => void cleanupScan.cancel()}
                  onDeletionApplied={cleanupScan.applyDeletion}
                  directoryRefreshStatus={cleanupScan.directoryRefreshStatus}
                  directoryRefreshError={cleanupScan.directoryRefreshError}
                  onRefreshDirectory={(directoryId) => void cleanupScan.refreshDirectory(directoryId)}
                  onCancelDirectoryRefresh={() => void cleanupScan.cancelDirectoryRefresh()}
                  workspaceRequest={cleanupWorkspaceRequest}
                  onWorkspaceChange={setCleanupWorkspace}
                  onReloadLatestSnapshot={cleanupScan.reloadLatestSnapshot}
                  onUserActionStart={userActions.start}
                  onUserActionComplete={userActions.complete}
                  fileInsights={fileInsights}
                />
              ) : activeView === "more" ? (
                <DailySolve
                  onOpenIntent={openDailyIntent}
                  onOpenApplications={() => navigateDaily("processes")}
                  recommendedIntent={recommendedDailyIntent}
                />
              ) : activeView === "history" ? (
                <DailyRecords
                  alertEvents={resourceAlerts.events}
                  points={persistentHistory.points}
                  applicationImpactPoints={applicationImpactHistory.points}
                  networkQualityPoints={networkQuality.history}
                  applicationWatchEvents={applicationWatchRules.events}
                  actionRecords={userActions.records}
                  storedActionCount={userActions.storedRecords.length}
                  onOpenAction={openUserActionDestination}
                  onClearSavedActions={userActions.clearSaved}
                  weeklyReviewNotificationEnabled={
                    settings.weeklyReviewNotificationEnabled
                  }
                  notificationStatus={desktopNotifications.status}
                  onWeeklyReviewNotificationEnabledChange={
                    (weeklyReviewNotificationEnabled) =>
                      updateSettings({ weeklyReviewNotificationEnabled })
                  }
                />
              ) : activeView === "settings" ? (
                <DailySettings
                  settings={settings}
                  launchAtLoginStatus={launchAtLoginStatus}
                  notificationStatus={desktopNotifications.status}
                  snapshot={snapshot}
                  updater={updater}
                  onChange={updateSettings}
                  onLaunchAtLoginChange={updateLaunchAtLogin}
                  onOpenNotificationSettings={openNotificationSettings}
                  onOpenOnboarding={() => setOnboardingOpen(true)}
                  onClearAllData={clearAllProductData}
                />
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
                <PersonalBaselinePanel points={persistentHistory.points} compact />
                <DeviceWellbeing
                  sensors={snapshot.sensors}
                  warmingUp={snapshot.warmingUp}
                  applications={diagnosis?.applications ?? []}
                  onInspectSleepBlocker={(identity) => {
                    const process = snapshot.processes.find(
                      (candidate) => processIdentity(candidate) === identity,
                    );
                    if (process) selectProcess(process);
                    setActiveView("processes");
                  }}
                />
                <>
                    <section className="metric-grid" aria-label={t("app:metricsLabel")}>
                      <MetricCard
                        icon={Cpu}
                        label="CPU"
                        value={formatPercent(snapshot.cpu.usagePercent)}
                        context={t("app:metrics.cpuContext", { count: snapshot.cpu.logicalCoreCount })}
                        tone="blue"
                        progress={snapshot.cpu.usagePercent ?? 0}
                        usageLevel={resourceUsageLevel(snapshot.cpu.usagePercent, settings.usageThresholds)}
                      />
                      <MetricCard
                        icon={MemoryStick}
                        label={t("app:metrics.memory")}
                        value={formatBytes(snapshot.memory.usedBytes)}
                        context={t("app:metrics.memoryContext", {
                          total: formatBytes(snapshot.memory.totalBytes),
                          swap: formatBytes(snapshot.memory.swapUsedBytes),
                        })}
                        tone="violet"
                        progress={memoryPercent}
                        usageLevel={resourceUsageLevel(memoryPercent, settings.usageThresholds)}
                      />
                      <MetricCard
                        icon={Database}
                        label={t("app:metrics.disk")}
                        value={primaryVolumeUsagePercent === null
                          ? t("common:unavailable")
                          : formatBytes(primaryVolumeUsedBytes ?? 0)}
                        context={primaryVolume
                          ? t("app:metrics.diskCapacityContext", {
                            total: formatBytes(primaryVolume.totalBytes),
                            available: formatBytes(primaryVolume.availableBytes),
                          })
                          : t("app:metrics.diskContext", {
                          read: formatRate(snapshot.disk.readBytesPerSecond),
                          write: formatRate(snapshot.disk.writeBytesPerSecond),
                          })}
                        tone="amber"
                        progress={primaryVolumeUsagePercent ?? 0}
                        usageLevel={resourceUsageLevel(primaryVolumeUsagePercent, settings.usageThresholds)}
                      />
                      <MetricCard
                        icon={Network}
                        label={t("app:metrics.network")}
                        value={formatRate(networkRate)}
                        context={t("app:metrics.networkContext", {
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
                    connections={connectionsSnapshot?.connections}
                    selectedIdentity={selectedIdentity}
                    onSelect={selectProcess}
                    query={processPreferences.query}
                    onQueryChange={(query) => updateProcessPreferences({ query })}
                    sortKey={processPreferences.sortKey}
                    direction={processPreferences.sortDirection}
                    liveSort={processPreferences.liveSort}
                    onSortChange={(sortKey, sortDirection) =>
                      updateProcessPreferences({ sortKey, sortDirection })
                    }
                />
                <GpuEnergyPanel processes={snapshot.processes} />
              </>
            ) : activeView === "processes" ? (
              <>
                <BackgroundProcessCard
                  processes={snapshot.processes}
                  onInspect={selectProcess}
                />
                <ProcessTable
                  processes={snapshot.processes}
                  connections={connectionsSnapshot?.connections}
                  selectedIdentity={selectedIdentity}
                  onSelect={selectProcess}
                  query={processPreferences.query}
                  onQueryChange={(query) => updateProcessPreferences({ query })}
                  sortKey={processPreferences.sortKey}
                  direction={processPreferences.sortDirection}
                  liveSort={processPreferences.liveSort}
                  onLiveSortChange={(liveSort) =>
                    updateProcessPreferences({ liveSort })
                  }
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
                  residualOnly={processPreferences.residualOnly}
                  onResidualOnlyChange={(residualOnly) =>
                    updateProcessPreferences({ residualOnly })
                  }
                  onResetPreferences={() =>
                    setProcessPreferences({
                      ...defaultProcessExplorerPreferences(),
                      viewMode: settings.defaultProcessView,
                    })
                  }
              />
              </>
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
                onVolumeEjected={async () => {
                  await refreshNow();
                }}
                onUserActionStart={userActions.start}
                onUserActionComplete={userActions.complete}
              />
            ) : activeView === "applications" ? (
              <ApplicationCenter
                applications={activeDiagnosis.applications}
                processes={snapshot.processes}
                totalMemoryBytes={snapshot.memory.totalBytes}
                historyPoints={applicationImpactHistory.points}
                historyEnabled={settings.historyPersistenceEnabled && settings.historyApplicationNamesEnabled && settings.applicationImpactHistoryEnabled}
                historyStorageStatus={applicationImpactHistory.storageStatus}
                onHistoryEnabledChange={(enabled) => updateSettings({ applicationImpactHistoryEnabled: enabled })}
                startupSnapshot={startupItems.snapshot}
                connectionsSnapshot={connectionsSnapshot}
                onOpenStartup={() => setActiveView("startup")}
                onOpenNetwork={() => setActiveView("network")}
                trashWatcherEnabled={settings.trashApplicationWatcherEnabled}
                onTrashWatcherEnabledChange={(trashApplicationWatcherEnabled) =>
                  updateSettings({ trashApplicationWatcherEnabled })}
                trashedApplications={trashApplicationWatcher.applications}
                trashWatcherError={trashApplicationWatcher.error}
                onUserActionStart={userActions.start}
                onUserActionComplete={userActions.complete}
              />
            ) : activeView === "cleanup" ? (
              <CleanupAssistant
                snapshot={cleanupScan.snapshot}
                error={cleanupScan.error}
                loading={cleanupScan.loading}
                cancelling={cleanupScan.cancelling}
                phase={cleanupScan.phase}
                progress={cleanupScan.progress}
                snapshotStatus={cleanupScan.snapshotStatus}
                growthComparison={cleanupScan.growthComparison}
                volumes={snapshot.disk.volumes}
                onScan={(target) => void cleanupScan.scan(target)}
                onCancel={() => void cleanupScan.cancel()}
                onDeletionApplied={cleanupScan.applyDeletion}
                directoryRefreshStatus={cleanupScan.directoryRefreshStatus}
                directoryRefreshError={cleanupScan.directoryRefreshError}
                onRefreshDirectory={(directoryId) => void cleanupScan.refreshDirectory(directoryId)}
                onCancelDirectoryRefresh={() => void cleanupScan.cancelDirectoryRefresh()}
                workspaceRequest={cleanupWorkspaceRequest}
                onWorkspaceChange={setCleanupWorkspace}
                onReloadLatestSnapshot={cleanupScan.reloadLatestSnapshot}
                onUserActionStart={userActions.start}
                onUserActionComplete={userActions.complete}
                fileInsights={fileInsights}
              />
            ) : activeView === "network" ? (
              <NetworkExplorer
                network={snapshot.network}
                history={history}
                connections={connectionsSnapshot}
                connectionsError={connectionsError}
                connectionsLoading={connectionsLoading}
                connectionsPaused={paused}
                onRefreshConnections={() => void refreshConnections()}
                onResumeMonitoring={() => setPaused(false)}
                connectionRefreshIntervalMs={settings.connectionRefreshIntervalMs}
                connectionHistoryEnabled={settings.networkConnectionHistoryEnabled}
                connectionHistoryRetentionDays={settings.networkConnectionHistoryRetentionDays}
                onConnectionHistoryChange={(networkConnectionHistoryEnabled) => updateSettings({ networkConnectionHistoryEnabled })}
                onConnectionHistoryRetentionChange={(networkConnectionHistoryRetentionDays) => updateSettings({ networkConnectionHistoryRetentionDays })}
                connectionHistoryEntries={connectionHistory.entries}
                connectionHistoryError={connectionHistory.error}
                onClearConnectionHistory={connectionHistory.clear}
                qualityMonitor={networkQuality}
                qualityHistoryEnabled={settings.networkQualityHistoryEnabled}
                qualityHistoryHours={settings.networkQualityHistoryHours}
                onQualityHistoryEnabledChange={(networkQualityHistoryEnabled) =>
                  updateSettings({ networkQualityHistoryEnabled })
                }
                onQualityHistoryHoursChange={(networkQualityHistoryHours) =>
                  updateSettings({ networkQualityHistoryHours })
                }
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
                impactMeasurements={startupImpactMeasurements}
                actionRecords={userActions.records}
                launchAtLogin={settings.launchAtLogin}
                onRefresh={startupItems.refresh}
                onEnableLaunchAtLogin={() => updateLaunchAtLogin(true)}
                onUserActionStart={userActions.start}
                onUserActionComplete={userActions.complete}
              />
            ) : activeView === "history" ? (
              <HistoryExplorer
                points={persistentHistory.points}
                storedPointCount={persistentHistory.storedPoints.length}
                applicationImpactPoints={applicationImpactHistory.points}
                applicationImpactHistoryEnabled={
                  settings.historyPersistenceEnabled
                  && settings.historyApplicationNamesEnabled
                  && settings.applicationImpactHistoryEnabled
                }
                applicationImpactStorageStatus={
                  applicationImpactHistory.storageStatus
                }
                historyStorageStatus={persistentHistory.storageStatus}
                alertEvents={resourceAlerts.events}
                storedAlertEventCount={resourceAlerts.storedEvents.length}
                applicationWatchEvents={applicationWatchRules.events}
                storedApplicationWatchEventCount={applicationWatchRules.storedEvents.length}
                actionRecords={userActions.records}
                networkQualityPoints={networkQuality.history}
                storedUserActionCount={userActions.storedRecords.length}
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
                onApplicationImpactHistoryEnabledChange={(enabled) =>
                  updateSettings({
                    historyPersistenceEnabled: enabled
                      ? true
                      : settings.historyPersistenceEnabled,
                    historyApplicationNamesEnabled: enabled
                      ? true
                      : settings.historyApplicationNamesEnabled,
                    applicationImpactHistoryEnabled: enabled,
                  })
                }
                onClear={() => {
                  persistentHistory.clear();
                  resourceAlerts.clearSaved();
                  applicationWatchRules.clearSaved();
                  userActions.clearSaved();
                  applicationImpactHistory.clear();
                }}
                onOpenUserAction={openUserActionDestination}
              />
            ) : (
              <SettingsExplorer
                settings={settings}
                launchAtLoginStatus={launchAtLoginStatus}
                notificationStatus={desktopNotifications.status}
                notificationDelivery={notificationDelivery}
                dataPrivacy={productDataPrivacy}
                activeApplicationWatchRuleIds={applicationWatchRules.activeRuleIds}
                snapshot={snapshot}
                updater={updater}
                onChange={updateSettings}
                onLaunchAtLoginChange={updateLaunchAtLogin}
                onOpenNotificationSettings={openNotificationSettings}
                onSendTestNotification={desktopNotifications.sendTest}
                onOpenOnboarding={() => setOnboardingOpen(true)}
                onClearAllData={clearAllProductData}
              />
            )}
            </Suspense>
          </main>

          {settings.experienceMode === "professional" && (activeView === "overview" || activeView === "processes" || activeView === "storage") ? (
            <Suspense fallback={null}>
              <ProcessInspector
                selected={selectedProcess ?? (selectionMissing ? lastSelected : null)}
                selectionMissing={selectionMissing}
                detail={activeDetail}
                detailError={detailError}
                detailLoading={detailLoading}
                onRetryDetail={() => setDetailRetryRevision((current) => current + 1)}
                history={selectedHistory}
                capabilities={snapshot.capabilities}
                preparingAction={preparingAction}
                onAction={(action) => void beginProcessAction(action)}
                onRestart={() => {
                  if (selectedIdentity && activeDetail) {
                    void beginDiagnosisRequestClose(selectedIdentity, activeDetail.name, undefined, true);
                  }
                }}
              />
            </Suspense>
          ) : null}
        </div>

        {!dailyMode ? <footer className="statusbar">
          <span><Gauge size={13} />{t("app:status.interval", { interval: snapshot.sampleIntervalMs })}</span>
          <span>
            {activeView === "network"
              ? t("app:status.interfacesAndConnections", {
                  interfaces: snapshot.network.interfaceCount,
                  connections: connectionsSnapshot?.summary.totalCount ?? "—",
                })
              : activeView === "history"
                ? t("app:status.savedHistory", {
                    count: persistentHistory.storedPoints.length,
                  })
              : activeView === "cleanup"
                ? t("app:status.cleanupEntries", {
                    count: cleanupScan.progress?.scannedEntryCount ?? cleanupScan.snapshot?.scannedEntryCount ?? 0,
                  })
              : t("app:status.processCount", { count: snapshot.processes.length })}
          </span>
          <span>{snapshot.host.cpuName || snapshot.host.kernelVersion}</span>
          {samplerStatus ? (
            <span
              className={`statusbar__sampler${samplerStatus.consecutiveFailures > 0 ? " is-degraded" : ""}`}
              style={samplerStatus.consecutiveFailures > 0
                ? { color: "var(--warning)" }
                : undefined}
              title={samplerStatus.degradedReason ?? undefined}
            >
              {samplerStatus.lastSuccessAtMs
                ? t("app:status.samplerSaved", {
                    time: new Date(samplerStatus.lastSuccessAtMs)
                      .toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      }),
                    failures: samplerStatus.consecutiveFailures,
                  })
                : t("app:status.samplerWaiting")}
            </span>
          ) : null}
          <span className="statusbar__sequence">#{snapshot.sequence}</span>
        </footer> : null}
      </div>

      {pendingAction ? (
        <Suspense fallback={null}>
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
        </Suspense>
      ) : null}
      {onboardingOpen ? (
        <Suspense fallback={(
          <div className="first-run-guide" role="status" aria-label={t("common:loading")}>
            <div className="first-run-guide__backdrop" />
            <section className="first-run-guide__panel">
              <div className="surface-loading"><span className="live-status-dot" />{t("common:loading")}</div>
            </section>
          </div>
        )}>
          <FirstRunGuide
            settings={settings}
            notificationStatus={desktopNotifications.status}
            onChange={updateSettings}
            onOpenNotificationSettings={openNotificationSettings}
            onComplete={closeOnboarding}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function latestNonZeroTimestamp(values: readonly number[]): number | null {
  return values.reduce((latest, value) => Math.max(latest, value), 0) || null;
}

function processActionErrorMessage(
  error: unknown,
  t: ReturnType<typeof useAppTranslation>["t"],
): string {
  const normalized = normalizeCommandError(error);
  if (
    normalized.code === "stale_process"
    || normalized.code === "process_exited"
    || normalized.code === "control_lease_mismatch"
  ) {
    return t("process:errors.targetChanged");
  }
  if (normalized.code === "permission_denied") {
    return t("process:errors.permissionDenied");
  }
  if (normalized.code === "graceful_close_unavailable") {
    return t("process:errors.noCloseWindow");
  }
  if (
    normalized.code === "control_unavailable"
    || normalized.code === "unsupported_action"
  ) {
    return t("process:errors.unavailable");
  }
  if (normalized.code === "resource_exhausted") {
    return t("process:errors.busy");
  }
  return normalized.message;
}

export default App;
