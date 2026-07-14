import {
  Activity,
  CircleGauge,
  Cpu,
  Database,
  Gauge,
  History,
  Languages,
  ListTree,
  MemoryStick,
  Network,
  Pause,
  Play,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  createProcessControlLease,
  executeProcessAction,
  getProcessDetail,
  isDesktopRuntime,
  releaseProcessControlLease,
} from "./api";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { HistoryExplorer } from "./components/HistoryExplorer";
import { MetricCard } from "./components/MetricCard";
import { NetworkExplorer } from "./components/NetworkExplorer";
import { ProcessInspector } from "./components/ProcessInspector";
import { ProcessTable } from "./components/ProcessTable";
import { ResourceHistory } from "./components/ResourceHistory";
import { SettingsExplorer } from "./components/SettingsExplorer";
import { StorageExplorer } from "./components/StorageExplorer";
import { useNetworkConnections } from "./hooks/useNetworkConnections";
import { usePersistentHistory } from "./hooks/usePersistentHistory";
import { useResourceAlerts } from "./hooks/useResourceAlerts";
import { useSelectedProcessHistory } from "./hooks/useSelectedProcessHistory";
import { useSystemMonitor } from "./hooks/useSystemMonitor";
import { normalizeLanguage } from "./i18n";
import {
  defaultProcessExplorerPreferences,
  loadProcessExplorerPreferences,
  pruneExpandedIdentities,
  saveProcessExplorerPreferences,
  type ProcessExplorerPreferences,
} from "./processExplorer";
import {
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
} from "./settings";
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

type ActiveView = "overview" | "processes" | "storage" | "network" | "history" | "settings";

interface PendingProcessAction {
  action: ProcessAction;
  selectionIdentity: string;
  key: ProcessKey;
  lease: ProcessControlLease;
  detail: ProcessDetail;
}

function App() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() =>
    loadAppSettings(normalizeLanguage(i18n.resolvedLanguage)),
  );
  const {
    snapshot,
    history,
    error,
    paused,
    setPaused,
    loading,
    refreshNow,
  } = useSystemMonitor(settings.systemSampleIntervalMs);
  const persistentHistory = usePersistentHistory(
    history,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
  );
  const resourceAlerts = useResourceAlerts(
    snapshot,
    settings.usageThresholds,
    settings.historyPersistenceEnabled,
    settings.historyRetentionDays,
  );
  const [activeView, setActiveView] = useState<ActiveView>("overview");
  const {
    snapshot: connectionsSnapshot,
    error: connectionsError,
    loading: connectionsLoading,
    refreshNow: refreshConnections,
  } = useNetworkConnections(
    activeView === "network",
    paused,
    settings.connectionRefreshIntervalMs,
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
  const selectedHistory = useSelectedProcessHistory(snapshot, selectedIdentity);
  const refreshActiveView = useCallback(async () => {
    await Promise.all([
      refreshNow(),
      ...(activeView === "network" ? [refreshConnections()] : []),
    ]);
  }, [activeView, refreshConnections, refreshNow]);

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
  }, [settings]);

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
      if (event.key === " " && event.target === document.body) {
        event.preventDefault();
        setPaused((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPaused]);

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
          action,
          selectionIdentity,
          key,
          lease,
          detail: activeDetail,
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

  const handleAction = async () => {
    if (!pendingAction || submittingActionRef.current) return;
    const currentKey = activeDetail?.key ?? null;
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
        <span className="brand-mark"><Activity size={22} /></span>
        <strong>Pulse</strong>
        <span><i className="pulse-dot" />{t("app.samplerConnecting")}</span>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="boot-screen boot-screen--error">
        <span className="brand-mark"><Activity size={22} /></span>
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
  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label={t("app.mainNavigation")}>
        <div className="brand">
          <span className="brand-mark"><Activity size={20} /></span>
          <span><strong>Pulse</strong><small>LOCAL MONITOR</small></span>
        </div>

        <div className="nav-group">
          <span className="nav-label">{t("app.monitor")}</span>
          <button className={activeView === "overview" ? "is-active" : ""} type="button" onClick={() => setActiveView("overview")}>
            <CircleGauge size={17} />{t("app.overview")}
          </button>
          <button className={activeView === "processes" ? "is-active" : ""} type="button" onClick={() => setActiveView("processes")}>
            <ListTree size={17} />{t("app.processes")}
          </button>
          <button className={activeView === "storage" ? "is-active" : ""} type="button" onClick={() => setActiveView("storage")}>
            <Database size={17} />{t("app.storage")}
          </button>
          <button className={activeView === "network" ? "is-active" : ""} type="button" onClick={() => setActiveView("network")}>
            <Network size={17} />{t("app.network")}
          </button>
        </div>

        <div className="nav-group">
          <span className="nav-label">{t("app.diagnostics")}</span>
          <button className={activeView === "history" ? "is-active" : ""} type="button" onClick={() => setActiveView("history")}>
            <History size={17} />{t("app.history")}
            {resourceAlerts.activeAlerts.length > 0 ? (
              <small className="nav-alert-badge" aria-label={t("history.alerts.active", { count: resourceAlerts.activeAlerts.length })}>
                {resourceAlerts.activeAlerts.length}
              </small>
            ) : null}
          </button>
          <button className={activeView === "settings" ? "is-active" : ""} type="button" onClick={() => setActiveView("settings")}><Settings2 size={17} />{t("app.settings")}</button>
        </div>

        <div className="sidebar-footer">
          <span className="live-indicator"><i />{t("app.localSampling")}</span>
          <small>Schema v{snapshot.schemaVersion}</small>
        </div>
      </nav>

      <div className="workspace">
        <header className="topbar">
          <div className="host-heading">
            <span className="eyebrow">
              {t(`app.viewEyebrow.${activeView}`)}
            </span>
            <h1>{snapshot.host.hostname}</h1>
            <p>{snapshot.host.osName} {snapshot.host.osVersion} · {snapshot.host.architecture}</p>
          </div>
          <div className="topbar-actions">
            {!isDesktopRuntime() ? <span className="demo-badge">{t("app.demoData")}</span> : null}
            <span className={`sample-status${paused ? " is-paused" : ""}`}>
              <i />{paused ? t("app.paused") : snapshot.warmingUp ? t("common.warmup") : t("app.live")}
            </span>
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
        </header>

        {error ? <div className="global-error">{t("app.sampleFailed", { message: error.message })}</div> : null}
        {notice ? <div className="global-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>{t("common.close")}</button></div> : null}

        <div className={`content-layout${activeView === "network" || activeView === "history" || activeView === "settings" ? " content-layout--wide" : ""}`}>
          <main className="main-content" ref={mainContentRef}>
            {activeView === "overview" ? (
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
                onSelectProcess={selectProcess}
                usageThresholds={settings.usageThresholds}
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
              <SettingsExplorer settings={settings} onChange={updateSettings} />
            )}
          </main>

          {activeView === "overview" || activeView === "processes" || activeView === "storage" ? (
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

        <footer className="statusbar">
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
              : t("app.status.processCount", { count: snapshot.processes.length })}
          </span>
          <span>{snapshot.host.cpuName || snapshot.host.kernelVersion}</span>
          <span className="statusbar__sequence">#{snapshot.sequence}</span>
        </footer>
      </div>

      {pendingAction ? (
        <ConfirmActionDialog
          action={pendingAction.action}
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
