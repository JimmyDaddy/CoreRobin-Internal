import { BellRing, Languages, ListTree, Network, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  CONNECTION_REFRESH_INTERVAL_OPTIONS,
  SYSTEM_SAMPLE_INTERVAL_OPTIONS,
  type AppSettings,
  type UsageThresholds,
} from "../settings";

interface SettingsExplorerProps {
  settings: AppSettings;
  onChange: (update: Partial<Omit<AppSettings, "version">>) => void;
}

const THRESHOLD_OPTIONS = Array.from({ length: 20 }, (_, index) =>
  Math.min(100, (index + 1) * 5),
);

export function SettingsExplorer({
  settings,
  onChange,
}: SettingsExplorerProps) {
  const { t } = useTranslation();
  const [moderate, high, critical] = settings.usageThresholds;

  const updateThreshold = (index: number, value: number) => {
    const next = [...settings.usageThresholds] as [number, number, number];
    next[index] = value;
    onChange({ usageThresholds: next });
  };

  return (
    <section className="settings-explorer" aria-labelledby="settings-title">
      <header className="panel settings-hero">
        <span className="eyebrow">{t("settings.localPreferences")}</span>
        <h2 id="settings-title">{t("settings.title")}</h2>
        <p>{t("settings.description")}</p>
      </header>

      <div className="settings-grid">
        <SettingsCard
          icon={Languages}
          title={t("settings.language.title")}
          description={t("settings.language.description")}
        >
          <label className="settings-field">
            <span>{t("settings.language.label")}</span>
            <select
              value={settings.language}
              onChange={(event) =>
                onChange({ language: event.target.value === "en" ? "en" : "zh-CN" })
              }
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </SettingsCard>

        <SettingsCard
          icon={Timer}
          title={t("settings.sampling.title")}
          description={t("settings.sampling.description")}
        >
          <label className="settings-field">
            <span>{t("settings.sampling.system")}</span>
            <select
              value={settings.systemSampleIntervalMs}
              onChange={(event) =>
                onChange({ systemSampleIntervalMs: Number(event.target.value) })
              }
            >
              {SYSTEM_SAMPLE_INTERVAL_OPTIONS.map((interval) => (
                <option key={interval} value={interval}>
                  {t("settings.intervalMs", { interval })}
                </option>
              ))}
            </select>
          </label>
        </SettingsCard>

        <SettingsCard
          icon={Network}
          title={t("settings.connections.title")}
          description={t("settings.connections.description")}
        >
          <label className="settings-field">
            <span>{t("settings.connections.refresh")}</span>
            <select
              value={settings.connectionRefreshIntervalMs}
              onChange={(event) =>
                onChange({ connectionRefreshIntervalMs: Number(event.target.value) })
              }
            >
              {CONNECTION_REFRESH_INTERVAL_OPTIONS.map((interval) => (
                <option key={interval} value={interval}>
                  {t("settings.intervalSeconds", { seconds: interval / 1_000 })}
                </option>
              ))}
            </select>
          </label>
        </SettingsCard>

        <SettingsCard
          icon={ListTree}
          title={t("settings.processView.title")}
          description={t("settings.processView.description")}
        >
          <div className="settings-segmented" role="group" aria-label={t("settings.processView.label")}>
            {(["flat", "tree"] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                className={settings.defaultProcessView === mode ? "is-active" : ""}
                aria-pressed={settings.defaultProcessView === mode}
                onClick={() => onChange({ defaultProcessView: mode })}
              >
                {t(`process.${mode}`)}
              </button>
            ))}
          </div>
        </SettingsCard>

        <SettingsCard
          className="settings-card--thresholds"
          icon={BellRing}
          title={t("settings.thresholds.title")}
          description={t("settings.thresholds.description")}
        >
          <div className="settings-thresholds">
            <ThresholdSelect
              label={t("settings.thresholds.moderate")}
              value={moderate}
              options={THRESHOLD_OPTIONS.filter((value) => value < high)}
              tone="moderate"
              onChange={(value) => updateThreshold(0, value)}
            />
            <ThresholdSelect
              label={t("settings.thresholds.high")}
              value={high}
              options={THRESHOLD_OPTIONS.filter(
                (value) => value > moderate && value < critical,
              )}
              tone="high"
              onChange={(value) => updateThreshold(1, value)}
            />
            <ThresholdSelect
              label={t("settings.thresholds.critical")}
              value={critical}
              options={THRESHOLD_OPTIONS.filter((value) => value > high)}
              tone="critical"
              onChange={(value) => updateThreshold(2, value)}
            />
          </div>
          <ThresholdPreview thresholds={settings.usageThresholds} />
        </SettingsCard>
      </div>
    </section>
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
  icon: typeof Languages;
  title: string;
  description: string;
  children: React.ReactNode;
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
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((option) => (
          <option key={option} value={option}>{option}%</option>
        ))}
      </select>
    </label>
  );
}

function ThresholdPreview({ thresholds }: { thresholds: UsageThresholds }) {
  const { t } = useTranslation();
  const [moderate, high, critical] = thresholds;
  return (
    <div className="settings-threshold-preview" aria-label={t("settings.thresholds.preview")}>
      <span className="is-low" style={{ flex: moderate }}>{t("settings.thresholds.low")}</span>
      <span className="is-moderate" style={{ flex: high - moderate }}>{t("settings.thresholds.moderate")}</span>
      <span className="is-high" style={{ flex: critical - high }}>{t("settings.thresholds.high")}</span>
      <span className="is-critical" style={{ flex: 100 - critical }}>{t("settings.thresholds.critical")}</span>
    </div>
  );
}
