import { Clock3, Download, RefreshCw } from "lucide-react";

import type { AppUpdaterController } from "../hooks/useAppUpdater";
import { useAppTranslation } from "../i18n/useAppTranslation";
import "./GlobalUpdateTask.css";

export function GlobalUpdateTask({
  updater,
}: {
  updater: AppUpdaterController;
}) {
  const { t } = useAppTranslation();
  const availableVersion = updater.availableVersion;
  const availablePrompt =
    updater.promptVisible
    && availableVersion !== null
    && updater.action === "idle";

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
            {updater.installableUpdate?.notes
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

  return (
    <aside className="global-update-task" role="status" aria-live="polite">
      <RefreshCw
        className={updater.action === "installing" ? "is-spinning" : undefined}
        size={17}
      />
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
