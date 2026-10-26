import { summarizeSleepBlockers } from "../deviceWellbeing";
import type { ApplicationImpact } from "../diagnosis";
import { useAppTranslation } from "../i18n/useAppTranslation";
import type { SensorsSnapshot } from "../types";
import "./SleepBlockerDetails.css";

export function SleepBlockerDetails({ sensors, applications, expectedNames, onToggleExpected }: {
  sensors: SensorsSnapshot;
  applications: readonly ApplicationImpact[];
  expectedNames?: ReadonlySet<string>;
  onToggleExpected?: (name: string) => void;
}) {
  const { t } = useAppTranslation();
  const blockers = summarizeSleepBlockers(sensors.sleep, applications);
  if (!sensors.sleep.available || blockers.length === 0) return null;
  return <details className="sleep-details">
    <summary>{t("wellbeing:sleepReview.details")}</summary>
    <p>{t(`wellbeing:sleepReview.power.${sensors.battery.powerSource}`)}</p>
    <ul>{blockers.map((blocker) => <li key={blocker.name}>
      <strong>{blocker.name}</strong>
      <span>{blocker.kinds.map((kind) => t(`wellbeing:sleepReview.kind.${kind}`)).join(" · ")}</span>
      {blocker.reasons.map((reason) => <p key={reason}>{reason}</p>)}
      {blocker.systemComponent ? <small>{t("wellbeing:sleep.system")}</small> : onToggleExpected ? <button className="button button--secondary" type="button" aria-pressed={expectedNames?.has(blocker.name) ?? false} onClick={() => onToggleExpected(blocker.name)}>{t(expectedNames?.has(blocker.name) ? "wellbeing:sleepReview.expected" : "wellbeing:sleepReview.markExpected")}</button> : null}
    </li>)}</ul>
    <small>{t("wellbeing:sleepReview.sessionNote")}</small>
  </details>;
}
