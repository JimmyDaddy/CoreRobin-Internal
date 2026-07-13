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
import { useCallback, useEffect, useMemo, useState } from "react";

import { executeProcessAction, getProcessDetail, isDesktopRuntime } from "./api";
import { ConfirmActionDialog } from "./components/ConfirmActionDialog";
import { MetricCard } from "./components/MetricCard";
import { ProcessInspector } from "./components/ProcessInspector";
import { ProcessTable } from "./components/ProcessTable";
import { ResourceHistory } from "./components/ResourceHistory";
import { useSystemMonitor } from "./hooks/useSystemMonitor";
import type {
  CommandError,
  ProcessAction,
  ProcessDetail,
  ProcessKey,
  ProcessRow,
  ProcessSortKey,
  SortDirection,
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

type ActiveView = "overview" | "processes";

interface PendingProcessAction {
  action: ProcessAction;
  selectionIdentity: string;
  key: ProcessKey;
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
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<ProcessSortKey>("cpu");
  const [sortDirection, setSortDirection] = useState<SortDirection>("descending");
  const [pendingAction, setPendingAction] = useState<PendingProcessAction | null>(null);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProcess = useMemo(
    () =>
      snapshot?.processes.find(
        (process) => processIdentity(process) === selectedIdentity,
      ) ?? null,
    [selectedIdentity, snapshot],
  );
  const selectionMissing = selectedIdentity !== null && !selectedProcess;
  const activeDetail = detailMatchesProcess(detail, selectedProcess) ? detail : null;

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
  }, [selectedProcess?.pid, selectedProcess?.startTime]);

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

  const selectProcess = useCallback((process: ProcessRow) => {
    setSelectedIdentity(processIdentity(process));
    setLastSelected(process);
    setPendingAction(null);
    setNotice(null);
  }, []);

  const beginProcessAction = useCallback(
    (action: ProcessAction) => {
      if (!selectedIdentity || !activeDetail?.key) return;
      setPendingAction({
        action,
        selectionIdentity: selectedIdentity,
        key: activeDetail.key,
        detail: activeDetail,
      });
    },
    [activeDetail, selectedIdentity],
  );

  const handleAction = async () => {
    if (!pendingAction) return;
    const currentKey = activeDetail?.key ?? null;
    if (
      selectedIdentity !== pendingAction.selectionIdentity ||
      !processKeysEqual(currentKey, pendingAction.key)
    ) {
      setNotice("目标进程身份已经变化，操作已取消。请重新选择并确认。");
      setPendingAction(null);
      return;
    }

    setSubmittingAction(true);
    try {
      const result = await executeProcessAction({
        key: pendingAction.key,
        action: pendingAction.action,
      });
      setNotice(result.message);
      setPendingAction(null);
      await refreshNow();
    } catch (caughtError) {
      const actionError = normalizeCommandError(caughtError);
      setNotice(actionError.message);
      setPendingAction(null);
    } finally {
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
          <button type="button" disabled title="即将推出"><Database size={17} />存储<small>稍后</small></button>
          <button type="button" disabled title="即将推出"><Network size={17} />网络<small>稍后</small></button>
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
            <span className="eyebrow">{activeView === "overview" ? "系统概览" : "进程诊断"}</span>
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

        <div className="content-layout">
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
                  query={query}
                  onQueryChange={setQuery}
                  sortKey={sortKey}
                  direction={sortDirection}
                  onSortChange={(key, direction) => { setSortKey(key); setSortDirection(direction); }}
                />
              </>
            ) : (
              <ProcessTable
                processes={snapshot.processes}
                selectedIdentity={selectedIdentity}
                onSelect={selectProcess}
                query={query}
                onQueryChange={setQuery}
                sortKey={sortKey}
                direction={sortDirection}
                onSortChange={(key, direction) => { setSortKey(key); setSortDirection(direction); }}
              />
            )}
          </main>

          <ProcessInspector
            selected={selectedProcess ?? (selectionMissing ? lastSelected : null)}
            selectionMissing={selectionMissing}
            detail={activeDetail}
            detailError={detailError}
            detailLoading={detailLoading}
            capabilities={snapshot.capabilities}
            onAction={beginProcessAction}
          />
        </div>

        <footer className="statusbar">
          <span><Gauge size={13} />采样间隔 {snapshot.sampleIntervalMs} ms</span>
          <span>{snapshot.processes.length} 个进程</span>
          <span>{snapshot.host.cpuName || snapshot.host.kernelVersion}</span>
          <span className="statusbar__sequence">#{snapshot.sequence}</span>
        </footer>
      </div>

      {pendingAction ? (
        <ConfirmActionDialog
          action={pendingAction.action}
          detail={pendingAction.detail}
          submitting={submittingAction}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => void handleAction()}
        />
      ) : null}
    </div>
  );
}

export default App;
