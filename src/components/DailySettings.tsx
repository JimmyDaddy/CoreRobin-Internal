import {
  AppWindow,
  BellRing,
  History,
  Languages,
  Rocket,
  Settings2,
  Type,
  WandSparkles,
} from "lucide-react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import type { DesktopNotificationStatus } from "../desktopNotifications";
import type { AppSettings } from "../settings";
import type { SystemSnapshot } from "../types";
import { AboutSupport } from "./AboutSupport";
import { LocaleSelect } from "./LocaleSelect";
import { RobinIcon } from "./RobinIcon";

interface DailySettingsProps {
  settings: AppSettings;
  notificationStatus: DesktopNotificationStatus;
  snapshot: SystemSnapshot;
  onChange: (update: Partial<Omit<AppSettings, "version">>) => void;
  onOpenOnboarding: () => void;
  onClearAllData: () => void;
}

export function DailySettings({
  settings,
  notificationStatus,
  snapshot,
  onChange,
  onOpenOnboarding,
  onClearAllData,
}: DailySettingsProps) {
  const { t } = useAppTranslation();
  return (
    <section className="daily-settings" aria-labelledby="daily-settings-title">
      <header className="daily-settings__hero">
        <span><Settings2 size={23} /></span>
        <div><small>{t("daily:settings.kicker")}</small><h1 id="daily-settings-title">{t("daily:settings.title")}</h1><p>{t("daily:settings.description")}</p></div>
      </header>

      <div className="daily-settings__list">
        <section>
          <span><Languages size={19} /></span>
          <div><strong>{t("daily:settings.language")}</strong><small>{t("daily:settings.languageDescription")}</small></div>
          <LocaleSelect
            className="daily-settings__locale"
            value={settings.language}
            label={t("daily:settings.language")}
            onChange={(language) => onChange({ language })}
          />
        </section>

        <section>
          <span><BellRing size={19} /></span>
          <div><strong>{t("daily:settings.notifications")}</strong><small>{t(`daily:settings.notificationStatus.${notificationStatus}`)}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.notifications")} checked={settings.desktopNotificationsEnabled} onChange={(event) => onChange({ desktopNotificationsEnabled: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><History size={19} /></span>
          <div><strong>{t("daily:settings.history")}</strong><small>{t("daily:settings.historyDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.history")} checked={settings.historyPersistenceEnabled} onChange={(event) => onChange({ historyPersistenceEnabled: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><Type size={19} /></span>
          <div><strong>{t("daily:settings.textSize")}</strong><small>{t("daily:settings.textSizeDescription")}</small></div>
          <div className="daily-settings__segmented" role="group" aria-label={t("daily:settings.textSize")}>
            {(["comfortable", "large"] as const).map((interfaceScale) => (
              <button type="button" key={interfaceScale} className={settings.interfaceScale === interfaceScale ? "is-active" : ""} onClick={() => onChange({ interfaceScale })}>
                {t(`daily:settings.textSizeOptions.${interfaceScale}`)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <span><WandSparkles size={19} /></span>
          <div><strong>{t("daily:settings.reduceMotion")}</strong><small>{t("daily:settings.reduceMotionDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.reduceMotion")} checked={settings.reduceMotion} onChange={(event) => onChange({ reduceMotion: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><AppWindow size={19} /></span>
          <div><strong>{t("daily:settings.showDockIcon")}</strong><small>{t("daily:settings.showDockIconDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.showDockIcon")} checked={settings.showDockIcon} onChange={(event) => onChange({ showDockIcon: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><Rocket size={19} /></span>
          <div><strong>{t("daily:settings.launchAtLogin")}</strong><small>{t("daily:settings.launchAtLoginDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.launchAtLogin")} checked={settings.launchAtLogin} onChange={(event) => onChange({ launchAtLogin: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><RobinIcon size={22} /></span>
          <div><strong>{t("daily:settings.companionAlwaysOnTop")}</strong><small>{t("daily:settings.companionAlwaysOnTopDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.companionAlwaysOnTop")} checked={settings.companionAlwaysOnTop} onChange={(event) => onChange({ companionAlwaysOnTop: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><RobinIcon size={22} /></span>
          <div><strong>{t("daily:settings.companionShowOnStartup")}</strong><small>{t("daily:settings.companionShowOnStartupDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily:settings.companionShowOnStartup")} checked={settings.companionShowOnStartup} onChange={(event) => onChange({ companionShowOnStartup: event.target.checked })} />
            <i />
          </label>
        </section>
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
