import { AlertOctagon, AlertTriangle, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import type {
  ProcessAction,
  ProcessActionSemantic,
  ProcessControlTargeting,
  ProcessDetail,
} from "../types";

interface ConfirmActionDialogProps {
  action: ProcessAction;
  source: "process" | "diagnosis" | "restart";
  displayName: string;
  detail: ProcessDetail;
  targeting: ProcessControlTargeting;
  semantic: ProcessActionSemantic | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmActionDialog({
  action,
  source,
  displayName,
  detail,
  targeting,
  semantic,
  submitting,
  onCancel,
  onConfirm,
}: ConfirmActionDialogProps) {
  const { t, i18n } = useAppTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const force = action === "force_kill";
  const diagnosisAction = source === "diagnosis";
  const restartAction = source === "restart";
  const guidedAction = diagnosisAction || restartAction;
  const actionDescription = force
    ? semantic === "terminate_process"
      ? t("process:dialog.windowsForce")
      : t("process:dialog.unixForce")
    : t("process:dialog.request");

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
            <h2 id="confirm-title">
              {restartAction
                ? t("diagnosis:actionDialog.restartTitle", { name: displayName })
                : diagnosisAction
                ? t("diagnosis:actionDialog.title", { name: displayName })
                : force
                  ? t("process:dialog.forceTitle")
                  : t("process:dialog.requestTitle")}
            </h2>
            <p>{restartAction
              ? t("diagnosis:actionDialog.restartDescription")
              : diagnosisAction
                ? t("diagnosis:actionDialog.description")
                : actionDescription}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common:cancel")} disabled={submitting} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        {guidedAction ? (
          <div className="diagnosis-action-summary">
            <p><ShieldCheck size={15} /><span><strong>{t("diagnosis:actionDialog.safeTitle")}</strong>{t("diagnosis:actionDialog.safeDescription")}</span></p>
            <p className="is-warning"><AlertTriangle size={15} /><span><strong>{t("diagnosis:actionDialog.riskTitle")}</strong>{t("diagnosis:actionDialog.riskDescription")}</span></p>
          </div>
        ) : (
          <dl className="confirm-target">
            <div><dt>{t("process:columns.process")}</dt><dd>{detail.name}</dd></div>
            <div><dt>PID</dt><dd>{detail.pid}</dd></div>
            <div><dt>{t("process:dialog.user")}</dt><dd>{detail.user ?? t("common:unknown")}</dd></div>
            <div><dt>{t("process:dialog.startedAt")}</dt><dd>{new Date(detail.startTime * 1_000).toLocaleString(i18n.resolvedLanguage)}</dd></div>
          </dl>
        )}

        <p className={`identity-note${targeting === "best_effort_pid" ? " identity-note--warning" : ""}`}>
          {guidedAction
            ? targeting === "stable_handle"
              ? t("diagnosis:actionDialog.stableIdentity")
              : t("diagnosis:actionDialog.bestEffortIdentity")
            : targeting === "stable_handle"
              ? t("process:dialog.stableIdentity")
              : t("process:dialog.bestEffortIdentity")}
        </p>
        <footer>
          <button ref={cancelButton} type="button" className="button button--secondary" disabled={submitting} onClick={onCancel}>{t("common:cancel")}</button>
          <button
            type="button"
            className={`button ${force ? "button--danger" : "button--primary"}`}
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting
              ? t("process:dialog.validating")
              : restartAction
                ? t("diagnosis:actionDialog.confirmRestart", { name: displayName })
                : diagnosisAction
                ? t("diagnosis:actionDialog.confirm", { name: displayName })
                : force
                  ? t("process:dialog.confirmForce")
                  : t("process:dialog.confirmRequest")}
          </button>
        </footer>
      </section>
    </div>
  );
}
