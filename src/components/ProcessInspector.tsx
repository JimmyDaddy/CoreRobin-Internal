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
  onAction: (action: ProcessAction) => void;
}

export function ProcessInspector({
  selected,
  selectionMissing,
  detail,
  detailError,
  detailLoading,
  capabilities,
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
  const canTerminate = detail?.canTerminate && detail.key !== null;

  return (
    <aside className="inspector panel" aria-live="polite">
      <header className="inspector-header">
        <div className="process-avatar" aria-hidden="true">
          {selected.name.slice(0, 1).toUpperCase() || "?"}
        </div>
        <div className="inspector-title">
          <h2 title={selected.name}>{selected.name || "未命名进程"}</h2>
          <span>PID {selected.pid} · {selected.user ?? "未知用户"}</span>
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
        ) : (
          <p className="action-guard">操作前会重新读取高精度启动标识，防止 PID 复用误杀。</p>
        )}
        <button
          type="button"
          className="button button--secondary"
          disabled={!canTerminate || !capabilities.requestClose}
          onClick={() => onAction("request_close")}
        >
          请求结束
        </button>
        <button
          type="button"
          className="button button--danger-ghost"
          disabled={!canTerminate || !capabilities.forceKill}
          onClick={() => onAction("force_kill")}
        >
          强制结束…
        </button>
      </div>
    </aside>
  );
}
