import { useAppTranslation } from "../i18n/useAppTranslation";
import type { CleanupDeleteMode, CleanupDeleteProgress } from "../types";
import { formatBytes } from "../utils";
import { CleanupActivityVisual } from "./CleanupActivityVisual";

export function CleanupProcessing({ progress, mode, cancelling, targetCount }: {
  progress: CleanupDeleteProgress | null;
  mode: CleanupDeleteMode;
  cancelling: boolean;
  targetCount: number;
}) {
  const { t } = useAppTranslation();
  const percent = progress && progress.totalEntryCount > 0
    ? Math.max(0, Math.min(100, progress.processedEntryCount / progress.totalEntryCount * 100))
    : null;
  const title = t(cancelling ? "cleanup:deleteDialog.progressCancelling"
    : progress?.phase === "moving_to_trash" ? "cleanup:deleteDialog.progressMovingToTrash"
    : progress?.phase === "deleting" ? "cleanup:deleteDialog.progressDeleting"
    : "cleanup:deleteDialog.progressPreparing");
  return (
    <div className={`cleanup-processing${cancelling ? " is-cancelling" : ""}`}>
      <CleanupActivityVisual state={cancelling ? "cancelling" : "working"} mode={mode} percent={percent} />
      <h3 role="status">{title}</h3>
      <div className="cleanup-processing__progress" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.round(percent)}>
        <span>{percent === null ? "—" : `${Math.round(percent)}%`}</span>
        <div className={percent === null ? "is-indeterminate" : undefined}><i style={percent === null ? undefined : { width: `${percent}%` }} /></div>
      </div>
      <p className="cleanup-processing__path" title={progress?.currentPath}>
        {progress?.currentPath || t("cleanup:deleteDialog.progressInspecting")}
      </p>
      <div className="cleanup-processing__stats">
        <span>{t("cleanup:deleteDialog.progressTargets", { completed: progress?.completedTargetCount ?? 0, total: progress?.totalTargetCount ?? targetCount })}</span>
        <span>{progress && progress.totalEntryCount > 0
          ? t("cleanup:deleteDialog.progressEntries", { processed: progress.processedEntryCount.toLocaleString(), total: progress.totalEntryCount.toLocaleString() })
          : t("cleanup:deleteDialog.progressInspecting")}</span>
      </div>
      <small className="cleanup-processing__processed">{t("cleanup:settlement.processed", { size: formatBytes(progress?.deletedBytes ?? 0) })}</small>
      {cancelling ? <p className="cleanup-processing__cancel-hint">{t("cleanup:deleteDialog.cancelHint")}</p> : null}
    </div>
  );
}
