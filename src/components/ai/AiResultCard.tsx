import { useTranslation } from "react-i18next";
import type { AiScenario, ValidatedResult } from "../../ai/types";
import { Button } from "../Button";

const sourceLabels = {
  current_status: "scenarioCurrent",
  network: "scenarioNetwork",
  history: "scenarioHistory",
} as const;
const isSourceTarget = (target: string): target is AiScenario =>
  target === "current_status" || target === "network" || target === "history";

export function AiResultCard({
  validated,
  busy,
  onOpenSource,
}: {
  validated: ValidatedResult;
  busy: boolean;
  onOpenSource?: (target: AiScenario) => void;
}) {
  const { t } = useTranslation("ai");
  const { result, evidence } = validated;
  const references = (ids: string[]) => {
    const sources = [...new Set(ids)]
      .map((id) => evidence.find((item) => item.id === id))
      .filter((item) => item !== undefined);
    if (!sources.length) return null;
    return (
      <dl className="ai-result-evidence" aria-label={t("resultLocalEvidence")}>
        {sources.map((source) => (
          <div key={source.id}>
            <dt>
              {source.id} · {source.label}
            </dt>
            <dd>
              {source.value}
              {source.unit ? ` ${source.unit}` : ""}
            </dd>
          </div>
        ))}
      </dl>
    );
  };
  const nextSteps = result.nextSteps.filter((step) =>
    isSourceTarget(step.target),
  );
  return (
    <section className="ai-result-card" aria-label={t("resultTitle")}>
      <h4>{t("resultTitle")}</h4>
      <p className="ai-muted">{t("resultEvidenceHint")}</p>
      <h5>{t("resultSummary")}</h5>
      <p>{result.summary}</p>
      {result.findings.length > 0 && (
        <>
          <h5>{t("resultFindings")}</h5>
          <ul>
            {result.findings.map((finding, index) => (
              <li key={index}>
                <strong className="ai-result-kind">
                  {t(
                    finding.kind === "observation"
                      ? "resultObservation"
                      : "resultHypothesis",
                  )}
                </strong>
                <p>{finding.statement}</p>
                {references(finding.evidenceIds)}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.unknowns.length > 0 && (
        <>
          <h5>{t("resultUnknowns")}</h5>
          <ul>
            {result.unknowns.map((unknown, index) => (
              <li key={index}>{unknown}</li>
            ))}
          </ul>
        </>
      )}
      {nextSteps.length > 0 && (
        <>
          <h5>{t("resultNextSteps")}</h5>
          <ul>
            {nextSteps.map((step, index) => (
              <li key={index}>
                {onOpenSource ? (
                  <Button
                    disabled={busy}
                    onClick={() => onOpenSource(step.target)}
                  >
                    {t(sourceLabels[step.target])}
                  </Button>
                ) : (
                  <span>{t(sourceLabels[step.target])}</span>
                )}
                {references(step.evidenceIds)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
