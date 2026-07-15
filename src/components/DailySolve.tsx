import {
  AppWindow,
  ArrowRight,
  BatteryCharging,
  Flame,
  Gauge,
  HardDrive,
  Network,
  Rocket,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { DailyIntent } from "../dailyExperience";

interface DailySolveProps {
  onOpenIntent: (intent: DailyIntent) => void;
  onOpenApplications: () => void;
  recommendedIntent?: DailyIntent | null;
}

const PROBLEMS = [
  { id: "slow", icon: Gauge },
  { id: "heat", icon: Flame },
  { id: "battery", icon: BatteryCharging, intent: "heat" },
  { id: "space", icon: HardDrive },
  { id: "startup", icon: Rocket },
  { id: "network", icon: Network },
] as const;

export function DailySolve({
  onOpenIntent,
  onOpenApplications,
  recommendedIntent = null,
}: DailySolveProps) {
  const { t } = useTranslation();
  const orderedProblems = [...PROBLEMS].sort((left, right) => {
    const leftIntent = "intent" in left ? left.intent : left.id;
    const rightIntent = "intent" in right ? right.intent : right.id;
    return Number(rightIntent === recommendedIntent) - Number(leftIntent === recommendedIntent);
  });
  const primaryProblems = orderedProblems.slice(0, 3);
  const otherProblems = orderedProblems.slice(3);
  const renderProblem = ({ id, icon: Icon, ...problem }: (typeof PROBLEMS)[number]) => {
    const intent = ("intent" in problem ? problem.intent : id) as DailyIntent;
    return (
      <button type="button" key={id} onClick={() => onOpenIntent(intent)}>
        <span><Icon size={20} /></span>
        <div>
          {intent === recommendedIntent ? <em>{t("daily.solve.recommended")}</em> : null}
          <strong>{t(`daily.solve.${id}.title`)}</strong>
          <small>{t(`daily.solve.${id}.description`)}</small>
        </div>
        <ArrowRight size={15} />
      </button>
    );
  };
  return (
    <section className="daily-solve" aria-labelledby="daily-solve-title">
      <header className="daily-solve__hero">
        <span><Sparkles size={24} /></span>
        <div>
          <small>{t("daily.solve.kicker")}</small>
          <h1 id="daily-solve-title">{t("daily.solve.title")}</h1>
          <p>{t("daily.solve.description")}</p>
        </div>
        <button className="button button--primary" type="button" onClick={() => onOpenIntent("checkup")}>
          <ScanSearch size={16} />{t("daily.solve.checkup.title")}<ArrowRight size={14} />
        </button>
      </header>

      <div className="daily-problem-list">
        {primaryProblems.map(renderProblem)}
        <button type="button" onClick={onOpenApplications}>
          <span><AppWindow size={20} /></span>
          <div><strong>{t("daily.solve.applications.title")}</strong><small>{t("daily.solve.applications.description")}</small></div>
          <ArrowRight size={15} />
        </button>
      </div>

      <details className="daily-solve__other">
        <summary>{t("daily.solve.otherProblems")}</summary>
        <div className="daily-problem-list">{otherProblems.map(renderProblem)}</div>
      </details>
    </section>
  );
}
