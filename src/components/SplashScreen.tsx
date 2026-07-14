import { useTranslation } from "react-i18next";

import brandMark from "../assets/brand-mark.png";

export function SplashScreen() {
  const { t } = useTranslation();

  return (
    <main className="splash-surface" aria-label={t("splash.title")}>
      <div className="splash-card">
        <div className="splash-aurora splash-aurora--one" />
        <div className="splash-aurora splash-aurora--two" />
        <div className="splash-orbit" aria-hidden="true">
          <i /><i /><i />
        </div>
        <div className="splash-logo" aria-hidden="true">
          <img src={brandMark} alt="" />
        </div>
        <div className="splash-copy">
          <span className="splash-eyebrow">LOCAL · PRIVATE · LIVE</span>
          <h1>StatusOrbit</h1>
          <p>{t("splash.description")}</p>
        </div>
        <div className="splash-progress" aria-hidden="true"><span /></div>
        <div className="splash-stage">
          <i />
          <span>{t("splash.connecting")}</span>
        </div>
      </div>
    </main>
  );
}
