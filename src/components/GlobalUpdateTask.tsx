import { RefreshCw } from "lucide-react";

import type { AppUpdaterController } from "../hooks/useAppUpdater";
import { useAppTranslation } from "../i18n/useAppTranslation";
import "./GlobalUpdateTask.css";

export function GlobalUpdateTask({
  updater,
}: {
  updater: AppUpdaterController;
}) {
  const { t } = useAppTranslation();

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
