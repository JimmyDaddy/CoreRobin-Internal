import { ArrowLeft, ArrowRight, Check, LayoutDashboard, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useAppTranslation } from "../i18n/useAppTranslation";
import { AnimatedRobin } from "./AnimatedRobin";
import { Button } from "./Button";

const STEP_ICONS = [LayoutDashboard, Sparkles, ShieldCheck] as const;
const STEP_KEYS = ["one", "two", "three"] as const;

export function FirstRunGuide({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const { t } = useAppTranslation();
  const [step, setStep] = useState(0);
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
