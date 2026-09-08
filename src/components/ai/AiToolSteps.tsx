import { readCapabilityResult, type CapabilityActionIntent } from "../../capabilities/contracts";
import { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CircleStop, LoaderCircle, ShieldAlert, Wrench } from "lucide-react";
import { aiApi } from "../../ai/api";
import { aiError, type AiToolStep } from "../../ai/types";
import { Button } from "../Button";
import { AiErrorNotice } from "./AiErrorNotice";

const CapabilityResultCard = lazy(async () => ({ default: (await import("../../capabilities/CapabilityResultCard")).CapabilityResultCard }));

const toolNames = {
  get_device_status: "toolDevice",
  get_process_usage: "toolProcesses",
  get_recorded_history: "toolHistory",
  run_network_check: "toolNetwork",
  scan_disk_usage: "toolDisk",
  request_process_action: "toolProcessAction",
  request_cleanup: "toolCleanup",
} as const;

function formatResult(value: string) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

export function AiToolSteps({ steps, requestId, active, onResolved, onAction, busy = false, diskRevision, compact = false, onExpand, onResultReady }: {
  steps: AiToolStep[];
  onAction?: (stepId: string, intent: CapabilityActionIntent) => void;
  busy?: boolean;
  diskRevision?: number;
  compact?: boolean;
  onExpand?: () => void;
  onResultReady?: () => void;
  requestId: string | null;
  active: boolean;
  onResolved: () => Promise<unknown>;
}) {
  const { t } = useTranslation("ai");
  const { t: tc } = useTranslation("capabilities");
  const [clockTick, setNow] = useState(() => Date.now());
  const now = Math.max(clockTick, Date.now());
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof aiError> | null>(null);
  const consumed = useRef(new Set<string>());
  const waiting = steps.some((step) => (active && step.state === "awaiting_confirmation") || (step.actionsExpiresAt ?? 0) > now);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const resolve = async (step: AiToolStep, approved: boolean) => {
    if (!active || !requestId || consumed.current.has(step.id) || step.state !== "awaiting_confirmation" || !step.confirmation || step.confirmation.expiresAt <= Date.now()) return;
    consumed.current.add(step.id);
    setPending(step.id);
    setFailure(null);
    try {
      await aiApi.resolveToolConfirmation(requestId, step.id, approved);
      await onResolved();
    } catch (error) {
      setFailure(aiError(error));
      await onResolved().catch(() => {});
    } finally { setPending(null); }
  };
  return <div className="ai-tool-steps" aria-label={t("taskSteps")}>
    {steps.map((step) => {
      const confirming = step.state === "awaiting_confirmation";
      const running = step.state === "running";
      const enabled = active && confirming && step.confirmation && step.confirmation.expiresAt > now && !consumed.current.has(step.id);
      const result = step.result ? readCapabilityResult(step.name, step.result) : null;
      const title = toolNames[step.name as keyof typeof toolNames];
      const status = confirming ? t("toolNeedsConfirmation") : running ? t("toolRunning") : step.state === "complete" ? t("statusComplete") : step.state === "failed" ? t("statusFailed") : step.state === "cancelled" ? t("statusCancelled") : t("statusInterrupted");
      return <section key={step.id} className={`ai-tool-step ai-tool-step--${step.state}`}>
        <header>
          {confirming ? <ShieldAlert size={15} /> : running ? <LoaderCircle className="is-spinning" size={15} /> : step.state === "complete" ? <CheckCircle2 size={15} /> : <CircleStop size={15} />}
          <strong>{title ? t(title) : step.name === "analyze_quick_cleanup" ? tc("quickAnalysis") : step.name === "run_local_utility" ? tc("localUtility") : step.name === "open_application_capability" ? tc("operationForm") : t("toolUnknown")}</strong><span>{status}</span>
        </header>
        {step.confirmation && <div className="ai-tool-confirmation">
          <strong>{t(step.confirmation.action === "trash" ? "toolConfirmTrash" : step.confirmation.action === "force_kill" ? "toolConfirmKill" : "toolConfirmClose")}</strong>
          <ul>{step.confirmation.targets.map((target, index) => <li key={`${index}-${target}`}>{target}</li>)}</ul>
          <p>{t(step.confirmation.action === "trash" ? "toolTrashRisk" : "toolProcessRisk")}</p>
          {confirming && <div className="ai-toolbar">
            <Button disabled={!enabled || pending !== null} onClick={() => void resolve(step, false)}>{t("toolDecline")}</Button>
            <Button variant="danger" disabled={!enabled || pending !== null} onClick={() => void resolve(step, true)}>{t("toolApprove")}</Button>
          </div>}
          {confirming && step.confirmation.expiresAt <= now && <small>{t("toolConfirmationExpired")}</small>}
        </div>}
        {step.error && <AiErrorNotice error={step.error} context="tool" />}
        {result && <ResultBoundary key={`${step.id}-${step.result}`} fallback={<p role="alert">{t("toolResult")} · {tc("technicalDetails")}</p>}><Suspense fallback={<p role="status">{tc("loadingOperation")}</p>}><CapabilityResultCard result={result} onReady={active ? onResultReady : undefined} compact={compact} onExpand={onExpand} busy={busy} actionsEnabled={(step.actionsExpiresAt ?? 0) > now} stale={result.kind === "disk" && (diskRevision === undefined || result.sourceRevision !== diskRevision)} onAction={onAction ? (intent) => onAction(step.id, intent) : undefined} /></Suspense></ResultBoundary>}
        {step.result && <details><summary><Wrench size={12} />{result ? tc("technicalDetails") : t("toolResult")}</summary><pre>{formatResult(step.result)}</pre></details>}
      </section>;
    })}
    {failure && <AiErrorNotice error={failure} />}
  </div>;
}

class ResultBoundary extends Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
