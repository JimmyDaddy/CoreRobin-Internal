import { AlertTriangle, AppWindow, BellRing, Check, ChevronDown, Cpu, Download, FileJson, HardDrive, History, Languages, LayoutDashboard, ListTree, LoaderCircle, MemoryStick, Minus, Network, PackageOpen, Plus, Rocket, ScanSearch, Search, Settings2, ShieldCheck, Timer, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type ChangeEventHandler, type ComponentType, type ReactNode } from "react";
import "./SettingsExplorer.css";
import { useAppTranslation } from "../i18n/useAppTranslation";
import { applicationWatchSamplingIntervalMs } from "../applicationWatchRules";
import {
  openCleanupFullDiskAccessSettings,
} from "../api";
import { useCleanupScanAccess } from "../hooks/useCleanupScanAccess";
import type {
  ProductDataCategory,
  ProductDataCategorySummary,
  ProductDataClearReceipt,
  ProductDataPrivacyController,
} from "../hooks/useProductDataPrivacy";

import {
  CONNECTION_REFRESH_INTERVAL_OPTIONS,
  SYSTEM_SAMPLE_INTERVAL_OPTIONS,
  SYSTEM_SAMPLING_PRESETS,
  systemSamplingPreset,
  type AppSettings,
  type ApplicationWatchMetric,
  type ApplicationWatchRule,
  type UsageThresholds,
} from "../settings";
import { HISTORY_RETENTION_OPTIONS } from "../historyStore";
import type {
  DesktopNotificationDelivery,
  DesktopNotificationStatus,
} from "../desktopNotifications";
import type { SystemSnapshot } from "../types";
import type { AppUpdaterController } from "../hooks/useAppUpdater";
import type { ProductDataClearResult } from "../productDataClear";
import { aggregateApplications } from "../diagnosis";
import { formatBytes } from "../utils";
import { AboutSupport } from "./AboutSupport";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { LocaleSelect } from "./LocaleSelect";
import { RobinIcon } from "./RobinIcon";
import { ClearProductDataAction } from "./ClearProductDataAction";
import {
  createSettingsTransferDocument,
  parseSettingsTransferDocument,
  serializeSettingsTransferDocument,
  settingsUpdateFromTransfer,
  type SettingsTransferPreview,
} from "../settingsTransfer";

type SettingsIcon = ComponentType<{ size?: number | string }>;
type SettingsSection =
  | "general"
  | "background"
  | "monitoring"
  | "alerts"
  | "privacy"
  | "about";

interface SettingsExplorerProps {
  settings: AppSettings;
  notificationStatus: DesktopNotificationStatus;
  notificationDelivery?: DesktopNotificationDelivery | null;
  dataPrivacy?: ProductDataPrivacyController | null;
  snapshot: SystemSnapshot;
  onChange: (update: Partial<Omit<AppSettings, "version">>) => void;
  onOpenNotificationSettings?: () => void;
  onSendTestNotification?: () => Promise<boolean>;
  onOpenOnboarding: () => void;
  onClearAllData: () => Promise<void | ProductDataClearResult[]>;
  activeApplicationWatchRuleIds?: readonly string[];
  updater: AppUpdaterController;
}

const THRESHOLD_OPTIONS = Array.from({ length: 20 }, (_, index) =>
  Math.min(100, (index + 1) * 5),
);

const WATCH_METRICS = [
  { value: "cpu", icon: Cpu },
  { value: "memory", icon: MemoryStick },
  { value: "disk", icon: HardDrive },
] as const satisfies readonly { value: ApplicationWatchMetric; icon: SettingsIcon }[];

const WATCH_DURATIONS = [10, 30, 60, 300] as const;

export function SettingsExplorer({
  settings,
  notificationStatus,
  notificationDelivery = null,
  dataPrivacy = null,
  snapshot,
  onChange,
  onOpenNotificationSettings = () => undefined,
  onSendTestNotification = async () => false,
  onOpenOnboarding,
  onClearAllData,
  activeApplicationWatchRuleIds = [],
  updater,
}: SettingsExplorerProps) {
  const { t, i18n } = useAppTranslation();
  const [moderate, high, critical] = settings.usageThresholds;
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("general");
  const cleanupAccess = useCleanupScanAccess(activeSection === "privacy");
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsImportPreview, setSettingsImportPreview] =
    useState<SettingsTransferPreview | null>(null);
  const [settingsTransferError, setSettingsTransferError] =
    useState<string | null>(null);

  const exportSettings = () => {
    const content = serializeSettingsTransferDocument(
      createSettingsTransferDocument(settings),
    );
    const url = URL.createObjectURL(new Blob([content], {
      type: "application/json",
    }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `CoreRobin-preferences-${new Date()
      .toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importSettingsFile: ChangeEventHandler<HTMLInputElement> = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSettingsTransferError(null);
    void file.text()
      .then((serialized) => {
        setSettingsImportPreview(
          parseSettingsTransferDocument(serialized, settings),
        );
      })
      .catch(() => {
        setSettingsImportPreview(null);
        setSettingsTransferError(t("settings:transfer.invalid"));
      });
  };

  const updateThreshold = (index: number, value: number) => {
    const next = [...settings.usageThresholds] as [number, number, number];
    next[index] = value;
    onChange({ usageThresholds: next });
  };

  return (
    <section className="settings-explorer" aria-labelledby="settings-title">
      <header className="panel settings-hero">
        <span className="eyebrow">{t("settings:localPreferences")}</span>
        <h2 id="settings-title">{t("settings:title")}</h2>
        <p>{t("settings:description")}</p>
      </header>

      <nav className="settings-section-tabs" aria-label={t("settings:title")}>
        {(["general", "background", "monitoring", "alerts", "privacy", "about"] as const).map(
          (section) => (
            <button
              type="button"
              key={section}
              className={activeSection === section ? "is-active" : undefined}
              aria-current={activeSection === section ? "page" : undefined}
              onClick={() => setActiveSection(section)}
            >
              {t(
                section === "general"
                  ? "settings:experience.title"
                  : section === "background"
                    ? "settings:background.title"
                    : section === "monitoring"
                      ? "settings:sampling.title"
                      : section === "alerts"
                        ? "settings:notifications.title"
                        : section === "privacy"
                          ? "settings:dataPrivacy.title"
                          : "settings:about.title",
              )}
              {section === "about" && updater.availableVersion ? (
                <em>v{updater.availableVersion}</em>
              ) : null}
            </button>
          ),
        )}
      </nav>

      {activeSection !== "about" ? (
      <div className="settings-grid" data-active-section={activeSection}>
        <SettingsCard
          section="general"
          className="settings-card--mode"
          icon={LayoutDashboard}
          title={t("settings:experience.title")}
          description={t("settings:experience.description")}
        >
          <div className="settings-segmented" role="group" aria-label={t("settings:experience.label")}>
            {(["simple", "professional"] as const).map((experienceMode) => (
              <button
                type="button"
                key={experienceMode}
                className={settings.experienceMode === experienceMode ? "is-active" : ""}
                aria-pressed={settings.experienceMode === experienceMode}
                onClick={() => onChange({ experienceMode })}
              >
                {t(`settings:experience.${experienceMode}`)}
              </button>
            ))}
          </div>
        </SettingsCard>

        <SettingsCard
          section="privacy"
          className="settings-card--half settings-card--transfer"
          icon={FileJson}
          title={t("settings:transfer.title")}
          description={t("settings:transfer.description")}
        >
          <div className="settings-transfer">
            <button className="button button--secondary" type="button" onClick={exportSettings}>
              <Download size={14} />{t("settings:transfer.export")}
            </button>
            <button className="button button--secondary" type="button" onClick={() => importInputRef.current?.click()}>
              <Upload size={14} />{t("settings:transfer.import")}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={importSettingsFile}
            />
            <small><ShieldCheck size={13} />{t("settings:transfer.boundary")}</small>
            {settingsTransferError ? (
              <p role="alert"><AlertTriangle size={13} />{settingsTransferError}</p>
            ) : null}
            {settingsImportPreview ? (
              <div className="settings-transfer__preview" role="dialog" aria-label={t("settings:transfer.previewTitle")}>
                <strong>{t("settings:transfer.previewTitle")}</strong>
                <span>{t("settings:transfer.preview", {
                  count: settingsImportPreview.changedKeys.length,
                  rules: settingsImportPreview.ruleCount,
                })}</span>
                <code>{settingsImportPreview.changedKeys.join(" · ") || t("settings:transfer.noChanges")}</code>
                <div>
                  <button className="button button--plain" type="button" onClick={() => setSettingsImportPreview(null)}>
                    {t("common:cancel")}
                  </button>
                  <button className="button button--primary" type="button" onClick={() => {
                    onChange(settingsUpdateFromTransfer(settingsImportPreview.document));
                    setSettingsImportPreview(null);
                  }}>
                    <Check size={14} />{t("settings:transfer.apply")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </SettingsCard>

        <SettingsCard
          section="privacy"
          className="settings-card--privacy-center"
          icon={ShieldCheck}
          title={t("settings:dataPrivacy.title")}
          description={t("settings:dataPrivacy.description")}
        >
          <div className="settings-data-boundaries">
            {dataPrivacy ? (
              <>
                <ProductDataCategoryRow
                  category="resourceHistory"
                  icon={History}
                  enabled={settings.historyPersistenceEnabled}
                  summary={dataPrivacy.categories.resourceHistory}
                  receipt={dataPrivacy.receipts.resourceHistory}
                  language={i18n.resolvedLanguage}
                  onClear={dataPrivacy.clearCategory}
                />
                <ProductDataCategoryRow
                  category="connectionHistory"
                  icon={Network}
                  enabled={settings.networkConnectionHistoryEnabled}
                  summary={dataPrivacy.categories.connectionHistory}
                  receipt={dataPrivacy.receipts.connectionHistory}
                  language={i18n.resolvedLanguage}
                  onClear={dataPrivacy.clearCategory}
                />
                <ProductDataCategoryRow
                  category="applicationInventory"
                  icon={PackageOpen}
                  summary={dataPrivacy.categories.applicationInventory}
                  receipt={dataPrivacy.receipts.applicationInventory}
                  language={i18n.resolvedLanguage}
                  onClear={dataPrivacy.clearCategory}
                />
                <ProductDataCategoryRow
                  category="scanCaches"
                  icon={ScanSearch}
                  summary={dataPrivacy.categories.scanCaches}
                  receipt={dataPrivacy.receipts.scanCaches}
                  language={i18n.resolvedLanguage}
                  onClear={dataPrivacy.clearCategory}
                />
              </>
            ) : null}
            <div>
              <span><ShieldCheck size={16} /></span>
              <p>
                <strong>{t("settings:dataPrivacy.diskAccess.title")}</strong>
                <small>{t("settings:dataPrivacy.diskAccess.description")}</small>
              </p>
              <div className="settings-data-access-control">
                <em className={cleanupAccess.access?.fullDiskAccess === "granted" ? "is-on" : ""}>
                  {t(`settings:onboarding.controls.diskAccessStatus.${cleanupAccess.access?.fullDiskAccess ?? "unknown"}`)}
                </em>
                {cleanupAccess.access?.fullDiskAccessRecommended
                  && cleanupAccess.access.fullDiskAccess !== "granted" ? (
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={cleanupAccess.checking}
                      onClick={() => void openCleanupFullDiskAccessSettings()}
                    >
                      <Settings2 size={14} />
                      {t("settings:dataPrivacy.diskAccess.open")}
                    </button>
                  ) : null}
              </div>
            </div>
            <div className="settings-data-clear-all">
              <span><Trash2 size={16} /></span>
              <p>
                <strong>{t("settings:dataPrivacy.clearAll.title")}</strong>
                <small>{t("settings:dataPrivacy.clearAll.description")}</small>
              </p>
              <ClearProductDataAction
                label={t("settings:dataPrivacy.clear")}
                onClearAllData={onClearAllData}
              />
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          section="general"
          className="settings-card--language"
          icon={Languages}
          title={t("settings:language.title")}
          description={t("settings:language.description")}
        >
          <LocaleSelect
            value={settings.language}
            label={t("settings:language.label")}
            onChange={(language) => onChange({ language })}
          />
        </SettingsCard>

        <SettingsCard
          section="background"
          className="settings-card--background"
          icon={AppWindow}
          title={t("settings:background.title")}
          description={t("settings:background.description")}
        >
          <div className="settings-background-controls">
            <BackgroundSwitch
              icon={AppWindow}
              label={t("settings:background.showDockIcon")}
              description={t("settings:background.showDockIconDescription")}
              checked={settings.showDockIcon}
              onChange={(checked) => onChange({ showDockIcon: checked })}
            />
            <BackgroundSwitch
              icon={Rocket}
              label={t("settings:background.launchAtLogin")}
              description={t("settings:background.launchAtLoginDescription")}
              checked={settings.launchAtLogin}
              onChange={(checked) => onChange({ launchAtLogin: checked })}
            />
            <BackgroundSwitch
              icon={RobinIcon}
              label={t("settings:background.companionShowOnStartup")}
              description={t("settings:background.companionShowOnStartupDescription")}
              checked={settings.companionShowOnStartup}
              onChange={(checked) => onChange({ companionShowOnStartup: checked })}
            />
            <BackgroundSwitch
              icon={RobinIcon}
              label={t("settings:background.companionAlwaysOnTop")}
              description={t("settings:background.companionAlwaysOnTopDescription")}
              checked={settings.companionAlwaysOnTop}
              onChange={(checked) => onChange({ companionAlwaysOnTop: checked })}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          section="monitoring"
          icon={Timer}
          title={t("settings:sampling.title")}
          description={t("settings:sampling.description")}
        >
          <div className="settings-sampling-presets" role="group" aria-label={t("settings:sampling.system") }>
            {(Object.keys(SYSTEM_SAMPLING_PRESETS) as Array<keyof typeof SYSTEM_SAMPLING_PRESETS>).map((preset) => (
              <button
                type="button"
                key={preset}
                className={systemSamplingPreset(settings.systemSampleIntervalMs) === preset ? "is-active" : ""}
                aria-pressed={systemSamplingPreset(settings.systemSampleIntervalMs) === preset}
                onClick={() => onChange({ systemSampleIntervalMs: SYSTEM_SAMPLING_PRESETS[preset] })}
              >
                <strong>{t(`settings:sampling.presets.${preset}.label`)}</strong>
                <small>{t(`settings:sampling.presets.${preset}.description`)}</small>
              </button>
            ))}
          </div>
          <details className="settings-sampling-advanced">
            <summary>{t("settings:sampling.advanced")}</summary>
            <label className="settings-field">
              <span>{t("settings:sampling.system")}</span>
              <SettingsSelect
                value={settings.systemSampleIntervalMs}
                onChange={(event) =>
                  onChange({ systemSampleIntervalMs: Number(event.target.value) })
                }
              >
                {SYSTEM_SAMPLE_INTERVAL_OPTIONS.map((interval) => (
                  <option key={interval} value={interval}>
                    {t("settings:intervalMs", { interval })}
                  </option>
                ))}
              </SettingsSelect>
            </label>
          </details>
        </SettingsCard>

        <SettingsCard
          section="monitoring"
          icon={Network}
          title={t("settings:connections.title")}
          description={t("settings:connections.description")}
        >
          <label className="settings-field">
            <span>{t("settings:connections.refresh")}</span>
            <SettingsSelect
              value={settings.connectionRefreshIntervalMs}
              onChange={(event) =>
                onChange({ connectionRefreshIntervalMs: Number(event.target.value) })
              }
            >
              {CONNECTION_REFRESH_INTERVAL_OPTIONS.map((interval) => (
                <option key={interval} value={interval}>
                  {t("settings:intervalSeconds", { seconds: interval / 1_000 })}
                </option>
              ))}
            </SettingsSelect>
          </label>
        </SettingsCard>

        <SettingsCard
          section="monitoring"
          icon={ListTree}
          title={t("settings:processView.title")}
          description={t("settings:processView.description")}
        >
          <div className="settings-segmented" role="group" aria-label={t("settings:processView.label")}>
            {(["flat", "tree"] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                className={settings.defaultProcessView === mode ? "is-active" : ""}
                aria-pressed={settings.defaultProcessView === mode}
                onClick={() => onChange({ defaultProcessView: mode })}
              >
                {t(`process:${mode}`)}
              </button>
            ))}
          </div>
        </SettingsCard>

        <SettingsCard
          section="privacy"
          className="settings-card--half"
          icon={History}
          title={t("settings:history.title")}
          description={t("settings:history.description")}
        >
          <div className="settings-history-controls">
            <label className="settings-switch">
              <input
                type="checkbox"
                role="switch"
                checked={settings.historyPersistenceEnabled}
                onChange={(event) =>
                  onChange({ historyPersistenceEnabled: event.target.checked })
                }
              />
              <span>{t("settings:history.persist")}</span>
            </label>
            <label className="settings-switch" title={t("settings:history.applicationNamesHint")}>
              <input
                type="checkbox"
                role="switch"
                disabled={!settings.historyPersistenceEnabled}
                checked={settings.historyPersistenceEnabled && settings.historyApplicationNamesEnabled}
                onChange={(event) =>
                  onChange({ historyApplicationNamesEnabled: event.target.checked })
                }
              />
              <span>{t("settings:history.applicationNames")}</span>
            </label>
            <label className="settings-switch" title={t("settings:applicationImpactHistory.hint")}>
              <input
                type="checkbox"
                role="switch"
                disabled={
                  !settings.historyPersistenceEnabled
                  || !settings.historyApplicationNamesEnabled
                }
                checked={
                  settings.historyPersistenceEnabled
                  && settings.historyApplicationNamesEnabled
                  && settings.applicationImpactHistoryEnabled
                }
                onChange={(event) =>
                  onChange({ applicationImpactHistoryEnabled: event.target.checked })
                }
              />
              <span>{t("settings:applicationImpactHistory.label")}</span>
            </label>
            <label className="settings-field">
              <span>{t("settings:history.retention")}</span>
              <SettingsSelect
                value={settings.historyRetentionDays}
                onChange={(event) =>
                  onChange({
                    historyRetentionDays:
                      event.target.value === "1"
                        ? 1
                        : event.target.value === "30"
                          ? 30
                          : 7,
                  })
                }
              >
                {HISTORY_RETENTION_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {t("settings:history.days", { count: days })}
                  </option>
                ))}
              </SettingsSelect>
            </label>
          </div>
        </SettingsCard>

        <SettingsCard
          section="alerts"
          className="settings-card--half"
          icon={BellRing}
          title={t("settings:notifications.title")}
          description={t("settings:notifications.description")}
        >
          <div className="settings-notification-controls">
            <label className="settings-switch">
              <input
                type="checkbox"
                role="switch"
                checked={settings.desktopNotificationsEnabled}
                onChange={(event) =>
                  onChange({ desktopNotificationsEnabled: event.target.checked })
                }
              />
              <span>{t("settings:notifications.enable")}</span>
            </label>
            <small className={`is-${notificationStatus}`}>
              <i />{t(`settings:notifications.status.${notificationStatus}`)}
            </small>
            {notificationStatus === "denied" ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={onOpenNotificationSettings}
              >
                <Settings2 size={14} />
                {t("settings:notifications.openSettings")}
              </button>
            ) : null}
            {notificationStatus === "ready" ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => void onSendTestNotification()}
              >
                <BellRing size={14} />
                {t("settings:notifications.test")}
              </button>
            ) : null}
            {notificationDelivery ? (
              <small
                className={`settings-notification-delivery is-${notificationDelivery.status}`}
                role={notificationDelivery.status === "failed" ? "alert" : "status"}
              >
                <i />
                {t(`settings:notifications.delivery.${notificationDelivery.status}`, {
                  time: new Date(notificationDelivery.attemptedAtMs)
                    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
                })}
              </small>
            ) : null}
          </div>
          <fieldset className="settings-notification-categories" disabled={!settings.desktopNotificationsEnabled}>
            <legend>{t("settings:notifications.categories")}</legend>
            {(["cpu", "memory", "volume"] as const).map((resource) => {
              const enabled = !settings.mutedNotificationResources.includes(resource);
              return (
                <label key={resource}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => onChange({
                      mutedNotificationResources: event.target.checked
                        ? settings.mutedNotificationResources.filter((item) => item !== resource)
                        : [...settings.mutedNotificationResources, resource],
                    })}
                  />
                  <span>{t(`settings:notifications.resources.${resource}`)}</span>
                </label>
              );
            })}
          </fieldset>
        </SettingsCard>

        <SettingsCard
          section="alerts"
          className="settings-card--thresholds"
          icon={BellRing}
          title={t("settings:thresholds.title")}
          description={t("settings:thresholds.description")}
        >
          <div className="settings-thresholds">
            <ThresholdSelect
              label={t("settings:thresholds.moderate")}
              value={moderate}
              options={THRESHOLD_OPTIONS.filter((value) => value < high)}
              tone="moderate"
              onChange={(value) => updateThreshold(0, value)}
            />
            <ThresholdSelect
              label={t("settings:thresholds.high")}
              value={high}
              options={THRESHOLD_OPTIONS.filter(
                (value) => value > moderate && value < critical,
              )}
              tone="high"
              onChange={(value) => updateThreshold(1, value)}
            />
            <ThresholdSelect
              label={t("settings:thresholds.critical")}
              value={critical}
              options={THRESHOLD_OPTIONS.filter((value) => value > high)}
              tone="critical"
              onChange={(value) => updateThreshold(2, value)}
            />
          </div>
          <ThresholdPreview thresholds={settings.usageThresholds} />
        </SettingsCard>

        <SettingsCard
          section="alerts"
          className="settings-card--watch-rules"
          icon={BellRing}
          title={t("settings:watchRules.title")}
          description={t("settings:watchRules.description")}
        >
          <ApplicationWatchRulesEditor
            rules={settings.applicationWatchRules}
            snapshot={snapshot}
            activeRuleIds={activeApplicationWatchRuleIds}
            notificationsReady={settings.desktopNotificationsEnabled && notificationStatus === "ready"}
            onChange={(applicationWatchRules) => onChange({ applicationWatchRules })}
          />
        </SettingsCard>
      </div>
      ) : null}
      {activeSection === "about" ? (
      <AboutSupport
        settings={settings}
        snapshot={snapshot}
        updater={updater}
        onOpenOnboarding={onOpenOnboarding}
        onClearAllData={onClearAllData}
      />
      ) : null}
    </section>
  );
}

function ApplicationWatchRulesEditor({
  rules,
  snapshot,
  activeRuleIds,
  notificationsReady,
  onChange,
}: {
  rules: readonly ApplicationWatchRule[];
  snapshot: SystemSnapshot;
  activeRuleIds: readonly string[];
  notificationsReady: boolean;
  onChange: (rules: ApplicationWatchRule[]) => void;
}) {
  const { t } = useAppTranslation();
  const applications = useMemo(
    () => aggregateApplications(snapshot.processes).sort((left, right) => left.name.localeCompare(right.name)),
    [snapshot.processes],
  );
  const applicationByName = new Map(
    applications.map((application) => [application.name.toLocaleLowerCase(), application]),
  );
  const applicationById = new Map(
    applications.map((application) => [application.applicationId, application]),
  );
  const [applicationName, setApplicationName] = useState("");
  const [metric, setMetric] = useState<ApplicationWatchMetric>("cpu");
  const [threshold, setThreshold] = useState(80);
  const [durationSeconds, setDurationSeconds] = useState(30);
  const normalizedApplicationName = applicationName.trim().toLocaleLowerCase();
  const selectedApplication =
    applicationByName.get(normalizedApplicationName) ?? null;
  const effectiveApplicationName =
    selectedApplication?.name ?? applicationName.trim();
  const duplicateRule = Boolean(effectiveApplicationName) && rules.some(
    (rule) =>
      (selectedApplication?.applicationId
        ? rule.applicationId === selectedApplication.applicationId
        : rule.applicationName.toLocaleLowerCase() ===
          effectiveApplicationName.toLocaleLowerCase()) &&
      rule.metric === metric &&
      rule.threshold === threshold &&
      rule.durationSeconds === durationSeconds,
  );
  const canAddRule = Boolean(effectiveApplicationName) && !duplicateRule;
  const backgroundSamplingIntervalMs =
    applicationWatchSamplingIntervalMs(rules);

  const thresholdMaximum = metric === "cpu" ? 100 : 1_000_000;
  const thresholdStep = metric === "disk" ? 0.5 : 1;
  const thresholdUnit = metric === "cpu" ? "%" : metric === "memory" ? "MiB" : "MiB/s";

  const changeThreshold = (value: number) => {
    const precisionSafeValue = Math.round(value * 10) / 10;
    setThreshold(Math.min(thresholdMaximum, Math.max(1, precisionSafeValue)));
  };

  const updateMetric = (nextMetric: ApplicationWatchMetric) => {
    setMetric(nextMetric);
    setThreshold(nextMetric === "cpu" ? 80 : nextMetric === "memory" ? 1_024 : 50);
  };
  const addRule = () => {
    if (!effectiveApplicationName || duplicateRule) return;
    onChange([...rules, {
      id: globalThis.crypto?.randomUUID?.() ?? `watch-${Date.now()}-${Math.random()}`,
      applicationName: effectiveApplicationName,
      applicationId: selectedApplication?.applicationId ?? null,
      metric,
      threshold,
      durationSeconds,
      enabled: true,
    }]);
    setApplicationName("");
  };

  return (
    <div className="watch-rules">
      <div className="watch-rules__builder">
        <div className="watch-rules__application-row">
          <label className="watch-rules__field watch-rules__field--application">
            <span>{t("settings:watchRules.application")}</span>
            <span className="watch-rules__application-input">
              <Search size={16} aria-hidden="true" />
              <input
                list="watch-rule-applications"
                value={applicationName}
                onChange={(event) => setApplicationName(event.target.value)}
                placeholder={t("settings:watchRules.applicationPlaceholder")}
                aria-invalid={Boolean(applicationName.trim()) && !selectedApplication}
              />
            </span>
          </label>
          <datalist id="watch-rule-applications">
            {applications.map(({ name }) => <option key={name} value={name} />)}
          </datalist>
          <button
            className="button button--primary watch-rules__add"
            type="button"
            disabled={!canAddRule}
            title={duplicateRule ? t("common:unavailable") : undefined}
            onClick={addRule}
          >
            <Plus size={15} />{t("settings:watchRules.add")}
          </button>
        </div>

        <div className="watch-rules__condition-grid">
          <fieldset className="watch-rules__field">
            <legend>{t("settings:watchRules.metric")}</legend>
            <div className="watch-rules__choices watch-rules__choices--metric">
              {WATCH_METRICS.map(({ value, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={metric === value ? "is-active" : ""}
                  aria-pressed={metric === value}
                  onClick={() => updateMetric(value)}
                >
                  <Icon size={14} aria-hidden="true" />
                  {t(`settings:watchRules.metrics.${value}`)}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="watch-rules__field">
            <span id="watch-rule-threshold-label">{t("settings:watchRules.threshold")}</span>
            <div className="watch-rules__number-control">
              <button
                type="button"
                aria-label={`${t("settings:watchRules.threshold")} −`}
                disabled={threshold <= 1}
                onClick={() => changeThreshold(threshold - thresholdStep)}
              >
                <Minus size={14} aria-hidden="true" />
              </button>
              <input
                aria-labelledby="watch-rule-threshold-label"
                type="number"
                min={1}
                max={thresholdMaximum}
                step={thresholdStep}
                value={threshold}
                onChange={(event) => {
                  if (Number.isFinite(event.target.valueAsNumber)) {
                    changeThreshold(event.target.valueAsNumber);
                  }
                }}
              />
              <small>{thresholdUnit}</small>
              <button
                type="button"
                aria-label={`${t("settings:watchRules.threshold")} +`}
                disabled={threshold >= thresholdMaximum}
                onClick={() => changeThreshold(threshold + thresholdStep)}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          <fieldset className="watch-rules__field">
            <legend>{t("settings:watchRules.duration")}</legend>
            <div className="watch-rules__choices watch-rules__choices--duration">
              {WATCH_DURATIONS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  className={durationSeconds === seconds ? "is-active" : ""}
                  aria-pressed={durationSeconds === seconds}
                  onClick={() => setDurationSeconds(seconds)}
                >
                  {t("settings:watchRules.seconds", { count: seconds })}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
      {!notificationsReady ? (
        <div className="watch-rules__notice">
          <BellRing size={14} aria-hidden="true" />
          <small>{t("settings:watchRules.notificationHint")}</small>
        </div>
      ) : null}
      {backgroundSamplingIntervalMs !== null ? (
        <div className="watch-rules__notice">
          <Timer size={14} aria-hidden="true" />
          <small>
            {t("settings:watchRules.backgroundSampling", {
              seconds: backgroundSamplingIntervalMs / 1_000,
            })}
          </small>
        </div>
      ) : null}
      {rules.length > 0 ? <ul className="watch-rules__list">{rules.map((rule) => (
        <li key={rule.id} className={activeRuleIds.includes(rule.id) ? "is-active" : ""}>
          <label className="settings-switch watch-rules__switch"><input type="checkbox" role="switch" aria-label={rule.applicationName} checked={rule.enabled} onChange={(event) => onChange(rules.map((candidate) => candidate.id === rule.id ? { ...candidate, enabled: event.target.checked } : candidate))} /></label>
          <ApplicationAvatar
            name={rule.applicationName}
            source={(rule.applicationId
              ? applicationById.get(rule.applicationId)
              : undefined) ?? applicationByName.get(rule.applicationName.toLocaleLowerCase())
              ? { process: ((rule.applicationId
                ? applicationById.get(rule.applicationId)
                : undefined) ?? applicationByName.get(rule.applicationName.toLocaleLowerCase()))!.iconProcess }
              : null}
            className="watch-rule-avatar"
          />
          <div><strong>{rule.applicationName}</strong><small>{t("settings:watchRules.summary", { metric: t(`settings:watchRules.metrics.${rule.metric}`), threshold: rule.threshold, unit: rule.metric === "cpu" ? "%" : rule.metric === "memory" ? "MiB" : "MiB/s", seconds: rule.durationSeconds })}</small></div>
          {activeRuleIds.includes(rule.id) ? (
            <em>{t("settings:watchRules.active")}</em>
          ) : !((rule.applicationId
            ? applicationById.has(rule.applicationId)
            : false) || applicationByName.has(rule.applicationName.toLocaleLowerCase())) ? (
            <em>{t("common:unavailable")}</em>
          ) : null}
          <button type="button" aria-label={t("settings:watchRules.remove", { name: rule.applicationName })} onClick={() => onChange(rules.filter((candidate) => candidate.id !== rule.id))}><Trash2 size={14} /></button>
        </li>
      ))}</ul> : <p className="watch-rules__empty">{t("settings:watchRules.empty")}</p>}
    </div>
  );
}

function ProductDataCategoryRow({
  category,
  icon: Icon,
  enabled,
  summary,
  receipt,
  language,
  onClear,
}: {
  category: ProductDataCategory;
  icon: SettingsIcon;
  enabled?: boolean;
  summary: ProductDataCategorySummary;
  receipt: ProductDataClearReceipt;
  language?: string;
  onClear: (category: ProductDataCategory) => Promise<boolean>;
}) {
  const { t } = useAppTranslation();
  const empty = summary.itemCount === 0 && summary.byteSize === 0;
  const status = receipt.status === "succeeded"
    ? (
        <em className="settings-data-category__receipt is-on" role="status">
          <Check size={13} />{t("settings:dataPrivacy.result.succeeded")}
        </em>
      )
    : receipt.status === "failed"
      ? (
          <em className="settings-data-category__receipt is-failed" role="alert">
            <AlertTriangle size={13} />{t("settings:dataPrivacy.result.failed")}
          </em>
        )
      : typeof enabled === "boolean"
        ? (
            <em className={enabled ? "is-on" : ""}>
              {t(`settings:dataPrivacy.status.${enabled ? "on" : "off"}`)}
            </em>
          )
        : null;

  return (
    <div className="settings-data-category">
      <span><Icon size={16} /></span>
      <p>
        <strong>{t(`settings:dataPrivacy.categories.${category}.title`)}</strong>
        <small>{t(`settings:dataPrivacy.categories.${category}.description`)}</small>
        <span className="settings-data-category__metrics">
          <span>
            {t("settings:dataPrivacy.metrics.items", {
              count: summary.itemCount,
            })}
          </span>
          <span>{formatBytes(summary.byteSize)}</span>
          <span>
            {summary.updatedAtMs
              ? t("settings:dataPrivacy.metrics.updated", {
                  time: new Date(summary.updatedAtMs).toLocaleString(language),
                })
              : t("settings:dataPrivacy.metrics.never")}
          </span>
          <span>
            {summary.retentionDays
              ? t("settings:dataPrivacy.metrics.retention", {
                  count: summary.retentionDays,
                })
              : t("settings:dataPrivacy.metrics.session")}
          </span>
        </span>
      </p>
      <div className="settings-data-category__actions">
        {status}
        <button
          className="button button--plain"
          type="button"
          disabled={empty || receipt.status === "clearing"}
          title={receipt.error ?? undefined}
          onClick={() => void onClear(category)}
        >
          {receipt.status === "clearing"
            ? <LoaderCircle className="is-spinning" size={14} />
            : <Trash2 size={14} />}
          {t(
            receipt.status === "failed"
              ? "settings:dataPrivacy.result.retry"
              : "settings:dataPrivacy.result.clear",
          )}
        </button>
      </div>
    </div>
  );
}

function BackgroundSwitch({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: SettingsIcon;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-background-option">
      <span aria-hidden="true"><Icon size={16} /></span>
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SettingsCard({
  className = "",
  section,
  icon: Icon,
  title,
  description,
  children,
}: {
  className?: string;
  section: Exclude<SettingsSection, "about">;
  icon: SettingsIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`panel settings-card ${className}`.trim()}
      data-settings-section={section}
    >
      <header>
        <span aria-hidden="true"><Icon size={17} /></span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function ThresholdSelect({
  label,
  value,
  options,
  tone,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  tone: "moderate" | "high" | "critical";
  onChange: (value: number) => void;
}) {
  return (
    <label className={`settings-threshold settings-threshold--${tone}`}>
      <span><i />{label}</span>
      <SettingsSelect
        compact
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}%</option>
        ))}
      </SettingsSelect>
    </label>
  );
}

function SettingsSelect({
  value,
  compact = false,
  onChange,
  children,
}: {
  value: string | number;
  compact?: boolean;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  children: ReactNode;
}) {
  return (
    <span className={`settings-select${compact ? " settings-select--compact" : ""}`}>
      <select value={value} onChange={onChange}>
        {children}
      </select>
      <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function ThresholdPreview({ thresholds }: { thresholds: UsageThresholds }) {
  const { t } = useAppTranslation();
  const [moderate, high, critical] = thresholds;
  return (
    <div className="settings-threshold-preview" aria-label={t("settings:thresholds.preview")}>
      <span className="is-low" style={{ flex: moderate }}>{t("settings:thresholds.low")}</span>
      <span className="is-moderate" style={{ flex: high - moderate }}>{t("settings:thresholds.moderate")}</span>
      <span className="is-high" style={{ flex: critical - high }}>{t("settings:thresholds.high")}</span>
      <span className="is-critical" style={{ flex: 100 - critical }}>{t("settings:thresholds.critical")}</span>
    </div>
  );
}
