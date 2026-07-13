import { AlertOctagon, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type {
  ProcessAction,
  ProcessActionSemantic,
  ProcessControlTargeting,
  ProcessDetail,
} from "../types";

interface ConfirmActionDialogProps {
  action: ProcessAction;
  detail: ProcessDetail;
  targeting: ProcessControlTargeting;
  semantic: ProcessActionSemantic | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmActionDialog({
  action,
  detail,
  targeting,
  semantic,
  submitting,
  onCancel,
  onConfirm,
}: ConfirmActionDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const force = action === "force_kill";
  const actionDescription = force
    ? semantic === "terminate_process"
      ? "Windows 将通过已绑定的进程句柄执行 TerminateProcess；进程无法保存状态。"
      : "系统将向已核验目标发送 SIGKILL；进程无法保存状态，此操作不可撤销。"
    : "系统将向已核验目标发送 SIGTERM，让进程有机会清理并退出。";

  useEffect(() => {
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, submitting]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={submitting ? undefined : onCancel}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className={`dialog-icon${force ? " dialog-icon--danger" : ""}`}>
            {force ? <AlertOctagon size={20} /> : <ShieldCheck size={20} />}
          </span>
          <div>
            <h2 id="confirm-title">{force ? "强制结束进程？" : "请求进程结束？"}</h2>
            <p>{actionDescription}</p>
          </div>
          <button className="icon-button" type="button" aria-label="取消" disabled={submitting} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        <dl className="confirm-target">
          <div><dt>进程</dt><dd>{detail.name}</dd></div>
          <div><dt>PID</dt><dd>{detail.pid}</dd></div>
          <div><dt>用户</dt><dd>{detail.user ?? "未知"}</dd></div>
          <div><dt>启动时间</dt><dd>{new Date(detail.startTime * 1_000).toLocaleString()}</dd></div>
        </dl>

        <p className={`identity-note${targeting === "best_effort_pid" ? " identity-note--warning" : ""}`}>
          {targeting === "stable_handle"
            ? "本次确认已绑定短期、单次使用的稳定系统句柄；执行时不会重新按 PID 查找目标。"
            : "macOS 仅支持 best-effort PID 定位。执行前会再次校验高精度启动标识，但无法提供稳定句柄的同等级保证。"}
        </p>
        <footer>
          <button ref={cancelButton} type="button" className="button button--secondary" disabled={submitting} onClick={onCancel}>取消</button>
          <button
            type="button"
            className={`button ${force ? "button--danger" : "button--primary"}`}
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? "正在校验…" : force ? "确认强制结束" : "确认请求结束"}
          </button>
        </footer>
      </section>
    </div>
  );
}
