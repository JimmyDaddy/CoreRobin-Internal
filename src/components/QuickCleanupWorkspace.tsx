import { ArrowRight, FolderSearch, Wand2 } from "lucide-react";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { QuickCleanupOperation } from "../capabilities/QuickCleanupOperation";
import "./QuickCleanupWorkspace.css";

export function QuickCleanupPage({ onBack }: { onBack: () => void }) {
  const { t } = useAppTranslation();
  return <section className="quick-clean-page" aria-label={t("cleanup:quickClean.title")}>
    <QuickCleanupOperation />
      <div className="quick-clean-page__guide">
        <span className="quick-clean-page__guide-icon" aria-hidden="true">
          <FolderSearch size={20} />
        </span>
        <div>
          <strong>{t("cleanup:quickClean.guideTitle")}</strong>
          <p>{t("cleanup:quickClean.guideDescription")}</p>
        </div>
        <button className="button button--secondary" type="button" onClick={onBack}>
          {t("cleanup:quickClean.guideAction")}
          <ArrowRight size={14} />
        </button>
      </div>
  </section>;
}

export function QuickCleanLauncher({ onOpen }: { onOpen: () => void }) {
  const { t } = useAppTranslation();
  return (
    <button
      className="quick-clean-launcher"
      type="button"
      onClick={onOpen}
    >
      <span className="quick-clean-launcher__icon" aria-hidden="true">
        <Wand2 size={17} />
      </span>
      <span className="quick-clean-launcher__copy">
        <strong>{t("cleanup:quickClean.title")}</strong>
        <small>{t("cleanup:quickClean.launcherDescription")}</small>
      </span>
      <span className="quick-clean-launcher__action">
        {t("cleanup:quickClean.open")}
        <ArrowRight size={13} />
      </span>
    </button>
  );
}
