import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  HardDrive,
  LayoutDashboard,
  MonitorDot,
  Rocket,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { openCleanupFullDiskAccessSettings } from "../api";
import type { DesktopNotificationStatus } from "../desktopNotifications";
import { useCleanupScanAccess } from "../hooks/useCleanupScanAccess";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { AppSettings } from "../settings";
import { AnimatedRobin } from "./AnimatedRobin";
import { Button } from "./Button";

const STEP_ICONS = [LayoutDashboard, Sparkles, ShieldCheck] as const;
const STEP_KEYS = ["one", "two", "three"] as const;

export function FirstRunGuide({
  onComplete,
  settings,
  notificationStatus,
  onChange,
  onOpenNotificationSettings,
}: {
  onComplete: () => void;
  settings: AppSettings;
  notificationStatus: DesktopNotificationStatus;
  onChange: (patch: Partial<AppSettings>) => void;
  onOpenNotificationSettings: () => void;
}) {
  const { t } = useAppTranslation();
  const [step, setStep] = useState(0);
  const { access: cleanupAccess } = useCleanupScanAccess(step === 2);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const lastStep = step === STEP_ICONS.length - 1;
  const Icon = STEP_ICONS[step]!;
  const stepKey = STEP_KEYS[step]!;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onComplete();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onComplete]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="first-run-guide" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
      <div className="first-run-guide__backdrop" />
      <section ref={panelRef} className="first-run-guide__panel" onKeyDown={trapFocus}>
        <button className="first-run-guide__close" type="button" aria-label={t("settings:onboarding.skip")} onClick={onComplete}><X size={18} /></button>
        <div className="first-run-guide__visual" aria-hidden="true">
          <AnimatedRobin active mood="normal" size={142} />
          <span><Icon size={22} /></span>
        </div>
        <div className="first-run-guide__content">
          <span className="eyebrow">{t("settings:onboarding.kicker", { current: step + 1, total: STEP_ICONS.length })}</span>
          <h1 id="first-run-title" ref={headingRef} tabIndex={-1}>{t(`settings:onboarding.steps.${stepKey}.title`)}</h1>
          <p>{t(`settings:onboarding.steps.${stepKey}.description`)}</p>
          {step === 0 ? (
            <div className="first-run-guide__choices" role="radiogroup" aria-label={t("settings:onboarding.controls.mode")}>
              <button
                type="button"
                role="radio"
                aria-checked={settings.experienceMode === "simple"}
                className={settings.experienceMode === "simple" ? "is-active" : ""}
                onClick={() => onChange({ experienceMode: "simple" })}
              >
                <Sparkles size={17} />
                <span><strong>{t("app:mode.simple")}</strong><small>{t("settings:onboarding.controls.everyday")}</small></span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={settings.experienceMode === "professional"}
                className={settings.experienceMode === "professional" ? "is-active" : ""}
                onClick={() => onChange({ experienceMode: "professional" })}
              >
                <LayoutDashboard size={17} />
                <span><strong>{t("app:mode.professional")}</strong><small>{t("settings:onboarding.controls.professional")}</small></span>
              </button>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="first-run-guide__toggles">
              <OnboardingToggle
                icon={MonitorDot}
                label={t("settings:background.showDockIcon")}
                checked={settings.showDockIcon}
                onChange={(showDockIcon) => onChange({ showDockIcon })}
              />
              <OnboardingToggle
                icon={Rocket}
                label={t("settings:background.launchAtLogin")}
                checked={settings.launchAtLogin}
                onChange={(launchAtLogin) => onChange({ launchAtLogin })}
              />
              <OnboardingToggle
                icon={Sparkles}
                label={t("settings:background.companionShowOnStartup")}
                checked={settings.companionShowOnStartup}
                onChange={(companionShowOnStartup) => onChange({ companionShowOnStartup })}
              />
            </div>
          ) : null}
          {step === 2 ? (
            <div className="first-run-guide__permissions">
              <label>
                <span><Bell size={16} /><strong>{t("settings:notifications.enable")}</strong></span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.desktopNotificationsEnabled}
                  onChange={(event) => onChange({ desktopNotificationsEnabled: event.target.checked })}
                />
              </label>
              {notificationStatus === "denied" ? (
                <button type="button" onClick={onOpenNotificationSettings}>
                  {t("settings:notifications.openSettings")}
                </button>
              ) : null}
              <div>
                <span><HardDrive size={16} /><strong>{t("settings:onboarding.controls.diskAccess")}</strong></span>
                <em className={cleanupAccess?.fullDiskAccess === "granted" ? "is-ready" : ""}>
                  {t(`settings:onboarding.controls.diskAccessStatus.${cleanupAccess?.fullDiskAccess ?? "unknown"}`)}
                </em>
              </div>
              {cleanupAccess?.fullDiskAccessRecommended && cleanupAccess.fullDiskAccess !== "granted" ? (
                <button type="button" onClick={() => void openCleanupFullDiskAccessSettings()}>
                  {t("settings:onboarding.controls.openDiskAccess")}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="first-run-guide__note"><ShieldCheck size={15} />{t(`settings:onboarding.steps.${stepKey}.note`)}</div>
          <div className="first-run-guide__dots" aria-hidden="true">
            {STEP_ICONS.map((_, index) => <i key={index} className={index === step ? "is-active" : ""} />)}
          </div>
          <div className="first-run-guide__actions">
            <button type="button" onClick={onComplete}>{t("settings:onboarding.skip")}</button>
            <span>
              {step > 0 ? <Button variant="secondary" onClick={() => setStep((current) => current - 1)}><ArrowLeft size={15} />{t("settings:onboarding.back")}</Button> : null}
              <Button variant="primary" onClick={() => lastStep ? onComplete() : setStep((current) => current + 1)}>
                {lastStep ? <Check size={15} /> : null}{t(lastStep ? "settings:onboarding.finish" : "settings:onboarding.next")}{lastStep ? null : <ArrowRight size={15} />}
              </Button>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function OnboardingToggle({
  icon: Icon,
  label,
  checked,
  onChange,
}: {
  icon: typeof Sparkles;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label>
      <span><Icon size={16} />{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
