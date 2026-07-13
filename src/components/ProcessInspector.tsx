import {
  Activity,
  AlertTriangle,
  Clock3,
  FileTerminal,
  GitFork,
  LoaderCircle,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";

import type {
  Capabilities,
  CommandError,
  ProcessAction,
  ProcessDetail,
  ProcessRow,
} from "../types";
import { formatBytes, formatDuration, formatPercent, statusLabel } from "../utils";

interface ProcessInspectorProps {
  selected: ProcessRow | null;
  selectionMissing: boolean;
  detail: ProcessDetail | null;
  detailError: CommandError | null;
  detailLoading: boolean;
  capabilities: Capabilities;
  bestEffortOptIn: boolean;
  preparingAction: boolean;
  onBestEffortOptInChange: (enabled: boolean) => void;
  onAction: (action: ProcessAction) => void;
}

export function ProcessInspector({
  selected,
  selectionMissing,
  detail,
  detailError,
  detailLoading,
  capabilities,
  bestEffortOptIn,
  preparingAction,
  onBestEffortOptInChange,
  onAction,
}: ProcessInspectorProps) {
  if (selectionMissing) {
    return (
      <aside className="inspector panel">
        <div className="inspector-empty">
          <XCircle size={24} />
          <strong>进程已经退出</strong>
          <span>旧选择不会自动绑定到复用该 PID 的新进程。</span>
        </div>
      </aside>
    );
  }

  if (!selected) {
    return (
      <aside className="inspector panel">
        <div className="inspector-empty">
          <Activity size={24} />
          <strong>选择一个进程</strong>
          <span>查看资源证据、父进程和安全操作。</span>
        </div>
      </aside>
    );
  }

  const protectedReason = detail?.protectedReason ?? detail?.identityError;
  const canTerminate = Boolean(detail?.canTerminate && detail.key !== null);
  const displayName = detail?.name ?? selected.name;
  const displayUser = detail?.user ?? selected.user;
  const control = capabilities.processControl;
  const bestEffort = control.targeting === "best_effort_pid";
  const targetingAllowed = !bestEffort || bestEffortOptIn;
  const requestCloseEnabled =
    canTerminate && targetingAllowed && control.requestClose.enabled;
  const forceKillEnabled =
    canTerminate && targetingAllowed && control.forceKill.enabled;

  return (
    <aside className="inspector panel" aria-live="polite">
      <header className="inspector-header">
        <div className="process-avatar" aria-hidden="true">
          {displayName.slice(0, 1).toUpperCase() || "?"}
        </div>
        <div className="inspector-title">
          <h2 title={displayName}>{displayName || "未命名进程"}</h2>
          <span>PID {selected.pid} · {displayUser ?? "未知用户"}</span>
        </div>
        {selected.protected ? (
          <span className="safe-badge"><ShieldCheck size={13} />受保护</span>
        ) : null}
      </header>

      <div className="inspector-metrics">
        <div>
          <span>CPU</span>
          <strong>{formatPercent(selected.cpuPercent)}</strong>
        </div>
        <div>
          <span>常驻内存</span>
          <strong>{formatBytes(selected.memoryBytes)}</strong>
        </div>
      </div>

      {selected.cpuPercent !== null && selected.cpuPercent >= 100 ? (
        <div className="evidence-callout">
          <Activity size={15} />
          <span>该进程当前使用超过一个逻辑核心；进程 CPU 按单核 100% 计量。</span>
        </div>
      ) : null}

      {detailLoading ? (
        <div className="detail-loading"><LoaderCircle className="spin" size={17} />正在核验进程身份…</div>
      ) : null}
      {detailError ? (
        <div className="detail-error"><AlertTriangle size={16} />{detailError.message}</div>
      ) : null}

      {detail ? (
        <div className="detail-list">
          <div>
            <FileTerminal size={15} />
            <span><small>可执行文件</small><code>{detail.executable ?? "不可用"}</code></span>
          </div>
          <div>
            <GitFork size={15} />
            <span><small>父进程</small><strong>{detail.parentPid ?? "无"}</strong></span>
          </div>
          <div>
            <UserRound size={15} />
            <span><small>用户 / 状态</small><strong>{detail.user ?? "未知"} · {statusLabel(detail.status)}</strong></span>
          </div>
          <div>
            <Clock3 size={15} />
            <span><small>已运行</small><strong>{formatDuration(detail.runTimeSeconds)}</strong></span>
          </div>
        </div>
      ) : null}

      {detail?.commandLine ? (
        <div className="command-preview">
          <span>启动命令</span>
          <code>{detail.commandLine}</code>
        </div>
      ) : null}

      <div className="inspector-actions">
        {protectedReason ? (
          <p className="action-guard"><ShieldCheck size={14} />{protectedReason}</p>
        ) : control.targeting === "stable_handle" ? (
          <p className="action-guard"><ShieldCheck size={14} />确认后会绑定短期、单次使用的稳定系统句柄；执行时不会重新按 PID 查找目标。</p>
        ) : control.targeting === "unavailable" ? (
          <p className="action-guard"><AlertTriangle size={14} />{control.forceKill.disabledReason ?? control.requestClose.disabledReason ?? "此平台暂不支持安全的进程控制。"}</p>
        ) : (
          <div className="best-effort-guard">
            <p><AlertTriangle size={14} /><span>macOS 无法为任意进程提供可发信号的稳定句柄。Pulse 会在发信号前再次核验启动标识，但仍属于 best-effort PID 定位。</span></p>
            <label>
              <input
                type="checkbox"
                checked={bestEffortOptIn}
                onChange={(event) => onBestEffortOptInChange(event.target.checked)}
              />
              本次运行中允许 best-effort 进程操作
            </label>
          </div>
        )}
        <button
          type="button"
          className="button button--secondary"
          disabled={!requestCloseEnabled || preparingAction}
          title={control.requestClose.disabledReason ?? undefined}
          onClick={() => onAction("request_close")}
        >
          {preparingAction ? "正在绑定…" : "请求结束"}
        </button>
        <button
          type="button"
          className="button button--danger-ghost"
          disabled={!forceKillEnabled || preparingAction}
          title={control.forceKill.disabledReason ?? undefined}
          onClick={() => onAction("force_kill")}
        >
          强制结束…
        </button>
      </div>
    </aside>
  );
}
