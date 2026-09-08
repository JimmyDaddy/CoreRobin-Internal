import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { CapabilityActionIntent, CapabilityResult } from "./contracts";
import { ProcessActionButtons } from "./ProcessActionButtons";
import { DiskUsageCard } from "./DiskUsageCard";
import { NetworkDiagnosticList } from "./NetworkDiagnosticList";
import { CapabilityFormCard } from "./CapabilityFormCard";
import { HistoryObservations } from "./HistoryObservations";
import { formatBytes, formatPercent } from "../utils";
import "./capabilities.css";

export function CapabilityResultCard({ result, actionsEnabled, busy, stale = false, onAction, compact = false, onExpand, onReady }: {
  result: CapabilityResult;
  actionsEnabled: boolean;
  busy: boolean;
  stale?: boolean;
  onAction?: (intent: CapabilityActionIntent) => void;
  compact?: boolean;
  onExpand?: () => void;
  onReady?: () => void;
}) {
  const { t, i18n } = useTranslation("capabilities");
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => { onReady?.(); }, [onReady]);
  const readonly = result.kind !== "cleanup" && result.kind !== "process_action" && result.kind !== "form";
  const canAct = actionsEnabled && !busy && !stale && Boolean(onAction);
  return <div className={`capability-result capability-result--${result.kind}`}>
    {result.kind === "form" && <CapabilityFormCard capabilityId={result.capabilityId} analysis={result.analysis} utilityOutput={result.utilityOutput} outputTruncated={result.outputTruncated} compact={compact} busy={busy} onExpand={onExpand} />}
    {"sampledAt" in result && result.sampledAt > 0 && <div className="capability-result-meta"><span>{t("snapshot")}</span><time dateTime={new Date(result.sampledAt).toISOString()}>{t("sampledAt", { time: new Date(result.sampledAt).toLocaleString(i18n.resolvedLanguage) })}</time></div>}
    {result.kind === "device" && <>
      <dl className="capability-metrics">
        <div><dt>CPU</dt><dd>{formatPercent(result.cpuPercent)}</dd></div>
        <div><dt>{t("memory")}</dt><dd>{formatBytes(result.memoryUsed)} / {formatBytes(result.memoryTotal)}</dd></div>
        <div><dt>{t("available")}</dt><dd>{formatBytes(result.memoryAvailable)}</dd></div>
        <div><dt>{t("temperature")}</dt><dd>{result.temperature === null ? "—" : `${result.temperature.toFixed(1)} °C`}</dd></div>
      </dl>
      <ul className="capability-volume-list">{result.volumes.map((volume, index) => <li key={`${index}-${volume.name}`}><strong>{volume.name}</strong><span>{t("available")} {formatBytes(volume.availableBytes)} / {formatBytes(volume.totalBytes)}</span></li>)}</ul>
    </>}
    {result.kind === "processes" && <>
      <p className="capability-hint">{t("processScope")}</p>
      <ul className="capability-process-list">{result.items.slice(0, expanded ? 10 : 5).map((item) => <li key={`${item.pid}-${item.targetRef}`}>
        <div className="capability-item-identity"><strong>{item.name}</strong><small>PID {item.pid}</small></div>
        <div className="capability-item-values"><span>CPU {formatPercent(item.cpuPercent)}</span><span>{formatBytes(item.memoryBytes)}</span></div>
        <div className="capability-item-actions"><ProcessActionButtons requestCloseEnabled={canAct && !item.protected && Boolean(item.targetRef)} forceKillEnabled={canAct && !item.protected && Boolean(item.targetRef)} busy={busy} onAction={(action) => { if (item.targetRef) onAction?.({ action, targetRefs: [item.targetRef] }); }} /></div>
      </li>)}</ul>
      {!expanded && result.items.length > 5 && <button type="button" className="button button--plain" onClick={() => setExpanded(true)}>{t("showMore", { count: result.items.length - 5 })}</button>}
      {!actionsEnabled && <p className="capability-hint">{t("expired")}</p>}
    </>}
    {result.kind === "disk" && <DiskUsageCard key={JSON.stringify([result.scanId, result.sourceRevision, result.sampledAt, result.items.map((item) => item.targetRef)])} result={result} canAct={canAct} stale={stale} actionsEnabled={actionsEnabled} onAction={onAction} />}
    {result.kind === "network" && <><NetworkDiagnosticList diagnostics={result.diagnostics} /><dl className="capability-metrics"><div><dt>{t("latency")}</dt><dd>{result.averageLatencyMs === null ? "—" : `${result.averageLatencyMs.toFixed(0)} ms`}</dd></div><div><dt>{t("probeFailure")}</dt><dd>{formatPercent(result.tcpProbeFailurePercent)}</dd></div></dl></>}
    {result.kind === "observations" && <HistoryObservations result={result} />}
    {result.kind === "cleanup" && <><strong>{t("moved", { count: result.deleted.length })}</strong><ul>{result.deleted.map((item, index) => <li key={index}>{item.name} · {formatBytes(item.deletedBytes)}</li>)}</ul>{result.failed.length > 0 && <p className="capability-warning">{t("failed", { count: result.failed.length })}: {result.failed.map((item) => item.name).join("、")}</p>}{result.cancelled && <p>{t("cancelled")}</p>}{!result.indexUpdated && <p className="capability-warning">{t("stale")}</p>}<p className="capability-hint">{t("diskScope")}</p></>}
    {result.kind === "process_action" && <><strong>{t(result.outcome === "exited" ? "processExited" : result.outcome === "already_exited" ? "processAlreadyExited" : "processStillRunning")}</strong><p className="capability-hint">{t("processActionNotice")}</p></>}
    {readonly && onAction && <div className="capability-actions"><button type="button" className="button button--secondary" disabled={busy} onClick={() => onAction({ action: "refresh", targetRefs: [] })}><RefreshCw size={14} />{t("refresh")}</button></div>}
  </div>;
}
