import {
  ArrowUpRight,
  BookOpen,
  Bug,
  Check,
  Clipboard,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isDesktopRuntime, openProductPage } from "../api";
import { useAppTranslation } from "../i18n/useAppTranslation";
import {
  buildRedactedDiagnosticSummary,
  checkForProductUpdate,
  copyText,
  CURRENT_APP_VERSION,
  localizedProductPage,
  type LocalizedProductPage,
  type ProductPage,
  type UpdateCheckResult,
} from "../productSupport";
import type { AppSettings } from "../settings";
import type { SystemSnapshot } from "../types";
import { Button } from "./Button";

export function AboutSupport({
  settings,
  snapshot,
  onOpenOnboarding,
  onClearAllData,
}: {
  settings: AppSettings;
  snapshot: SystemSnapshot;
  onOpenOnboarding: () => void;
  onClearAllData: () => void;
}) {
  const { t, i18n } = useAppTranslation();
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | "error" | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [confirmClear, setConfirmClear] = useState(false);
  const diagnostic = useMemo(
    () => buildRedactedDiagnosticSummary({
      snapshot,
      settings,
      desktopRuntime: isDesktopRuntime(),
    }),
    [settings, snapshot],
  );

  const checkForUpdate = async () => {
    if (checking) return;
    setChecking(true);
    setUpdateResult(null);
    try {
      setUpdateResult(await checkForProductUpdate());
    } catch {
      setUpdateResult("error");
    } finally {
      setChecking(false);
    }
  };

  const copyDiagnostic = async () => {
    try {
      await copyText(diagnostic);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2_500);
    } catch {
      setCopyState("error");
    }
  };
  const openPage = (page: ProductPage) => void openProductPage(page);
  const openLocalizedPage = (page: LocalizedProductPage) =>
    openPage(localizedProductPage(page, i18n.resolvedLanguage));

  return (
    <section className="about-support" aria-labelledby="about-support-title">
      <header className="about-support__heading">
        <span aria-hidden="true"><Info size={18} /></span>
        <div>
          <h2 id="about-support-title">{t("settings:about.title")}</h2>
          <p>{t("settings:about.description")}</p>
        </div>
      </header>

      <div className="about-support__grid">
        <section className="about-support__card about-support__card--version">
          <div className="about-support__card-heading">
            <span><RefreshCw size={17} /></span>
            <div><strong>{t("settings:about.versionTitle")}</strong><small>{t("settings:about.versionDescription")}</small></div>
          </div>
          <dl className="about-support__facts">
            <div><dt>{t("settings:about.version")}</dt><dd>v{CURRENT_APP_VERSION}</dd></div>
            <div><dt>{t("settings:about.platform")}</dt><dd>{snapshot.host.osName} {snapshot.host.osVersion}</dd></div>
            <div><dt>{t("settings:about.architecture")}</dt><dd>{snapshot.host.architecture}</dd></div>
          </dl>
          <div className="about-support__actions">
            <Button variant="secondary" disabled={checking} onClick={() => void checkForUpdate()}>
              {checking ? <LoaderCircle className="is-spinning" size={15} /> : <RefreshCw size={15} />}
              {t(checking ? "settings:about.checking" : "settings:about.checkUpdate")}
            </Button>
            <button className="about-support__link-button" type="button" onClick={() => openLocalizedPage("releases")}>
              {t("settings:about.releaseNotes")}<ArrowUpRight size={14} />
            </button>
          </div>
          {updateResult ? (
            <p className={`about-support__result is-${updateResult === "error" ? "error" : updateResult.status}`} role="status">
              {updateResult === "error"
                ? t("settings:about.updateError")
                : updateResult.status === "available"
                  ? <><span>{t("settings:about.updateAvailable", { version: updateResult.latestVersion })}</span><button className="about-support__link-button" type="button" onClick={() => openLocalizedPage("releases")}>{t("settings:about.openRelease")}<ArrowUpRight size={12} /></button></>
                  : <><Check size={14} />{t("settings:about.upToDate", { version: updateResult.latestVersion })}</>}
            </p>
          ) : null}
        </section>

        <section className="about-support__card">
          <div className="about-support__card-heading">
            <span><BookOpen size={17} /></span>
            <div><strong>{t("settings:about.helpTitle")}</strong><small>{t("settings:about.helpDescription")}</small></div>
          </div>
          <nav className="about-support__links" aria-label={t("settings:about.helpTitle") }>
            <button type="button" onClick={() => openLocalizedPage("guide")}><BookOpen size={15} />{t("settings:about.guide")}<ArrowUpRight size={13} /></button>
            <button type="button" onClick={() => openLocalizedPage("privacy")}><ShieldCheck size={15} />{t("settings:about.privacy")}<ArrowUpRight size={13} /></button>
            <button type="button" onClick={() => openPage("issues")}><Bug size={15} />{t("settings:about.reportIssue")}<ArrowUpRight size={13} /></button>
            <button type="button" onClick={onOpenOnboarding}><RotateCcw size={15} />{t("settings:about.reopenGuide")}</button>
          </nav>
        </section>

        <section className="about-support__card">
          <div className="about-support__card-heading">
            <span><Clipboard size={17} /></span>
            <div><strong>{t("settings:about.diagnosticsTitle")}</strong><small>{t("settings:about.diagnosticsDescription")}</small></div>
          </div>
          <p className="about-support__privacy-note"><ShieldCheck size={14} />{t("settings:about.diagnosticsPrivacy")}</p>
          <details className="about-support__diagnostic-preview">
            <summary>{t("settings:about.diagnosticsPreview")}</summary>
            <pre>{diagnostic}</pre>
          </details>
          <Button variant="secondary" onClick={() => void copyDiagnostic()}>
            {copyState === "copied" ? <Check size={15} /> : <Clipboard size={15} />}
            {t(`settings:about.diagnostics.${copyState}`)}
          </Button>
        </section>

        <section className="about-support__card about-support__card--danger">
          <div className="about-support__card-heading">
            <span><Trash2 size={17} /></span>
            <div><strong>{t("settings:about.clearTitle")}</strong><small>{t("settings:about.clearDescription")}</small></div>
          </div>
          {confirmClear ? (
            <div className="about-support__confirm" role="alert">
              <p>{t("settings:about.clearConfirm")}</p>
              <div>
                <Button variant="danger" onClick={onClearAllData}><Trash2 size={15} />{t("settings:about.clearNow")}</Button>
                <Button variant="secondary" onClick={() => setConfirmClear(false)}>{t("common:cancel")}</Button>
              </div>
            </div>
          ) : (
            <Button variant="dangerGhost" onClick={() => setConfirmClear(true)}><Trash2 size={15} />{t("settings:about.clearAction")}</Button>
          )}
        </section>
      </div>
    </section>
  );
}
