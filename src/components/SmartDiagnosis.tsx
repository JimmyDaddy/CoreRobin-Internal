import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleGauge,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  Network,
  Power,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useAppTranslation } from "../i18n/useAppTranslation";

import type {
  DiagnosisActionTarget,
  DiagnosisCategory,
  DiagnosisFinding,
  DiagnosisStatus,
  SmartDiagnosisResult,
} from "../diagnosis";
import { formatBytes, formatPercent, formatRate } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";
import { AnimatedRobin } from "./AnimatedRobin";

interface SmartDiagnosisProps {
  result: SmartDiagnosisResult;
  expanded: boolean;
  connectionScanLoading: boolean;
  connectionScanUnavailable: boolean;
  preparingAction: boolean;
  onToggle: () => void;
  onOpenTarget: (target: DiagnosisActionTarget) => void;
  onInspectProcess: (identity: string) => void;
  onRequestClose: (identity: string, applicationName: string) => void;
}

const STATUS_ICONS: Record<DiagnosisStatus, LucideIcon> = {
  observing: Clock3,
  healthy: CheckCircle2,
  attention: Activity,
  urgent: TriangleAlert,
};

const CATEGORY_ICONS: Record<DiagnosisCategory, LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  storage: Database,
  disk_io: HardDrive,
  network: Network,
};

export function SmartDiagnosis({
  result,
  expanded,
  connectionScanLoading,
  connectionScanUnavailable,
  preparingAction,
  onToggle,
  onOpenTarget,
  onInspectProcess,
  onRequestClose,
}: SmartDiagnosisProps) {
  const { t } = useAppTranslation();
  const StatusIcon = STATUS_ICONS[result.status];
  const remainingSeconds = Math.max(
    1,
    Math.ceil((10_000 - result.sampleSpanMs) / 1_000),
  );
  const statusSummary =
    result.status === "observing"
      ? t("diagnosis:status.observing.summary", { seconds: remainingSeconds })
      : result.status === "healthy"
        ? t("diagnosis:status.healthy.summary")
        : t(`diagnosis:status.${result.status}.summary`, {
            count: result.findings.length,
          });

  return (
    <section
      className={`smart-diagnosis smart-diagnosis--${result.status}${expanded ? " is-expanded" : ""}`}
      aria-labelledby="smart-diagnosis-title"
    >
      <div className="smart-diagnosis__hero">
        <span className="smart-diagnosis__robin" aria-hidden="true">
          <AnimatedRobin
            active={result.status === "observing" || connectionScanLoading}
            mood={result.status === "healthy" ? "normal" : result.status}
            size={88}
          />
          <span className="smart-diagnosis__status-icon">
            <StatusIcon size={14} strokeWidth={2} />
          </span>
        </span>
        <div className="smart-diagnosis__message">
          <span>{t("diagnosis:kicker")}</span>
          <h2 id="smart-diagnosis-title">
            {t(`diagnosis:status.${result.status}.title`)}
          </h2>
          <p>{statusSummary}</p>
        </div>
        <button
          className="button smart-diagnosis__toggle"
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <CircleGauge size={16} />
          {expanded ? t("diagnosis:collapse") : t("diagnosis:explain")}
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>

      {expanded ? (
        <div className="smart-diagnosis__details">
          <div className="diagnosis-checks" aria-label={t("diagnosis:checkedLabel")}>
            {result.checkedCategories.map((category) => {
              const Icon = CATEGORY_ICONS[category];
              const finding = result.findings.find(
                (candidate) => candidate.category === category,
              );
              const isWaiting = !result.baselineReady &&
                (category === "cpu" || category === "memory" || category === "disk_io" || category === "network") &&
                !finding;
              return (
                <span
                  className={`diagnosis-check${finding ? ` is-${finding.severity}` : isWaiting ? " is-waiting" : " is-clear"}`}
                  key={category}
                >
                  <Icon size={14} />
                  {t(`diagnosis:categories.${category}`)}
                  <i aria-hidden="true" />
                </span>
              );
            })}
          </div>

          {result.findings.length > 0 ? (
            <div className="diagnosis-findings">
              {result.findings.map((finding) => (
                <FindingCard
                  finding={finding}
                  key={finding.id}
                  onOpenTarget={onOpenTarget}
                  onInspectProcess={onInspectProcess}
                  onRequestClose={onRequestClose}
                  preparingAction={preparingAction}
                />
              ))}
            </div>
          ) : (
            <div className={`diagnosis-empty diagnosis-empty--${result.status}`}>
              {result.status === "observing" ? <Clock3 size={18} /> : <CheckCircle2 size={18} />}
              <div>
                <strong>{result.status === "observing"
                  ? t("diagnosis:empty.observing.title")
                  : t("diagnosis:empty.healthy.title")}</strong>
                <span>{result.status === "observing"
                  ? t("diagnosis:empty.observing.description")
                  : t("diagnosis:empty.healthy.description")}</span>
              </div>
            </div>
          )}

          {connectionScanLoading || connectionScanUnavailable ? <footer className="smart-diagnosis__footer">
            {connectionScanLoading ? (
              <small>{t("diagnosis:connectionScan.loading")}</small>
            ) : (
              <small>{t("diagnosis:connectionScan.unavailable")}</small>
            )}
          </footer> : null}
        </div>
      ) : null}
    </section>
  );
}

export default SmartDiagnosis;

interface FindingCardProps {
  finding: DiagnosisFinding;
  onOpenTarget: (target: DiagnosisActionTarget) => void;
  onInspectProcess: (identity: string) => void;
  onRequestClose: (identity: string, applicationName: string) => void;
  preparingAction: boolean;
}

function FindingCard({
  finding,
  onOpenTarget,
  onInspectProcess,
  onRequestClose,
  preparingAction,
}: FindingCardProps) {
  const { t } = useAppTranslation();
  const Icon = CATEGORY_ICONS[finding.category];
  const culprit = finding.culprit;
  const evidence = formatEvidence(finding, t);
  const culpritMetric = culprit
    ? finding.category === "memory"
      ? formatBytes(culprit.memoryBytes)
      : finding.category === "disk_io"
        ? formatRate(culprit.diskBytesPerSecond)
        : formatPercent(culprit.cpuPercent)
    : null;
  const recommendation = finding.recommendation;
  const recommendationName = recommendation.applicationName ?? culprit?.name ?? "";
  const requestClose = recommendation.kind === "request_close" &&
    recommendation.processIdentity !== null;
  const RecommendationIcon = requestClose ? Power : ScanSearch;

  const openRecommendation = () => {
    if (requestClose && recommendation.processIdentity) {
      onRequestClose(recommendation.processIdentity, recommendationName);
      return;
    }
    if (recommendation.processIdentity) {
      onInspectProcess(recommendation.processIdentity);
      return;
    }
    onOpenTarget(recommendation.target);
  };

  return (
    <article className={`diagnosis-finding is-${finding.severity}`}>
      <span className="diagnosis-finding__icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className="diagnosis-finding__body">
        <div className="diagnosis-finding__heading">
          <div>
            <span>{t(`diagnosis:severity.${finding.severity}`)}</span>
            <h3>
              {t(`diagnosis:findings.${finding.code}.title`, {
                resource: finding.resourceLabel ?? t("diagnosis:thisDisk"),
              })}
            </h3>
          </div>
          <strong>{evidence}</strong>
        </div>
        <p>{t(`diagnosis:findings.${finding.code}.description`)}</p>
        {culprit ? (
          <div className={`diagnosis-culprit${culprit.systemComponent ? " is-system" : ""}`}>
            <ApplicationAvatar
              name={culprit.name}
              source={{ process: culprit.iconProcess }}
              className="diagnosis-culprit__avatar"
            />
            <span>
              {t("diagnosis:culprit.summary", {
                name: culprit.name,
                metric: culpritMetric ?? "",
                count: culprit.processCount,
              })}
            </span>
            {culprit.systemComponent ? (
              <small><ShieldCheck size={12} />{t("diagnosis:culprit.system")}</small>
            ) : null}
          </div>
        ) : null}
        {finding.code === "high_network" ? (
          <small className="diagnosis-boundary">{t("diagnosis:networkBoundary")}</small>
        ) : null}
        <div className={`diagnosis-recommendation is-${recommendation.safety}`}>
          <span className="diagnosis-recommendation__badge">
            <RecommendationIcon size={13} />
            {t(`diagnosis:recommendations.safety.${recommendation.safety}`)}
          </span>
          <div>
            <strong>{t(`diagnosis:recommendations.${recommendation.kind}.title`, { name: recommendationName })}</strong>
            <span>{t(`diagnosis:recommendations.${recommendation.kind}.description`, { name: recommendationName })}</span>
          </div>
        </div>
        <div className="diagnosis-finding__actions">
          <button
            className={`button ${recommendation.safety === "protected" ? "button--secondary" : "button--primary"}`}
            type="button"
            disabled={requestClose && preparingAction}
            onClick={openRecommendation}
          >
            {requestClose && preparingAction ? (
              <><LoaderCircle className="is-spinning" size={14} />{t("diagnosis:recommendations.preparing")}</>
            ) : (
              <>{t(`diagnosis:recommendations.${recommendation.kind}.action`, { name: recommendationName })}<ArrowRight size={14} /></>
            )}
          </button>
          {requestClose && culprit ? (
            <button
              className="diagnosis-finding__secondary-action"
              type="button"
              onClick={() => onInspectProcess(culprit.representativeIdentity)}
            >
              {t("diagnosis:recommendations.inspectEvidence")}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function formatEvidence(
  finding: DiagnosisFinding,
  t: ReturnType<typeof useAppTranslation>["t"],
): string {
  const duration = t("diagnosis:duration", {
    seconds: Math.max(1, Math.round(finding.durationMs / 1_000)),
  });
  switch (finding.code) {
    case "sustained_cpu":
      return t("diagnosis:evidence.cpu", {
        value: formatPercent(finding.value),
        duration,
      });
    case "memory_pressure":
      return t("diagnosis:evidence.memory", {
        value: formatPercent(finding.value),
        swap: formatBytes(finding.secondaryValue ?? 0),
      });
    case "low_storage":
      return t("diagnosis:evidence.storage", {
        value: formatPercent(finding.value),
        available: formatBytes(finding.secondaryValue ?? 0),
      });
    case "busy_disk":
      return t("diagnosis:evidence.disk", {
        value: formatRate(finding.value),
        duration,
      });
    case "high_network":
      return t("diagnosis:evidence.network", {
        value: formatRate(finding.value),
        count: finding.secondaryValue ?? 0,
      });
  }
}
