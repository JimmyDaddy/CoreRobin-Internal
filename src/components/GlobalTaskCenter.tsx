import { AlertTriangle, CheckCircle2, CircleStop, ListChecks, LoaderCircle, RefreshCw, ScanSearch, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { AppUpdaterController } from "../hooks/useAppUpdater";
import type { FileInsightsScanController } from "../hooks/useFileInsightsScan";
import type { CleanupScanJobStatus, CleanupScanProgress, CommandError } from "../types";
import { useAppTranslation } from "../i18n/useAppTranslation";
import "./GlobalTaskCenter.css";

export function GlobalTaskCenter({
  cleanup,
  fileInsights,
  startup,
  updater,
  onOpenCleanup,
  onOpenStartup,
  onOpenUpdates,
}: {
  cleanup: {
    loading: boolean;
    cancelling: boolean;
    phase: string | null;
    progress: CleanupScanProgress | null;
    error: CommandError | null;
    cancel: () => Promise<void>;
    directoryRefreshStatus: CleanupScanJobStatus | null;
    cancelDirectoryRefresh: () => Promise<void>;
  };
  fileInsights: FileInsightsScanController;
  startup: { loading: boolean; error: CommandError | null; refresh: () => Promise<void> };
  updater: AppUpdaterController;
  onOpenCleanup: () => void;
  onOpenStartup: () => void;
  onOpenUpdates: () => void;
}) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const directoryActive = Boolean(cleanup.directoryRefreshStatus && ![
    "cancelled", "completed", "failed",
  ].includes(cleanup.directoryRefreshStatus.phase));
  const updateActive = updater.action === "installing" || updater.action === "ready"
    || updater.action === "installError" || updater.action === "restartError";
  const updateTitle = updater.action === "installing"
    ? t("app:tasks.update.installing")
    : updater.action === "ready"
      ? t("app:tasks.update.ready")
      : updater.action === "restartError"
        ? t("app:tasks.update.restartError")
        : t("app:tasks.update.installError");
  const taskCount = Number(cleanup.loading) + Number(directoryActive)
    + Number(fileInsights.loading) + Number(startup.loading) + Number(updateActive);
  const hasFailure = Boolean(cleanup.error || fileInsights.error || startup.error
    || updater.action === "installError" || updater.action === "restartError");
  const label = useMemo(() => taskCount > 0
    ? t("app:tasks.activeCount", { count: taskCount })
    : hasFailure
      ? t("app:tasks.needsAttention")
      : t("app:tasks.title"), [hasFailure, t, taskCount]);

  const openView = (callback: () => void) => {
    callback();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeWhenOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeWhenOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="global-task-center" ref={rootRef}>
      <button className={`icon-button global-task-center__trigger${taskCount > 0 ? " is-active" : ""}${hasFailure ? " is-warning" : ""}`} type="button" aria-label={label} aria-expanded={open} data-tooltip={label} onClick={() => setOpen((current) => !current)}>
        <ListChecks size={16} />
        {taskCount > 0 ? <b>{taskCount}</b> : hasFailure ? <i /> : null}
      </button>
      {open ? (
        <aside className="global-task-center__popover" aria-label={t("app:tasks.title")}>
          <header><div><small>{t("app:tasks.kicker")}</small><strong>{t("app:tasks.title")}</strong></div><button type="button" aria-label={t("common:close")} onClick={() => setOpen(false)}><X size={14} /></button></header>
          <div className="global-task-center__list">
            {cleanup.loading ? (
              <TaskRow icon={<ScanSearch className="is-spinning" size={16} />} title={t("app:tasks.cleanup.title")} detail={cleanup.progress ? t("app:tasks.cleanup.progress", { count: cleanup.progress.scannedEntryCount }) : t("app:tasks.preparing")}>
                <button type="button" disabled={cleanup.cancelling} onClick={() => void cleanup.cancel()}><CircleStop size={13} />{t("common:cancel")}</button>
                <button type="button" onClick={() => openView(onOpenCleanup)}>{t("app:tasks.open")}</button>
              </TaskRow>
            ) : cleanup.error ? (
              <TaskRow error icon={<AlertTriangle size={16} />} title={t("app:tasks.cleanup.failed")} detail={t("app:tasks.retry")}>
                <button type="button" onClick={() => openView(onOpenCleanup)}>{t("app:tasks.retry")}</button>
              </TaskRow>
            ) : null}
            {directoryActive && cleanup.directoryRefreshStatus ? (
              <TaskRow icon={<RefreshCw className="is-spinning" size={16} />} title={t("app:tasks.folder.title")} detail={t("app:tasks.folder.progress", { count: cleanup.directoryRefreshStatus.progress.scannedEntryCount })}>
                <button type="button" onClick={() => void cleanup.cancelDirectoryRefresh()}><CircleStop size={13} />{t("common:cancel")}</button>
                <button type="button" onClick={() => openView(onOpenCleanup)}>{t("app:tasks.open")}</button>
              </TaskRow>
            ) : null}
            {fileInsights.loading ? (
              <TaskRow icon={<ScanSearch className="is-spinning" size={16} />} title={t("app:tasks.files.title")} detail={fileInsights.progress ? t("app:tasks.files.progress", { count: fileInsights.progress.scannedEntryCount }) : t("app:tasks.preparing")}>
                <button type="button" onClick={() => void fileInsights.cancel()}><CircleStop size={13} />{t("common:cancel")}</button>
                <button type="button" onClick={() => openView(onOpenCleanup)}>{t("app:tasks.open")}</button>
              </TaskRow>
            ) : fileInsights.error ? (
              <TaskRow error icon={<AlertTriangle size={16} />} title={t("app:tasks.files.failed")} detail={t("app:tasks.retry")}>
                <button type="button" onClick={() => openView(onOpenCleanup)}>{t("app:tasks.retry")}</button>
              </TaskRow>
            ) : null}
            {startup.loading ? (
              <TaskRow icon={<RefreshCw className="is-spinning" size={16} />} title={t("app:tasks.startup.title")} detail={t("app:tasks.preparing")}>
                <button type="button" onClick={() => openView(onOpenStartup)}>{t("app:tasks.open")}</button>
              </TaskRow>
            ) : startup.error ? (
              <TaskRow error icon={<AlertTriangle size={16} />} title={t("app:tasks.startup.failed")} detail={t("app:tasks.retry")}>
                <button type="button" onClick={() => void startup.refresh()}>{t("app:tasks.retry")}</button>
              </TaskRow>
            ) : null}
            {updateActive ? (
              <TaskRow error={updater.action === "installError" || updater.action === "restartError"} icon={updater.action === "ready" ? <CheckCircle2 size={16} /> : updater.action === "installing" ? <LoaderCircle className="is-spinning" size={16} /> : <AlertTriangle size={16} />} title={updateTitle} detail={updater.availableVersion ? `v${updater.availableVersion}` : t("app:tasks.update.current")}>
                <button type="button" onClick={() => openView(onOpenUpdates)}>{t("app:tasks.open")}</button>
              </TaskRow>
            ) : null}
            {taskCount === 0 && !hasFailure ? (
              <div className="global-task-center__empty"><CheckCircle2 size={19} /><strong>{t("app:tasks.empty")}</strong><small>{t("app:tasks.emptyHint")}</small></div>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function TaskRow({ icon, title, detail, error = false, children }: { icon: ReactNode; title: string; detail: string; error?: boolean; children: ReactNode }) {
  return <article className={error ? "is-error" : undefined}><span>{icon}</span><div><strong>{title}</strong><small title={detail}>{detail}</small></div><footer>{children}</footer></article>;
}
