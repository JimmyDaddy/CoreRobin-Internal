import {
  Activity,
  CircleGauge,
  Cpu,
  Database,
  Gauge,
  History,
  ListTree,
  MemoryStick,
  Network,
  Pause,
  Play,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createProcessControlLease,
  executeProcessAction,
  getProcessDetail,
  isDesktopRuntime,
  releaseProcessControlLease,
} from "./api";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { MetricCard } from "./components/MetricCard";
import { NetworkExplorer } from "./components/NetworkExplorer";
import { ProcessInspector } from "./components/ProcessInspector";
import { ProcessTable } from "./components/ProcessTable";
import { ResourceHistory } from "./components/ResourceHistory";
import { StorageExplorer } from "./components/StorageExplorer";
import { useSelectedProcessHistory } from "./hooks/useSelectedProcessHistory";
import { useSystemMonitor } from "./hooks/useSystemMonitor";
import {
  defaultProcessExplorerPreferences,
  loadProcessExplorerPreferences,
  pruneExpandedIdentities,
  saveProcessExplorerPreferences,
  type ProcessExplorerPreferences,
} from "./processExplorer";
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
} from "./utils";
import "./App.css";

type ActiveView = "overview" | "processes" | "storage" | "network";

interface PendingProcessAction {
  action: ProcessAction;
  selectionIdentity: string;
  key: ProcessKey;
  lease: ProcessControlLease;
  detail: ProcessDetail;
}

function App() {
  const {
    snapshot,
    history,
    error,
    paused,
    setPaused,
    loading,
    refreshNow,
  } = useSystemMonitor();
  const [activeView, setActiveView] = useState<ActiveView>("overview");
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [lastSelected, setLastSelected] = useState<ProcessRow | null>(null);
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  const [detailError, setDetailError] = useState<CommandError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [processPreferences, setProcessPreferences] =
    useState<ProcessExplorerPreferences>(loadProcessExplorerPreferences);
  const [pendingAction, setPendingAction] = useState<PendingProcessAction | null>(null);
  const [preparingAction, setPreparingAction] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [bestEffortOptIn, setBestEffortOptIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedIdentityRef = useRef(selectedIdentity);
  const activeDetailKeyRef = useRef<ProcessKey | null>(null);
  const preparingActionRef = useRef(false);
  const submittingActionRef = useRef(false);
  const selectedHistory = useSelectedProcessHistory(snapshot, selectedIdentity);

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

  const updateProcessPreferences = useCallback(
    (update: Partial<Omit<ProcessExplorerPreferences, "version">>) => {
      setProcessPreferences((current) => ({ ...current, ...update }));
    },
    [],
  );

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
          setNotice("目标进程身份已经变化，操作已取消。请重新选择并确认。");
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
      setNotice("目标进程身份已经变化，操作已取消。请重新选择并确认。");
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
        <span><i className="pulse-dot" />正在连接本机采样器…</span>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="boot-screen boot-screen--error">
        <span className="brand-mark"><Activity size={22} /></span>
        <strong>无法启动采样器</strong>
        <span>{error?.message ?? "没有收到系统数据。"}</span>
        <button className="button button--primary" type="button" onClick={() => void refreshNow()}>重试</button>
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
      <nav className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark"><Activity size={20} /></span>
          <span><strong>Pulse</strong><small>LOCAL MONITOR</small></span>
        </div>

        <div className="nav-group">
          <span className="nav-label">监控</span>
          <button className={activeView === "overview" ? "is-active" : ""} type="button" onClick={() => setActiveView("overview")}>
            <CircleGauge size={17} />概览
          </button>
          <button className={activeView === "processes" ? "is-active" : ""} type="button" onClick={() => setActiveView("processes")}>
            <ListTree size={17} />进程
          </button>
          <button className={activeView === "storage" ? "is-active" : ""} type="button" onClick={() => setActiveView("storage")}>
            <Database size={17} />存储
          </button>
          <button className={activeView === "network" ? "is-active" : ""} type="button" onClick={() => setActiveView("network")}>
            <Network size={17} />网络
          </button>
        </div>

        <div className="nav-group">
          <span className="nav-label">诊断</span>
          <button type="button" disabled title="即将推出"><History size={17} />历史<small>稍后</small></button>
          <button type="button" disabled title="即将推出"><Settings2 size={17} />设置<small>稍后</small></button>
        </div>

        <div className="sidebar-footer">
          <span className="live-indicator"><i />本机采样</span>
          <small>Schema v{snapshot.schemaVersion}</small>
        </div>
      </nav>

      <div className="workspace">
        <header className="topbar">
          <div className="host-heading">
            <span className="eyebrow">
              {activeView === "overview"
                ? "系统概览"
                : activeView === "processes"
                  ? "进程诊断"
                  : activeView === "storage"
                    ? "存储诊断"
                    : "网络诊断"}
            </span>
            <h1>{snapshot.host.hostname}</h1>
            <p>{snapshot.host.osName} {snapshot.host.osVersion} · {snapshot.host.architecture}</p>
          </div>
          <div className="topbar-actions">
            {!isDesktopRuntime() ? <span className="demo-badge">浏览器演示数据</span> : null}
            <span className={`sample-status${paused ? " is-paused" : ""}`}>
              <i />{paused ? "已暂停" : snapshot.warmingUp ? "预热中" : "实时"}
            </span>
            <button className="icon-button" type="button" title="立即刷新" aria-label="立即刷新" onClick={() => void refreshNow()}>
              <RefreshCw size={16} />
            </button>
            <button className="button button--secondary" type="button" onClick={() => setPaused(!paused)}>
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused ? "继续" : "暂停"}
            </button>
          </div>
        </header>

        {error ? <div className="global-error">采样暂时失败：{error.message}</div> : null}
        {notice ? <div className="global-notice" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>关闭</button></div> : null}

        <div className={`content-layout${activeView === "network" ? " content-layout--wide" : ""}`}>
          <main className="main-content">
            {activeView === "overview" ? (
              <>
                <section className="metric-grid" aria-label="系统资源摘要">
                  <MetricCard
                    icon={Cpu}
                    label="CPU"
                    value={formatPercent(snapshot.cpu.usagePercent)}
                    context={`${snapshot.cpu.logicalCoreCount} 个逻辑核心 · 单进程可超过 100%`}
                    tone="blue"
                    progress={snapshot.cpu.usagePercent ?? 0}
                  />
                  <MetricCard
                    icon={MemoryStick}
                    label="内存使用"
                    value={formatBytes(snapshot.memory.usedBytes)}
                    context={`共 ${formatBytes(snapshot.memory.totalBytes)} · 交换 ${formatBytes(snapshot.memory.swapUsedBytes)}`}
                    tone="violet"
                    progress={memoryPercent}
                  />
                  <MetricCard
                    icon={Database}
                    label="磁盘 I/O"
                    value={formatRate(diskRate)}
                    context={`读 ${formatRate(snapshot.disk.readBytesPerSecond)} · 写 ${formatRate(snapshot.disk.writeBytesPerSecond)}`}
                    tone="amber"
                  />
                  <MetricCard
                    icon={Network}
                    label="网络吞吐"
                    value={formatRate(networkRate)}
                    context={`下行 ${formatRate(snapshot.network.receivedBytesPerSecond)} · 上行 ${formatRate(snapshot.network.transmittedBytesPerSecond)}`}
                    tone="green"
                  />
                </section>
                <ResourceHistory history={history} />
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
                  setProcessPreferences(defaultProcessExplorerPreferences())
                }
              />
            ) : activeView === "storage" ? (
              <StorageExplorer
                disk={snapshot.disk}
                history={history}
                processes={snapshot.processes}
                selectedIdentity={selectedIdentity}
                onSelectProcess={selectProcess}
              />
            ) : (
              <NetworkExplorer
                network={snapshot.network}
                history={history}
              />
            )}
          </main>

          {activeView !== "network" ? (
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
          <span><Gauge size={13} />采样间隔 {snapshot.sampleIntervalMs} ms</span>
          <span>
            {activeView === "network"
              ? `${snapshot.network.interfaceCount} 个网络接口`
              : `${snapshot.processes.length} 个进程`}
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
