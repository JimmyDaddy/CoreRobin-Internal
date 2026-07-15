import {
  BellRing,
  History,
  Languages,
  Orbit,
  Settings2,
  Type,
  WandSparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { DesktopNotificationStatus } from "../desktopNotifications";
import type { AppSettings } from "../settings";

interface DailySettingsProps {
  settings: AppSettings;
  notificationStatus: DesktopNotificationStatus;
  onChange: (update: Partial<Omit<AppSettings, "version">>) => void;
}

export function DailySettings({
  settings,
  notificationStatus,
  onChange,
}: DailySettingsProps) {
  const { t } = useTranslation();
  return (
    <section className="daily-settings" aria-labelledby="daily-settings-title">
      <header className="daily-settings__hero">
        <span><Settings2 size={23} /></span>
        <div><small>{t("daily.settings.kicker")}</small><h1 id="daily-settings-title">{t("daily.settings.title")}</h1><p>{t("daily.settings.description")}</p></div>
      </header>

      <div className="daily-settings__list">
        <section>
          <span><Languages size={19} /></span>
          <div><strong>{t("daily.settings.language")}</strong><small>{t("daily.settings.languageDescription")}</small></div>
          <div className="daily-settings__segmented" role="group" aria-label={t("daily.settings.language")}>
            {(["zh-CN", "en"] as const).map((language) => (
              <button type="button" key={language} className={settings.language === language ? "is-active" : ""} onClick={() => onChange({ language })}>
                {language === "en" ? "English" : "简体中文"}
              </button>
            ))}
          </div>
        </section>

        <section>
          <span><BellRing size={19} /></span>
          <div><strong>{t("daily.settings.notifications")}</strong><small>{t(`daily.settings.notificationStatus.${notificationStatus}`)}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily.settings.notifications")} checked={settings.desktopNotificationsEnabled} onChange={(event) => onChange({ desktopNotificationsEnabled: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><History size={19} /></span>
          <div><strong>{t("daily.settings.history")}</strong><small>{t("daily.settings.historyDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily.settings.history")} checked={settings.historyPersistenceEnabled} onChange={(event) => onChange({ historyPersistenceEnabled: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><Type size={19} /></span>
          <div><strong>{t("daily.settings.textSize")}</strong><small>{t("daily.settings.textSizeDescription")}</small></div>
          <div className="daily-settings__segmented" role="group" aria-label={t("daily.settings.textSize")}>
            {(["comfortable", "large"] as const).map((interfaceScale) => (
              <button type="button" key={interfaceScale} className={settings.interfaceScale === interfaceScale ? "is-active" : ""} onClick={() => onChange({ interfaceScale })}>
                {t(`daily.settings.textSizeOptions.${interfaceScale}`)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <span><WandSparkles size={19} /></span>
          <div><strong>{t("daily.settings.reduceMotion")}</strong><small>{t("daily.settings.reduceMotionDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily.settings.reduceMotion")} checked={settings.reduceMotion} onChange={(event) => onChange({ reduceMotion: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><Orbit size={19} /></span>
          <div><strong>{t("daily.settings.companionAlwaysOnTop")}</strong><small>{t("daily.settings.companionAlwaysOnTopDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily.settings.companionAlwaysOnTop")} checked={settings.companionAlwaysOnTop} onChange={(event) => onChange({ companionAlwaysOnTop: event.target.checked })} />
            <i />
          </label>
        </section>

        <section>
          <span><Orbit size={19} /></span>
          <div><strong>{t("daily.settings.companionShowOnStartup")}</strong><small>{t("daily.settings.companionShowOnStartupDescription")}</small></div>
          <label className="daily-settings__switch">
            <input type="checkbox" role="switch" aria-label={t("daily.settings.companionShowOnStartup")} checked={settings.companionShowOnStartup} onChange={(event) => onChange({ companionShowOnStartup: event.target.checked })} />
            <i />
          </label>
        </section>
      </div>

    </section>
  );
}
