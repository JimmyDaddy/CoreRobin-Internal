import { LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { startupApplicationIconSource } from "../applicationIcon";

import type {
  CommandError,
  StartupItem,
  StartupManagementAction,
  StartupManagementLease,
} from "../types";
import { ApplicationAvatar } from "./ApplicationAvatar";

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
          <ApplicationAvatar
            name={item.name}
            source={startupApplicationIconSource(item)}
            className="dialog-icon startup-action-avatar"
          />
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

        <p className="startup-action-summary">
          <ShieldCheck size={15} />
          <span>
            {t(
              disabling
                ? "startup:actionDialog.runningDescription"
                : "startup:actionDialog.enable.whenDescription",
            )}
          </span>
        </p>

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
            {submitting ? (
              <>
                <LoaderCircle className="is-spinning" size={14} />
                {t("startup:actionDialog.applying")}
              </>
            ) : t(`startup:actionDialog.${action}.confirm`, { name: item.name })}
          </button>
        </footer>
      </section>
    </div>
  );
}
