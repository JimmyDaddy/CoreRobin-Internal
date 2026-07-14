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
import { useTranslation } from "react-i18next";

import type { SelectedProcessHistory } from "../processExplorer";
import type {
  Capabilities,
  CommandError,
  ProcessAction,
  ProcessDetail,
  ProcessRow,
} from "../types";
import {
  formatBytes,
  formatDuration,
  formatPercent,
  resourceUsageLevel,
  statusLabel,
} from "../utils";
import { ProcessHistory } from "./ProcessHistory";

interface ProcessInspectorProps {
  selected: ProcessRow | null;
  selectionMissing: boolean;
  detail: ProcessDetail | null;
  detailError: CommandError | null;
  detailLoading: boolean;
  history: SelectedProcessHistory | null;
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
  history,
  capabilities,
  bestEffortOptIn,
  preparingAction,
  onBestEffortOptInChange,
  onAction,
}: ProcessInspectorProps) {
  const { t } = useTranslation();
  if (selectionMissing) {
    return (
      <aside className="inspector panel">
        <div className="inspector-exit" role="status">
          <XCircle size={24} />
          <span>
            <strong>{t("process.inspector.exited")}</strong>
            <small>{t("process.inspector.exitedDetail")}</small>
          </span>
        </div>
        <ProcessHistory history={history} />
      </aside>
    );
  }

  if (!selected) {
    return (
      <aside className="inspector panel">
        <div className="inspector-empty">
          <Activity size={24} />
          <strong>{t("process.inspector.choose")}</strong>
          <span>{t("process.inspector.chooseDetail")}</span>
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
    <aside className="inspector panel">
      <header className="inspector-header">
        <div className="process-avatar" aria-hidden="true">
          {displayName.slice(0, 1).toUpperCase() || "?"}
        </div>
        <div className="inspector-title">
          <h2 title={displayName}>{displayName || t("common.unnamedProcess")}</h2>
          <span>PID {selected.pid} · {displayUser ?? t("common.unknownUser")}</span>
        </div>
        {selected.protected ? (
          <span className="safe-badge"><ShieldCheck size={13} />{t("process.protected")}</span>
        ) : null}
      </header>

      <div className="inspector-metrics">
        <div>
          <span>CPU</span>
          <strong className={`resource-usage resource-usage--${resourceUsageLevel(selected.cpuPercent, [10, 50, 100])}`}>{formatPercent(selected.cpuPercent)}</strong>
        </div>
        <div>
          <span>{t("process.inspector.residentMemory")}</span>
          <strong>{formatBytes(selected.memoryBytes)}</strong>
        </div>
      </div>

      {selected.cpuPercent !== null && selected.cpuPercent >= 100 ? (
        <div className="evidence-callout">
          <Activity size={15} />
          <span>{t("process.inspector.multiCore")}</span>
        </div>
      ) : null}

      <ProcessHistory history={history} />

      {detailLoading ? (
        <div className="detail-loading" role="status"><LoaderCircle className="spin" size={17} />{t("process.inspector.verifying")}</div>
      ) : null}
      {detailError ? (
        <div className="detail-error" role="alert"><AlertTriangle size={16} />{detailError.message}</div>
      ) : null}

      {detail ? (
        <div className="detail-list">
          <div>
            <FileTerminal size={15} />
            <span><small>{t("process.inspector.executable")}</small><code>{detail.executable ?? t("common.unavailable")}</code></span>
          </div>
          <div>
            <GitFork size={15} />
            <span><small>{t("process.inspector.parent")}</small><strong>{detail.parentPid ?? t("common.none")}</strong></span>
          </div>
          <div>
            <UserRound size={15} />
            <span><small>{t("process.inspector.userStatus")}</small><strong>{detail.user ?? t("common.unknown")} · {statusLabel(detail.status)}</strong></span>
          </div>
          <div>
            <Clock3 size={15} />
            <span><small>{t("process.inspector.runtime")}</small><strong>{formatDuration(detail.runTimeSeconds)}</strong></span>
          </div>
        </div>
      ) : null}

      {detail?.commandLine ? (
        <div className="command-preview">
          <span>{t("process.inspector.launchCommand")}</span>
          <code>{detail.commandLine}</code>
        </div>
      ) : null}

      <div className="inspector-actions">
        {protectedReason ? (
          <p className="action-guard"><ShieldCheck size={14} />{protectedReason}</p>
        ) : control.targeting === "stable_handle" ? (
          <p className="action-guard"><ShieldCheck size={14} />{t("process.inspector.stableHandle")}</p>
        ) : control.targeting === "unavailable" ? (
          <p className="action-guard"><AlertTriangle size={14} />{control.forceKill.disabledReason ?? control.requestClose.disabledReason ?? t("process.inspector.unavailableControl")}</p>
        ) : (
          <div className="best-effort-guard">
            <p><AlertTriangle size={14} /><span>{t("process.inspector.bestEffort")}</span></p>
            <label>
              <input
                type="checkbox"
                checked={bestEffortOptIn}
                onChange={(event) => onBestEffortOptInChange(event.target.checked)}
              />
              {t("process.inspector.allowBestEffort")}
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
          {preparingAction ? t("process.inspector.binding") : t("process.inspector.requestClose")}
        </button>
        <button
          type="button"
          className="button button--danger-ghost"
          disabled={!forceKillEnabled || preparingAction}
          title={control.forceKill.disabledReason ?? undefined}
          onClick={() => onAction("force_kill")}
        >
          {t("process.inspector.forceKill")}
        </button>
      </div>
    </aside>
  );
}
