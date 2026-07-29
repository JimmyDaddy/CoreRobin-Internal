import { AlertTriangle, AppWindow, ArchiveRestore, CircleStop, LoaderCircle, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import type { CleanupMapNode } from "../cleanupMap";
import { cleanupLeaseCanExecute } from "../cleanupDeleteFreshness";
import type { CleanupDeleteLease, CleanupDeleteMode, CleanupDeleteProgress, CommandError } from "../types";
import { formatBytes } from "../utils";

interface CleanupDeleteDialogProps {
  title?: string;
  description?: string;
  items: readonly CleanupMapNode[];
  lease: CleanupDeleteLease | null;
  preparing: boolean;
  modeSwitching: boolean;
  submitting: boolean;
  cancelling: boolean;
  progress: CleanupDeleteProgress | null;
  error: CommandError | null;
  mode: CleanupDeleteMode;
  deleteAcknowledged: boolean;
  progressVariant?: "default" | "application";
  onModeChange: (mode: CleanupDeleteMode) => void;
  onDeleteAcknowledgedChange: (checked: boolean) => void;
  onCancel: () => void;
  onCancelExecution: () => void;
  onRefresh: () => void;
  onConfirm: () => void;
}

export function CleanupDeleteDialog({
  title,
  description,
  items,
  lease,
  preparing,
  modeSwitching,
  submitting,
  cancelling,
  progress,
  error,
  mode,
  deleteAcknowledged,
  progressVariant = "default",
  onModeChange,
  onDeleteAcknowledgedChange,
  onCancel,
  onCancelExecution,
  onRefresh,
  onConfirm,
}: CleanupDeleteDialogProps) {
  const { t } = useAppTranslation();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const totalBytes = items.reduce((total, item) => total + item.sizeBytes, 0);
  const changedPaths = new Set(lease?.changedPaths ?? []);
  const canConfirm =
    cleanupLeaseCanExecute(lease) &&
    lease?.mode === mode &&
    !preparing &&
    !modeSwitching &&
    !submitting &&
    (mode === "trash" || deleteAcknowledged);
  const currentItem = progress?.currentPath
    ? items.find((item) => item.path === progress.currentPath)
    : null;
  const progressPercent = progress && progress.totalEntryCount > 0
    ? Math.min(100, (progress.processedEntryCount / progress.totalEntryCount) * 100)
    : null;

  useEffect(() => {
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (submitting) {
        if (!cancelling) onCancelExecution();
      } else {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelling, onCancel, onCancelExecution, submitting]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={submitting ? undefined : onCancel}>
      <section
        className={`cleanup-delete-dialog is-${mode}`}
        role="alertdialog"
        aria-modal="true"
        aria-busy={preparing || modeSwitching || submitting}
        aria-labelledby="cleanup-delete-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className={`cleanup-delete-dialog__icon is-${mode}${submitting ? " is-active" : ""}`}>
            {mode === "trash" ? <ArchiveRestore size={20} /> : <ShieldAlert size={20} />}
          </span>
          <div>
            <h2 id="cleanup-delete-title">{title ?? t("cleanup:deleteDialog.title")}</h2>
            <p>{description ?? t("cleanup:deleteDialog.description")}</p>
          </div>
          <button className="icon-button" type="button" aria-label={t("common:cancel")} disabled={submitting} onClick={onCancel}>
            <X size={17} />
          </button>
        </header>

        {!submitting ? (
          <fieldset className="cleanup-delete-dialog__modes">
            <legend>{t("cleanup:deleteDialog.modeTitle")}</legend>
            <button
              className={mode === "trash" ? "is-selected" : undefined}
              type="button"
              role="radio"
              aria-checked={mode === "trash"}
              disabled={preparing || modeSwitching}
              onClick={() => onModeChange("trash")}
            >
              <span><ArchiveRestore size={17} /></span>
              <div><strong>{t("cleanup:deleteDialog.trashModeTitle")}</strong><small>{t("cleanup:deleteDialog.trashModeDescription")}</small></div>
              <em>{t("cleanup:deleteDialog.recommended")}</em>
            </button>
            <button
              className={mode === "permanent" ? "is-selected is-danger" : "is-danger"}
              type="button"
              role="radio"
              aria-checked={mode === "permanent"}
              disabled={preparing || modeSwitching}
              onClick={() => onModeChange("permanent")}
            >
              <span><Trash2 size={17} /></span>
              <div><strong>{t("cleanup:deleteDialog.permanentModeTitle")}</strong><small>{t("cleanup:deleteDialog.permanentModeDescription")}</small></div>
            </button>
          </fieldset>
        ) : null}

        <div className="cleanup-delete-dialog__summary">
          <span><strong>{items.length}</strong>{t("cleanup:deleteDialog.itemUnit")}</span>
          <span><strong>{formatBytes(totalBytes)}</strong>{t("cleanup:deleteDialog.estimatedSize")}</span>
          <small className={mode === "trash" ? "is-recoverable" : undefined}>
            {mode === "trash" ? <ArchiveRestore size={13} /> : <AlertTriangle size={13} />}
            {t(mode === "trash" ? "cleanup:deleteDialog.recoverable" : "cleanup:deleteDialog.irreversible")}
          </small>
        </div>

        <ol className="cleanup-delete-dialog__items">
          {items.map((item) => (
            <li key={item.id} className={submitting && currentItem?.id === item.id ? "is-current" : undefined}>
              <span className={`is-${item.safety}`}><i />{t(`cleanup:safety.${item.safety}`)}</span>
              <div>
                <strong>{item.name}</strong>
                <code title={item.path ?? item.name}>{item.path}</code>
              </div>
              <b>{formatBytes(item.sizeBytes)}</b>
              {item.path && changedPaths.has(item.path) ? (
                <small><AlertTriangle size={12} />{t("cleanup:deleteDialog.changed")}</small>
              ) : null}
            </li>
          ))}
        </ol>

        {submitting ? (
          <div className={`cleanup-delete-dialog__progress${progressVariant === "application" ? " is-application" : ""}${cancelling ? " is-cancelling" : ""}`} role="status" aria-live="polite">
            {progressVariant === "application" && !cancelling ? (
              <span className={`cleanup-delete-dialog__app-progress-mark is-${mode}`} aria-hidden="true">
                <span className="cleanup-delete-dialog__app-progress-origin"><AppWindow size={18} /></span>
                <span className="cleanup-delete-dialog__app-progress-trail"><i /><i /><i /></span>
                <span className="cleanup-delete-dialog__app-progress-target">
                  {mode === "trash" ? <ArchiveRestore size={20} /> : <Trash2 size={20} />}
                </span>
              </span>
            ) : (
              <span className="cleanup-delete-dialog__progress-mark" aria-hidden="true">
                <i /><i /><i />
                {cancelling ? <CircleStop size={18} /> : mode === "trash" ? <ArchiveRestore size={17} /> : <Trash2 size={17} />}
              </span>
            )}
            <div className="cleanup-delete-dialog__progress-copy">
              <strong>{t(
                cancelling
                  ? "cleanup:deleteDialog.progressCancelling"
                  : progress?.phase === "moving_to_trash"
                    ? "cleanup:deleteDialog.progressMovingToTrash"
                    : progress?.phase === "deleting"
                    ? "cleanup:deleteDialog.progressDeleting"
                    : "cleanup:deleteDialog.progressPreparing",
              )}</strong>
              <span>{t("cleanup:deleteDialog.progressCurrent", {
                name: currentItem?.name ?? progress?.currentPath ?? t("cleanup:deleteDialog.selection"),
              })}</span>
            </div>
            <div
              className={`cleanup-delete-dialog__progress-track${progressPercent === null ? " is-indeterminate" : ""}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent === null ? undefined : Math.round(progressPercent)}
            >
              <i style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} />
            </div>
            <div className="cleanup-delete-dialog__progress-stats">
              <span>{progress && progress.totalEntryCount > 0
                ? t("cleanup:deleteDialog.progressEntries", {
                    processed: progress.processedEntryCount.toLocaleString(),
                    total: progress.totalEntryCount.toLocaleString(),
                  })
                : t("cleanup:deleteDialog.progressInspecting")}</span>
              <span>{t("cleanup:deleteDialog.progressTargets", {
                completed: progress?.completedTargetCount ?? 0,
                total: progress?.totalTargetCount ?? items.length,
              })}</span>
              <span>{t(mode === "trash" ? "cleanup:deleteDialog.progressMoved" : "cleanup:deleteDialog.progressDeleted", { size: formatBytes(progress?.deletedBytes ?? 0) })}</span>
            </div>
            {cancelling ? <small>{t("cleanup:deleteDialog.cancelHint")}</small> : null}
          </div>
        ) : null}

        {preparing && !submitting ? (
          <div className="cleanup-delete-dialog__preparing" role="status">
            <LoaderCircle className="is-spinning" size={15} />
            {t("cleanup:deleteDialog.preparing")}
          </div>
        ) : null}

        {lease && lease.changedPaths.length > 0 && !submitting ? (
          <p className="cleanup-delete-dialog__warning">
            <AlertTriangle size={14} />
            {t("cleanup:deleteDialog.changedWarning", { count: lease.changedPaths.length })}
          </p>
        ) : null}

        {!submitting && mode === "permanent" ? <label className="cleanup-delete-dialog__acknowledgement">
          <input
            type="checkbox"
            checked={deleteAcknowledged}
            disabled={submitting || preparing || modeSwitching || lease?.mode !== mode || lease?.executable !== true || lease.changedPaths.length > 0}
            onChange={(event) => onDeleteAcknowledgedChange(event.target.checked)}
          />
          <span>
            <strong>{t("cleanup:deleteDialog.deleteConfirmTitle")}</strong>
            <small>{t("cleanup:deleteDialog.deleteConfirmDescription")}</small>
          </span>
        </label> : null}

        {error ? (
          <p className="cleanup-delete-dialog__error" role="alert">
            {t(`cleanup:deleteDialog.errors.${error.code}`, { defaultValue: error.message })}
          </p>
        ) : null}

        <footer>
          {submitting ? (
            <button ref={cancelButton} className="button button--danger cleanup-delete-dialog__stop" type="button" disabled={cancelling} onClick={onCancelExecution}>
              {cancelling ? <LoaderCircle className="is-spinning" size={15} /> : <CircleStop size={15} />}
              {cancelling ? t("cleanup:deleteDialog.cancelling") : t("cleanup:deleteDialog.cancelDelete")}
            </button>
          ) : (
            <>
              <button ref={cancelButton} className="button button--secondary" type="button" onClick={onCancel}>
                {t("common:cancel")}
              </button>
              {lease && !lease.executable ? (
                <button className="button button--primary" type="button" disabled={preparing} onClick={onRefresh}>
                  <RefreshCw className={preparing ? "is-spinning" : undefined} size={14} />
                  {t("cleanup:deleteDialog.recheckSelection")}
                </button>
              ) : (
                <button className={`button ${mode === "trash" ? "button--primary" : "button--danger"}`} type="button" disabled={!canConfirm} onClick={onConfirm}>
                  {t(mode === "trash" ? "cleanup:deleteDialog.confirmTrash" : "cleanup:deleteDialog.confirm", { count: items.length })}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
