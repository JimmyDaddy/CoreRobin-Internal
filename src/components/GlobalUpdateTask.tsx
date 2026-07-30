import { CheckCircle2, Clock3, Download, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { AppUpdaterController } from "../hooks/useAppUpdater";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { localizeUpdateReleaseNotes } from "../updateReleaseNotes";
import "./GlobalUpdateTask.css";

export function GlobalUpdateTask({
  updater,
}: {
  updater: AppUpdaterController;
}) {
  const { t, i18n } = useAppTranslation();
  const [receiptCollapsed, setReceiptCollapsed] = useState(false);
  const availableVersion = updater.availableVersion;
  const availablePrompt =
    updater.promptVisible
    && availableVersion !== null
    && updater.action === "idle";

  useEffect(() => {
    setReceiptCollapsed(false);
    if (!updater.updatedFromVersion) return;
    const timeout = window.setTimeout(() => {
      setReceiptCollapsed(true);
    }, 9_000);
    return () => window.clearTimeout(timeout);
  }, [updater.updatedFromVersion]);

  if (availablePrompt && availableVersion) {
    return (
      <aside
        className="global-update-task global-update-task--available"
        role="dialog"
        aria-modal="false"
        aria-labelledby="global-update-title"
      >
        <span className="global-update-task__release-icon">
          <Download size={20} />
        </span>
        <div>
          <small>{t("settings:about.versionTitle")}</small>
          <strong id="global-update-title">
            {t("settings:about.updateAvailable", {
              version: availableVersion,
            })}
          </strong>
          <p>
            {localizeUpdateReleaseNotes(
              updater.installableUpdate?.notes ?? null,
              i18n.resolvedLanguage,
            )
              ?? t("settings:about.versionDescription")}
          </p>
        </div>
        <div className="global-update-task__actions">
          <button
            className="is-primary"
            type="button"
            disabled={!updater.installableUpdate}
            onClick={() => void updater.install()}
          >
            <Download size={14} />
            {t("settings:about.installUpdate")}
          </button>
          <button type="button" onClick={updater.remindLater}>
            <Clock3 size={14} />
            {t("settings:about.remindLater")}
          </button>
          <button type="button" onClick={updater.skipAvailableVersion}>
            {t("settings:about.skipVersion", {
              version: availableVersion,
            })}
          </button>
        </div>
      </aside>
    );
  }

  if (updater.updatedFromVersion && receiptCollapsed) {
    const receipt = t("settings:about.updatedReceipt", {
      version: updater.updatedFromVersion,
    });
    return (
      <aside
        className="global-update-task global-update-task--receipt is-collapsed"
        role="status"
        aria-live="polite"
        title={receipt}
      >
        <button
          className="global-update-task__receipt-chip"
          type="button"
          aria-label={receipt}
          onClick={() => setReceiptCollapsed(false)}
        >
          <CheckCircle2 size={17} />
          <span>{t("settings:about.updatedCompact")}</span>
        </button>
        <button
          className="global-update-task__receipt-close"
          type="button"
          aria-label={t("common:close")}
          onClick={updater.dismissUpdatedReceipt}
        >
          <X size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={`global-update-task${updater.updatedFromVersion
        ? " global-update-task--receipt"
        : ""}`}
      role="status"
      aria-live="polite"
    >
      {updater.updatedFromVersion ? (
        <CheckCircle2 size={17} />
      ) : (
        <RefreshCw
          className={updater.action === "installing" ? "is-spinning" : undefined}
          size={17}
        />
      )}
      <div>
        <strong>
          {updater.updatedFromVersion
            ? t("settings:about.updatedReceipt", {
                version: updater.updatedFromVersion,
              })
            : updater.action === "installing"
              ? t("settings:about.downloadingUpdate")
              : t("settings:about.updateReady")}
        </strong>
        {updater.action === "installing" && updater.progress ? (
          <progress max="100" value={updater.progress.percent ?? undefined} />
        ) : null}
      </div>
      {updater.action === "ready" || updater.action === "restartError" ? (
        <button type="button" onClick={() => void updater.restart()}>
          {t("settings:about.restartUpdate")}
        </button>
      ) : updater.updatedFromVersion ? (
        <button type="button" onClick={updater.dismissUpdatedReceipt}>
          {t("common:close")}
        </button>
      ) : null}
    </aside>
  );
}
