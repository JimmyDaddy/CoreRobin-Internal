import { AlertOctagon, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ProcessAction, ProcessDetail } from "../types";

interface ConfirmActionDialogProps {
  action: ProcessAction;
  detail: ProcessDetail;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmActionDialog({
  action,
  detail,
  submitting,
  onCancel,
  onConfirm,
}: ConfirmActionDialogProps) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const force = action === "force_kill";

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
            <p>{force ? "进程无法保存状态，此操作不可撤销。" : "系统会发送可清理退出的 TERM 请求。"}</p>
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

        <p className="identity-note">发送信号前会再次校验高精度启动标识；检测到身份变化时将拒绝，以降低 PID 复用导致的误操作风险。</p>
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
