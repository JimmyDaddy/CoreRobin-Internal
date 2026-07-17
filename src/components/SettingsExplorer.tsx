import { AppWindow, BellRing, ChevronDown, History, Languages, LayoutDashboard, ListTree, Network, Rocket, Timer } from "lucide-react";
import type { ChangeEventHandler, ComponentType, ReactNode } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import {
  CONNECTION_REFRESH_INTERVAL_OPTIONS,
  SYSTEM_SAMPLE_INTERVAL_OPTIONS,
  SYSTEM_SAMPLING_PRESETS,
  systemSamplingPreset,
  type AppSettings,
  type UsageThresholds,
} from "../settings";
import { HISTORY_RETENTION_OPTIONS } from "../historyStore";
import type { DesktopNotificationStatus } from "../desktopNotifications";
import type { SystemSnapshot } from "../types";
import { AboutSupport } from "./AboutSupport";
import { LocaleSelect } from "./LocaleSelect";
import { RobinIcon } from "./RobinIcon";

type SettingsIcon = ComponentType<{ size?: number | string }>;

interface SettingsExplorerProps {
  settings: AppSettings;
  notificationStatus: DesktopNotificationStatus;
  snapshot: SystemSnapshot;
  onChange: (update: Partial<Omit<AppSettings, "version">>) => void;
  onOpenOnboarding: () => void;
  onClearAllData: () => void;
}

const THRESHOLD_OPTIONS = Array.from({ length: 20 }, (_, index) =>
  Math.min(100, (index + 1) * 5),
);

export function SettingsExplorer({
  settings,
  notificationStatus,
  snapshot,
  onChange,
  onOpenOnboarding,
  onClearAllData,
}: SettingsExplorerProps) {
  const { t } = useAppTranslation();
  const [moderate, high, critical] = settings.usageThresholds;

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

      <div className="settings-grid">
        <SettingsCard
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
      </div>
      <AboutSupport
        settings={settings}
        snapshot={snapshot}
        onOpenOnboarding={onOpenOnboarding}
        onClearAllData={onClearAllData}
      />
    </section>
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
  icon: Icon,
  title,
  description,
  children,
}: {
  className?: string;
  icon: SettingsIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel settings-card ${className}`.trim()}>
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
