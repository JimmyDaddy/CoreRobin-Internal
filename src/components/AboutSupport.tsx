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
import { useEffect, useMemo, useRef, useState } from "react";

import { isDesktopRuntime, openProductPage } from "../api";
import {
  checkForInstallableAppUpdate,
  restartAfterAppUpdate,
  type AppUpdateProgress,
  type InstallableAppUpdate,
} from "../appUpdater";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { ProductDataClearResult } from "../productDataClear";
import {
  buildRedactedDiagnosticSummary,
  checkForProductUpdate,
  copyText,
  CURRENT_APP_VERSION,
  type LocalizedProductPage,
  type ProductPage,
  type UpdateCheckResult,
} from "../productSupport";
import type { AppSettings } from "../settings";
import type { SystemSnapshot } from "../types";
import { Button } from "./Button";
import { ClearProductDataAction } from "./ClearProductDataAction";

type UpdateDisplayResult = Pick<UpdateCheckResult, "status" | "latestVersion">;

export function AboutSupport({
  settings,
  snapshot,
  onOpenOnboarding,
  onClearAllData,
  backgroundUpdateVersion,
  backgroundUpdateCheckedAt = null,
  backgroundUpdateCheckFailed = false,
}: {
  settings: AppSettings;
  snapshot: SystemSnapshot;
  onOpenOnboarding: () => void;
  onClearAllData: () => Promise<void | ProductDataClearResult[]>;
  backgroundUpdateVersion?: string | null;
  backgroundUpdateCheckedAt?: number | null;
  backgroundUpdateCheckFailed?: boolean;
}) {
  const { t, i18n } = useAppTranslation();
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateDisplayResult | "error" | null>(null);
  const [installableUpdate, setInstallableUpdate] = useState<InstallableAppUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateAction, setUpdateAction] = useState<"idle" | "installing" | "ready" | "error">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [lastCheckedAt, setLastCheckedAt] =
    useState<number | null>(backgroundUpdateCheckedAt);
  const [lastCheckFailed, setLastCheckFailed] =
    useState(backgroundUpdateCheckFailed);
  const backgroundUpdateHydrationRef = useRef<string | null>(null);
  const diagnostic = useMemo(
    () => buildRedactedDiagnosticSummary({
      snapshot,
      settings,
      desktopRuntime: isDesktopRuntime(),
    }),
    [settings, snapshot],
  );

  useEffect(() => () => {
    void installableUpdate?.close().catch(() => undefined);
  }, [installableUpdate]);

  useEffect(() => {
    if (!backgroundUpdateVersion || updateResult) return;
    setUpdateResult({
      status: "available",
      latestVersion: backgroundUpdateVersion,
    });
  }, [backgroundUpdateVersion, updateResult]);

  useEffect(() => {
    setLastCheckedAt(backgroundUpdateCheckedAt);
    setLastCheckFailed(backgroundUpdateCheckFailed);
  }, [backgroundUpdateCheckFailed, backgroundUpdateCheckedAt]);

  useEffect(() => {
    if (
      !backgroundUpdateVersion ||
      !isDesktopRuntime() ||
      installableUpdate ||
      backgroundUpdateHydrationRef.current === backgroundUpdateVersion
    ) return;
    backgroundUpdateHydrationRef.current = backgroundUpdateVersion;
    let disposed = false;
    void checkForInstallableAppUpdate()
      .then(async (update) => {
        if (disposed) {
          await update?.close().catch(() => undefined);
          return;
        }
        if (update?.version === backgroundUpdateVersion) {
          setInstallableUpdate(update);
          return;
        }
        await update?.close().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [backgroundUpdateVersion, installableUpdate]);

  const checkForUpdate = async () => {
    if (checking || updateAction === "installing") return;
    setChecking(true);
    setUpdateResult(null);
    setUpdateAction("idle");
    setUpdateProgress(null);
    try {
      if (isDesktopRuntime()) {
        const update = await checkForInstallableAppUpdate();
        setInstallableUpdate(update);
        setUpdateResult(update
          ? { status: "available", latestVersion: update.version }
          : { status: "current", latestVersion: CURRENT_APP_VERSION });
      } else {
        setInstallableUpdate(null);
        const result = await checkForProductUpdate();
        setUpdateResult({ status: result.status, latestVersion: result.latestVersion });
      }
      setLastCheckedAt(Date.now());
      setLastCheckFailed(false);
    } catch {
      setInstallableUpdate(null);
      setUpdateResult("error");
      setLastCheckedAt(Date.now());
      setLastCheckFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    if (!installableUpdate || updateAction === "installing") return;
    setUpdateAction("installing");
    setUpdateProgress({ phase: "downloading", downloadedBytes: 0, contentLength: null, percent: null });
    try {
      await installableUpdate.install(setUpdateProgress);
      setUpdateAction("ready");
    } catch {
      setUpdateAction("error");
    }
  };

  const restartForUpdate = async () => {
    try {
      await restartAfterAppUpdate();
    } catch {
      setUpdateAction("error");
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
  const openPage = (page: ProductPage) => void openProductPage(page, i18n.resolvedLanguage);
  const openLocalizedPage = (page: LocalizedProductPage) =>
    openPage(page);

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
            <Button variant="secondary" disabled={checking || updateAction === "installing"} onClick={() => void checkForUpdate()}>
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
                  ? <>
                      <span>{t("settings:about.updateAvailable", { version: updateResult.latestVersion })}</span>
                      {installableUpdate ? (
                        updateAction === "ready" ? (
                          <Button variant="secondary" onClick={() => void restartForUpdate()}>{t("settings:about.restartUpdate")}</Button>
                        ) : (
                          <Button variant="secondary" disabled={updateAction === "installing"} onClick={() => void installUpdate()}>
                            {updateAction === "installing" ? <LoaderCircle className="is-spinning" size={14} /> : null}
                            {t(updateAction === "installing" ? "settings:about.installingUpdate" : "settings:about.installUpdate")}
                          </Button>
                        )
                      ) : (
                        <button className="about-support__link-button" type="button" onClick={() => openLocalizedPage("releases")}>{t("settings:about.openRelease")}<ArrowUpRight size={12} /></button>
                      )}
                    </>
                  : <><Check size={14} />{t("settings:about.upToDate", { version: updateResult.latestVersion })}</>}
            </p>
          ) : null}
          {lastCheckedAt ? (
            <p className={`about-support__last-check${lastCheckFailed ? " is-error" : ""}`}>
              {t(lastCheckFailed
                ? "settings:about.lastCheckFailed"
                : "settings:about.lastChecked", {
                time: new Date(lastCheckedAt).toLocaleString(i18n.resolvedLanguage),
              })}
            </p>
          ) : null}
          {installableUpdate?.notes ? (
            <details className="about-support__release-notes">
              <summary>{t("settings:about.whatsNew")}</summary>
              <p>{installableUpdate.notes}</p>
            </details>
          ) : null}
          {updateAction === "installing" && updateProgress ? (
            <div className="about-support__progress" role="status" aria-live="polite">
              <div>
                <span>{t(updateProgress.phase === "installing" ? "settings:about.applyingUpdate" : "settings:about.downloadingUpdate")}</span>
                {updateProgress.percent !== null ? <strong>{updateProgress.percent}%</strong> : null}
              </div>
              <progress max="100" value={updateProgress.percent ?? undefined} />
            </div>
          ) : null}
          {updateAction === "ready" ? <p className="about-support__update-note" role="status"><Check size={14} />{t("settings:about.updateReady")}</p> : null}
          {updateAction === "error" ? <p className="about-support__result is-error" role="alert">{t("settings:about.updateInstallError")}</p> : null}
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
          <ClearProductDataAction
            label={t("settings:about.clearAction")}
            onClearAllData={onClearAllData}
          />
        </section>
      </div>
    </section>
  );
}
