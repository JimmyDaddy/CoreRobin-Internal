import {
  Activity,
  AlertTriangle,
  CircleHelp,
  CircleDotDashed,
  CircleStop,
  Clock3,
  FileTerminal,
  GitFork,
  LoaderCircle,
  OctagonX,
  RotateCw,
  ShieldCheck,
  UserRound,
  XCircle,
} from "lucide-react";
import { useAppTranslation } from "../i18n/useAppTranslation";

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
import { PathActions } from "./PathActions";
import { Button } from "./Button";
import { ApplicationAvatar } from "./ApplicationAvatar";
import "./ProcessInspector.css";

interface ProcessInspectorProps {
  selected: ProcessRow | null;
  selectionMissing: boolean;
  detail: ProcessDetail | null;
  detailError: CommandError | null;
  detailLoading: boolean;
  history: SelectedProcessHistory | null;
  capabilities: Capabilities;
  preparingAction: boolean;
  onAction: (action: ProcessAction) => void;
  onRestart: () => void;
  onRetryDetail: () => void;
}

export function ProcessInspector({
  selected,
  selectionMissing,
  detail,
  detailError,
  detailLoading,
  history,
  capabilities,
  preparingAction,
  onAction,
  onRestart,
  onRetryDetail,
}: ProcessInspectorProps) {
  const { t } = useAppTranslation();
  if (selectionMissing) {
    return (
      <aside className="inspector panel">
        <div className="inspector-exit" role="status">
          <XCircle size={24} />
          <span>
            <strong>{t("process:inspector.exited")}</strong>
            <small>{t("process:inspector.exitedDetail")}</small>
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
          <strong>{t("process:inspector.choose")}</strong>
          <span>{t("process:inspector.chooseDetail")}</span>
        </div>
      </aside>
    );
  }

  const backgroundProtection = selected.backgroundState === "managed"
    || selected.backgroundState === "zombie"
    ? t(`process:background.state.${selected.backgroundState}`)
    : null;
  const protectedReason = backgroundProtection
    ?? detail?.protectedReason
    ?? detail?.identityError;
  const canTerminate = Boolean(detail?.canTerminate && detail.key !== null);
  const displayName = detail?.name ?? selected.name;
  const displayUser = detail?.user ?? selected.user;
  const control = capabilities.processControl;
  const requestCloseEnabled =
    canTerminate && control.requestClose.enabled;
  const forceKillEnabled =
    canTerminate && control.forceKill.enabled;
  const actionGuidance = protectedReason
    ? protectedReason
    : control.targeting === "stable_handle"
      ? t("process:inspector.stableHandle")
      : control.targeting === "unavailable"
        ? control.forceKill.disabledReason ??
          control.requestClose.disabledReason ??
          t("process:inspector.unavailableControl")
        : t("process:inspector.bestEffort");
  const ActionGuidanceIcon = protectedReason || control.targeting === "stable_handle"
    ? ShieldCheck
    : control.targeting === "unavailable" || control.targeting === "best_effort_pid"
      ? AlertTriangle
      : CircleHelp;

  return (
    <aside className="inspector panel">
      <header className="inspector-header">
        <ApplicationAvatar
          name={displayName}
          source={{
            process: {
              pid: selected.pid,
              snapshotStartTime: selected.startTime,
              snapshotBirthToken: selected.birthToken,
            },
          }}
          className="process-avatar"
        />
        <div className="inspector-title">
          <h2 title={displayName}>{displayName || t("common:unnamedProcess")}</h2>
          <span>PID {selected.pid} · {displayUser ?? t("common:unknownUser")}</span>
        </div>
        {selected.protected ? (
          <span className="safe-badge"><ShieldCheck size={13} />{t("process:protected")}</span>
        ) : null}
      </header>

      <div className="inspector-metrics">
        <div>
          <span>CPU</span>
          <strong className={`resource-usage resource-usage--${resourceUsageLevel(selected.cpuPercent, [10, 50, 100])}`}>{formatPercent(selected.cpuPercent)}</strong>
        </div>
        <div>
          <span>{t("process:inspector.residentMemory")}</span>
          <strong>{formatBytes(selected.memoryBytes)}</strong>
        </div>
      </div>

      {selected.cpuPercent !== null && selected.cpuPercent >= 100 ? (
        <div className="evidence-callout">
          <Activity size={15} />
          <span>{t("process:inspector.multiCore")}</span>
        </div>
      ) : null}

      <ProcessHistory history={history} />

      {detailLoading ? (
        <div className="detail-loading" role="status"><LoaderCircle className="is-spinning" size={17} />{t("process:inspector.verifying")}</div>
      ) : null}
      {detailError ? (
        <div className="detail-error" role="alert">
          <AlertTriangle size={16} />
          <span>{detailError.message}</span>
          <button type="button" disabled={detailLoading} onClick={onRetryDetail}>
            <RotateCw className={detailLoading ? "is-spinning" : undefined} size={14} />
            {t("common:retry")}
          </button>
        </div>
      ) : null}

      {detail ? (
        <div className="detail-list">
          <div>
            <FileTerminal size={15} />
            <span><small>{t("process:inspector.executable")}</small><code>{detail.executable ?? t("common:unavailable")}</code></span>
          </div>
          <div>
            <GitFork size={15} />
            <span><small>{t("process:inspector.parent")}</small><strong>{detail.parentPid ?? t("common:none")}</strong></span>
          </div>
          <div>
            <UserRound size={15} />
            <span><small>{t("process:inspector.userStatus")}</small><strong>{detail.user ?? t("common:unknown")} · {statusLabel(detail.status)}</strong></span>
          </div>
          <div>
            <Clock3 size={15} />
            <span><small>{t("process:inspector.runtime")}</small><strong>{formatDuration(detail.runTimeSeconds)}</strong></span>
          </div>
          {selected.backgroundState ? (
            <div>
              <CircleDotDashed size={15} />
              <span>
                <small>{t("process:background.detail.source")}</small>
                <strong>
                  {t(`process:background.state.${selected.backgroundState}`)}
                  {selected.backgroundPreviousParentPid
                    ? ` · ${t("process:background.detail.previousParent")} PID ${selected.backgroundPreviousParentPid}`
                    : ""}
                </strong>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {detail?.commandLine ? (
        <div className="command-preview">
          <span>{t("process:inspector.launchCommand")}</span>
          <code>{detail.commandLine}</code>
        </div>
      ) : null}

      {detail?.executable ? (
        <PathActions className="inspector-path-actions" path={detail.executable} />
      ) : null}

      <div className="inspector-actions">
        <button
          className="process-action-guidance"
          type="button"
          aria-label={actionGuidance}
          data-tooltip={actionGuidance}
        >
          <ActionGuidanceIcon size={15} />
        </button>
        <Button
          variant="secondary"
          className="process-action-button"
          disabled={!requestCloseEnabled || preparingAction || !detail?.executable}
          aria-label={t("process:inspector.restart")}
          title={t("process:inspector.restart")}
          data-tooltip={t("process:inspector.restart")}
          onClick={onRestart}
        >
          {preparingAction
            ? <LoaderCircle className="is-spinning" size={16} />
            : <RotateCw size={16} />}
        </Button>
        <button
          type="button"
          className="button button--secondary process-action-button"
          disabled={!requestCloseEnabled || preparingAction}
          aria-label={t("process:inspector.requestClose")}
          title={control.requestClose.disabledReason ?? t("process:inspector.requestClose")}
          data-tooltip={control.requestClose.disabledReason ?? t("process:inspector.requestClose")}
          onClick={() => onAction("request_close")}
        >
          {preparingAction
            ? <LoaderCircle className="is-spinning" size={16} />
            : <CircleStop size={16} />}
        </button>
        <button
          type="button"
          className="button button--danger-ghost process-action-button"
          disabled={!forceKillEnabled || preparingAction}
          aria-label={t("process:inspector.forceKill")}
          title={control.forceKill.disabledReason ?? t("process:inspector.forceKill")}
          data-tooltip={control.forceKill.disabledReason ?? t("process:inspector.forceKill")}
          onClick={() => onAction("force_kill")}
        >
          <OctagonX size={16} />
        </button>
      </div>
    </aside>
  );
}
