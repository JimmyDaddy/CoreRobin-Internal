import { AlertTriangle, LoaderCircle, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CleanupMapNode } from "../cleanupMap";
import type { CleanupDeleteLease, CommandError } from "../types";
import { formatBytes } from "../utils";

interface CleanupDeleteDialogProps {
  items: readonly CleanupMapNode[];
  lease: CleanupDeleteLease | null;
  preparing: boolean;
  submitting: boolean;
  error: CommandError | null;
  deleteAcknowledged: boolean;
  onDeleteAcknowledgedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CleanupDeleteDialog({
  items,
  lease,
  preparing,
  submitting,
  error,
  deleteAcknowledged,
  onDeleteAcknowledgedChange,
  onCancel,
  onConfirm,
}: CleanupDeleteDialogProps) {
  const { t } = useTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const totalBytes = items.reduce((total, item) => total + item.sizeBytes, 0);
  const changedPaths = new Set(lease?.changedPaths ?? []);
  const canConfirm = lease !== null && !preparing && !submitting && deleteAcknowledged;

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
        className="cleanup-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cleanup-delete-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="cleanup-delete-dialog__icon"><Trash2 size={20} /></span>
          <div>
            <h2 id="cleanup-delete-title">{t("cleanup.deleteDialog.title")}</h2>
            <p>{t("cleanup.deleteDialog.description")}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.cancel")} disabled={submitting} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        <div className="cleanup-delete-dialog__summary">
          <span><strong>{items.length}</strong>{t("cleanup.deleteDialog.itemUnit")}</span>
          <span><strong>{formatBytes(totalBytes)}</strong>{t("cleanup.deleteDialog.estimatedSize")}</span>
          <small><AlertTriangle size={13} />{t("cleanup.deleteDialog.irreversible")}</small>
        </div>

        <ol className="cleanup-delete-dialog__items">
          {items.map((item) => (
            <li key={item.id}>
              <span className={`is-${item.safety}`}><i />{t(`cleanup.safety.${item.safety}`)}</span>
              <div>
                <strong>{item.name}</strong>
                <code title={item.path ?? item.name}>{item.path}</code>
              </div>
              <b>{formatBytes(item.sizeBytes)}</b>
              {item.path && changedPaths.has(item.path) ? (
                <small><AlertTriangle size={12} />{t("cleanup.deleteDialog.changed")}</small>
              ) : null}
            </li>
          ))}
        </ol>

        {preparing ? (
          <div className="cleanup-delete-dialog__preparing" role="status">
            <LoaderCircle className="is-spinning" size={15} />
            {t("cleanup.deleteDialog.preparing")}
          </div>
        ) : null}

        {lease && lease.changedPaths.length > 0 ? (
          <p className="cleanup-delete-dialog__warning">
            <AlertTriangle size={14} />
            {t("cleanup.deleteDialog.changedWarning", { count: lease.changedPaths.length })}
          </p>
        ) : null}

        <label className="cleanup-delete-dialog__acknowledgement">
          <input
            type="checkbox"
            checked={deleteAcknowledged}
            disabled={submitting}
            onChange={(event) => onDeleteAcknowledgedChange(event.target.checked)}
          />
          <span><strong>{t("cleanup.deleteDialog.deleteConfirmTitle")}</strong><small>{t("cleanup.deleteDialog.deleteConfirmDescription")}</small></span>
        </label>

        {error ? (
          <p className="cleanup-delete-dialog__error" role="alert">
            {t(`cleanup.deleteDialog.errors.${error.code}`, { defaultValue: error.message })}
          </p>
        ) : null}

        <footer>
          <button ref={cancelButton} className="button button--secondary" type="button" disabled={submitting} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="button button--danger" type="button" disabled={!canConfirm} onClick={onConfirm}>
            {submitting ? t("cleanup.deleteDialog.deleting") : t("cleanup.deleteDialog.confirm", { count: items.length })}
          </button>
        </footer>
      </section>
    </div>
  );
}
