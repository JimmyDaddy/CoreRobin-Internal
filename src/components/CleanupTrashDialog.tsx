import { AlertTriangle, LoaderCircle, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CleanupMapNode } from "../cleanupMap";
import type { CleanupTrashLease, CommandError } from "../types";
import { formatBytes } from "../utils";

interface CleanupTrashDialogProps {
  items: readonly CleanupMapNode[];
  lease: CleanupTrashLease | null;
  preparing: boolean;
  submitting: boolean;
  error: CommandError | null;
  reviewAcknowledged: boolean;
  onReviewAcknowledgedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CleanupTrashDialog({
  items,
  lease,
  preparing,
  submitting,
  error,
  reviewAcknowledged,
  onReviewAcknowledgedChange,
  onCancel,
  onConfirm,
}: CleanupTrashDialogProps) {
  const { t } = useTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const totalBytes = items.reduce((total, item) => total + item.sizeBytes, 0);
  const containsReviewItems = items.some((item) => item.safety === "review");
  const changedPaths = new Set(lease?.changedPaths ?? []);
  const canConfirm = lease !== null && !preparing && !submitting &&
    (!containsReviewItems || reviewAcknowledged);

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
        className="cleanup-trash-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cleanup-trash-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="cleanup-trash-dialog__icon"><Trash2 size={20} /></span>
          <div>
            <h2 id="cleanup-trash-title">{t("cleanup.trashDialog.title")}</h2>
            <p>{t("cleanup.trashDialog.description")}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common.cancel")} disabled={submitting} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        <div className="cleanup-trash-dialog__summary">
          <span><strong>{items.length}</strong>{t("cleanup.trashDialog.itemUnit")}</span>
          <span><strong>{formatBytes(totalBytes)}</strong>{t("cleanup.trashDialog.estimatedSize")}</span>
          <small><ShieldCheck size={13} />{t("cleanup.trashDialog.recoverable")}</small>
        </div>

        <ol className="cleanup-trash-dialog__items">
          {items.map((item) => (
            <li key={item.id}>
              <span className={`is-${item.safety}`}><i />{t(`cleanup.safety.${item.safety}`)}</span>
              <div>
                <strong>{item.name}</strong>
                <code title={item.path ?? item.name}>{item.path}</code>
              </div>
              <b>{formatBytes(item.sizeBytes)}</b>
              {item.path && changedPaths.has(item.path) ? (
                <small><AlertTriangle size={12} />{t("cleanup.trashDialog.changed")}</small>
              ) : null}
            </li>
          ))}
        </ol>

        {preparing ? (
          <div className="cleanup-trash-dialog__preparing" role="status">
            <LoaderCircle className="is-spinning" size={15} />
            {t("cleanup.trashDialog.preparing")}
          </div>
        ) : null}

        {lease && lease.changedPaths.length > 0 ? (
          <p className="cleanup-trash-dialog__warning">
            <AlertTriangle size={14} />
            {t("cleanup.trashDialog.changedWarning", { count: lease.changedPaths.length })}
          </p>
        ) : null}

        {containsReviewItems ? (
          <label className="cleanup-trash-dialog__acknowledgement">
            <input
              type="checkbox"
              checked={reviewAcknowledged}
              disabled={submitting}
              onChange={(event) => onReviewAcknowledgedChange(event.target.checked)}
            />
            <span><strong>{t("cleanup.trashDialog.reviewConfirmTitle")}</strong><small>{t("cleanup.trashDialog.reviewConfirmDescription")}</small></span>
          </label>
        ) : null}

        {error ? (
          <p className="cleanup-trash-dialog__error" role="alert">
            {t(`cleanup.trashDialog.errors.${error.code}`, { defaultValue: error.message })}
          </p>
        ) : null}

        <footer>
          <button ref={cancelButton} className="button button--secondary" type="button" disabled={submitting} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="button button--danger" type="button" disabled={!canConfirm} onClick={onConfirm}>
            {submitting ? t("cleanup.trashDialog.moving") : t("cleanup.trashDialog.confirm", { count: items.length })}
          </button>
        </footer>
      </section>
    </div>
  );
}
