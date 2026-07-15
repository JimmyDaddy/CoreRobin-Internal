import { Clock3, LoaderCircle, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import type {
  CommandError,
  StartupItem,
  StartupManagementAction,
  StartupManagementLease,
} from "../types";

interface StartupActionDialogProps {
  item: StartupItem;
  action: StartupManagementAction;
  lease: StartupManagementLease | null;
  preparing: boolean;
  submitting: boolean;
  error: CommandError | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function StartupActionDialog({
  item,
  action,
  lease,
  preparing,
  submitting,
  error,
  onCancel,
  onConfirm,
}: StartupActionDialogProps) {
  const { t } = useAppTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const disabling = action === "disable";

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
        className="confirm-dialog startup-action-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="startup-action-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="dialog-icon"><RotateCcw size={20} /></span>
          <div>
            <h2 id="startup-action-title">
              {t(`startup:actionDialog.${action}.title`, { name: item.name })}
            </h2>
            <p>{t(`startup:actionDialog.${action}.description`)}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common:cancel")} disabled={submitting} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        <div className="startup-action-summary">
          <p><ShieldCheck size={15} /><span><strong>{t("startup:actionDialog.reversibleTitle")}</strong>{t("startup:actionDialog.reversibleDescription")}</span></p>
          <p><Clock3 size={15} /><span><strong>{t("startup:actionDialog.whenTitle")}</strong>{t(`startup:actionDialog.${action}.whenDescription`)}</span></p>
          {disabling ? <p className="is-warning"><Clock3 size={15} /><span><strong>{t("startup:actionDialog.runningTitle")}</strong>{t("startup:actionDialog.runningDescription")}</span></p> : null}
        </div>

        {preparing ? (
          <p className="startup-action-dialog__status" role="status"><LoaderCircle className="is-spinning" size={14} />{t("startup:actionDialog.preparing")}</p>
        ) : null}
        {error ? (
          <p className="startup-action-dialog__error" role="alert">
            {t(`startup:actionDialog.errors.${error.code}`, { defaultValue: error.message })}
          </p>
        ) : null}

        <footer>
          <button ref={cancelButton} type="button" className="button button--secondary" disabled={submitting} onClick={onCancel}>{t("common:cancel")}</button>
          <button type="button" className="button button--primary" disabled={!lease || preparing || submitting || Boolean(error)} onClick={onConfirm}>
            {submitting ? t("startup:actionDialog.applying") : t(`startup:actionDialog.${action}.confirm`, { name: item.name })}
          </button>
        </footer>
      </section>
    </div>
  );
}
