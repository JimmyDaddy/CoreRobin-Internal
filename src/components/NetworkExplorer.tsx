import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Globe2,
  MinusCircle,
  Network,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";
import "./NetworkExplorer.css";
import { processApplicationIconSource } from "../applicationIcon";

import {
  filterNetworkConnections,
  formatNetworkEndpoint,
  indexNetworkProcesses,
  networkHistorySegments,
  networkHistoryWindow,
  resolveNetworkConnectionOwners,
  visibleNetworkInterfaces,
  type NetworkConnectionFilter,
  type NetworkProcessIndex,
  type NetworkSeriesPoint,
} from "../networkExplorer";
import { runNetworkQualityCheck } from "../api";
import {
  aggregateConnectionHistory,
  type ConnectionHistoryEntry,
  type ConnectionHistoryGroupBy,
} from "../connectionHistory";
import type {
  CommandError,
  HistoryPoint,
  NetworkConnection,
  NetworkConnectionsSnapshot,
  NetworkInterfaceSnapshot,
  NetworkSnapshot,
  NetworkQualityResult,
  ProcessRow,
} from "../types";
import { formatBytes, formatRate, normalizeCommandError } from "../utils";
import { ApplicationAvatar } from "./ApplicationAvatar";

interface NetworkExplorerProps {
  network: NetworkSnapshot;
  history: HistoryPoint[];
  connections: NetworkConnectionsSnapshot | null;
  connectionsError: CommandError | null;
  connectionsLoading: boolean;
  onRefreshConnections: () => void;
  connectionRefreshIntervalMs: number;
  processes: ProcessRow[];
  onSelectProcess: (process: ProcessRow) => void;
  connectionHistoryEnabled: boolean;
  connectionHistoryRetentionDays: 1 | 7 | 30;
  onConnectionHistoryChange: (enabled: boolean) => void;
  onConnectionHistoryRetentionChange: (days: 1 | 7 | 30) => void;
  connectionHistoryEntries: ConnectionHistoryEntry[];
  connectionHistoryError: string | null;
  onClearConnectionHistory: () => void;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 176;
const CHART_TOP = 12;
const CHART_BOTTOM = 148;
const CONNECTION_PAGE_SIZE = 100;
export const NETWORK_QUALITY_REFRESH_MS = 30 * 1_000;
export const NETWORK_QUALITY_WINDOW_MS = 15 * 60 * 1_000;
const NETWORK_QUALITY_MAX_POINTS = NETWORK_QUALITY_WINDOW_MS / NETWORK_QUALITY_REFRESH_MS + 1;
const QUALITY_CHART_WIDTH = 720;
const QUALITY_CHART_HEIGHT = 148;
const QUALITY_CHART_LEFT = 16;
const QUALITY_CHART_RIGHT = 704;
const QUALITY_CHART_TOP = 12;
const QUALITY_CHART_BOTTOM = 126;

const CONNECTION_FILTERS: NetworkConnectionFilter[] = [
  "all",
  "established",
  "listen",
  "tcp",
  "udp",
];

type NetworkSection = "quality" | "connections" | "history" | "interfaces";
let qualitySessionResult: NetworkQualityResult | null = null;
let qualitySessionSamples: NetworkQualityResult[] = [];

export function resetNetworkQualitySessionForTest(): void {
  qualitySessionResult = null;
  qualitySessionSamples = [];
}

export function NetworkExplorer({
  network,
  history,
  connections,
  connectionsError,
  connectionsLoading,
  onRefreshConnections,
  connectionRefreshIntervalMs,
  processes,
  onSelectProcess,
  connectionHistoryEnabled,
  connectionHistoryRetentionDays,
  onConnectionHistoryChange,
  onConnectionHistoryRetentionChange,
  connectionHistoryEntries,
  connectionHistoryError,
  onClearConnectionHistory,
}: NetworkExplorerProps) {
  const { t } = useAppTranslation();
  const [showAllInterfaces, setShowAllInterfaces] = useState(false);
  const [activeSection, setActiveSection] =
    useState<NetworkSection>("quality");
  const visible = useMemo(
    () => visibleNetworkInterfaces(network.interfaces, showAllInterfaces),
    [network.interfaces, showAllInterfaces],
  );
  const connectedCount = network.interfaces.filter(
    ({ operationalState }) => operationalState === "up",
  ).length;
  const sessionTotal =
    network.receivedBytesSinceLaunch + network.transmittedBytesSinceLaunch;

  return (
    <section className="network-explorer" aria-labelledby="network-title">
      <section className="panel network-overview">
        <header className="network-overview__heading">
          <div>
            <span className="eyebrow">{t("network:local")}</span>
            <h2 id="network-title">{t("network:title")}</h2>
            <p>{t("network:description")}</p>
          </div>
          <span className="network-overview__badge">
            <Network size={14} />
            {t("network:connectedInterfaces", { connected: connectedCount, total: network.interfaceCount })}
          </span>
        </header>

        <div className="network-summary" aria-label={t("network:summary")}>
          <NetworkSummaryItem
            icon={ArrowDownToLine}
            label={t("network:receiveNow")}
            value={formatRate(network.receivedBytesPerSecond)}
            tone="received"
          />
          <NetworkSummaryItem
            icon={ArrowUpFromLine}
            label={t("network:sendNow")}
            value={formatRate(network.transmittedBytesPerSecond)}
            tone="transmitted"
          />
          <NetworkSummaryItem
            icon={Activity}
            label={t("network:sessionTotal")}
            value={formatBytes(sessionTotal)}
            context={t("network:sessionContext", {
              receive: formatBytes(network.receivedBytesSinceLaunch),
              send: formatBytes(network.transmittedBytesSinceLaunch),
            })}
            tone="session"
          />
        </div>
      </section>

      <nav className="network-section-tabs" aria-label={t("network:title")}>
        {(["quality", "connections", "history", "interfaces"] as const).map(
          (section) => (
            <button
              className={activeSection === section ? "is-active" : undefined}
              type="button"
              key={section}
              aria-current={activeSection === section ? "page" : undefined}
              onClick={() => setActiveSection(section)}
            >
              {t(
                section === "quality"
                  ? "network:quality.title"
                  : section === "connections"
                    ? "network:connections.title"
                    : section === "history"
                      ? "network:history.title"
                      : "network:interfaces",
              )}
            </button>
          ),
        )}
      </nav>

      {activeSection === "quality" ? (
        <>
          <NetworkQualityPanel />
          <NetworkThroughput history={history} network={network} />
        </>
      ) : null}

      {activeSection === "connections" ? (
        <NetworkConnectionsPanel
          snapshot={connections}
          error={connectionsError}
          loading={connectionsLoading}
          onRefresh={onRefreshConnections}
          refreshIntervalMs={connectionRefreshIntervalMs}
          processes={processes}
          onSelectProcess={onSelectProcess}
        />
      ) : null}

      {activeSection === "history" ? (
        <ConnectionHistoryPanel
          entries={connectionHistoryEntries}
          error={connectionHistoryError}
          enabled={connectionHistoryEnabled}
          retentionDays={connectionHistoryRetentionDays}
          onEnabledChange={onConnectionHistoryChange}
          onRetentionChange={onConnectionHistoryRetentionChange}
          onClear={onClearConnectionHistory}
        />
      ) : null}

      {activeSection === "interfaces" ? (
        <section className="panel network-interface-panel" aria-labelledby="interface-title">
        <header className="network-section-heading">
          <div>
            <span className="eyebrow">{t("network:interfaces")}</span>
            <h2 id="interface-title">{t("network:interfaceActivity")}</h2>
          </div>
          {visible.hiddenCount > 0 || showAllInterfaces ? (
            <button
              className="network-interface-toggle"
              type="button"
              aria-expanded={showAllInterfaces}
              onClick={() => setShowAllInterfaces((current) => !current)}
            >
              {showAllInterfaces ? (
                <><ChevronUp size={13} />{t("network:collapseUnused")}</>
              ) : (
                <><ChevronDown size={13} />{t("network:showOtherInterfaces", { count: visible.hiddenCount })}</>
              )}
            </button>
          ) : (
            <span>{t("network:sortedByTraffic")}</span>
          )}
        </header>

        {visible.interfaces.length > 0 ? (
          <ul className="network-interface-list">
            {visible.interfaces.map((networkInterface) => (
              <NetworkInterfaceRow
                key={networkInterface.name}
                networkInterface={networkInterface}
              />
            ))}
          </ul>
        ) : (
          <div className="network-empty">
            <Network size={20} />{t("network:noInterfaces")}
          </div>
        )}
        </section>
      ) : null}
    </section>
  );
}

export function appendNetworkQualitySample(
  samples: readonly NetworkQualityResult[],
  sample: NetworkQualityResult,
): NetworkQualityResult[] {
  const cutoff = sample.sampledAtMs - NETWORK_QUALITY_WINDOW_MS;
  return samples
    .filter((candidate) => candidate.sampledAtMs >= cutoff && candidate.sampledAtMs !== sample.sampledAtMs)
    .concat(sample)
    .sort((left, right) => left.sampledAtMs - right.sampledAtMs)
    .slice(-NETWORK_QUALITY_MAX_POINTS);
}

export function NetworkQualityPanel() {
  const { t, i18n } = useAppTranslation();
  const [result, setResult] = useState<NetworkQualityResult | null>(
    () => qualitySessionResult,
  );
  const [samples, setSamples] = useState<NetworkQualityResult[]>(() => {
    const cutoff = Date.now() - NETWORK_QUALITY_WINDOW_MS;
    qualitySessionSamples = qualitySessionSamples.filter(
      (sample) => sample.sampledAtMs >= cutoff,
    );
    return qualitySessionSamples;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkingRef = useRef(false);
  const mountedRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const nextResult = await runNetworkQualityCheck();
      if (!mountedRef.current) return;
      qualitySessionResult = nextResult;
      setResult(nextResult);
      setSamples((current) => {
        const next = appendNetworkQualitySample(current, nextResult);
        qualitySessionSamples = next;
        return next;
      });
    } catch (reason) {
      if (mountedRef.current) setError(normalizeCommandError(reason).message);
    } finally {
      checkingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void runCheck();
    const interval = window.setInterval(() => void runCheck(), NETWORK_QUALITY_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
    };
  }, [runCheck]);

  return (
    <section className="panel network-quality" aria-labelledby="network-quality-title">
      <header className="network-section-heading">
        <div>
          <span className="eyebrow">{t("network:quality.eyebrow")}</span>
          <h2 id="network-quality-title">{t("network:quality.title")}</h2>
          <p>{t("network:quality.description")}</p>
        </div>
        <button className="button button--secondary" type="button" disabled={loading} onClick={() => void runCheck()}>
          <RefreshCw size={14} className={loading ? "is-spinning" : ""} />
          {loading ? t("network:quality.checking") : t("network:quality.run")}
        </button>
      </header>
      {error ? <div className="network-connections__notice is-error" role="alert">{error}</div> : null}
      {result ? (
        <>
          <div className="network-quality__results" aria-live="polite">
            <div className={`network-quality__status is-${result.status}`}>
              <Globe2 size={20} />
              <span>{t(`network:quality.status.${result.status}`)}</span>
              <small>{new Date(result.sampledAtMs).toLocaleTimeString(i18n.resolvedLanguage, { hour12: false })}</small>
            </div>
            <QualityMetric label={t("network:quality.dns")} value={result.dnsLookupMs === null ? t("common:unavailable") : `${result.dnsLookupMs} ms`} />
            <QualityMetric label={t("network:quality.latency")} value={formatMilliseconds(result.averageLatencyMs)} />
            <QualityMetric label={t("network:quality.jitter")} value={formatMilliseconds(result.jitterMs)} />
            <QualityMetric
              label={t("network:quality.probes")}
              value={t("network:quality.probeSuccess", {
                successful: result.successfulProbeCount,
                total: result.probeCount,
              })}
            />
          </div>
          <div className="network-quality__diagnostics" aria-label={t("network:quality.diagnostics.title")}>
            {result.diagnostics.map((diagnostic) => {
              const StatusIcon = diagnostic.status === "passed"
                ? CheckCircle2
                : diagnostic.status === "failed"
                  ? XCircle
                  : MinusCircle;
              return (
                <div className={`is-${diagnostic.status}`} key={diagnostic.kind}>
                  <StatusIcon size={14} />
                  <span>{t(`network:quality.diagnostics.stages.${diagnostic.kind}`)}</span>
                  <small>{diagnostic.latencyMs === null
                    ? t(`network:quality.diagnostics.status.${diagnostic.status}`)
                    : formatMilliseconds(diagnostic.latencyMs)}</small>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="network-quality__starting" role="status">
          <span className="network-quality__starting-pulse" />
          {t("network:quality.empty")}
        </div>
      )}
      {samples.length > 0 ? <NetworkQualityTrend samples={samples} /> : null}
      <small className="network-quality__method">{t("network:quality.method")}</small>
    </section>
  );
}

function QualityMetric({ label, value }: { label: string; value: string }) {
  return <div className="network-quality__metric"><span>{label}</span><strong>{value}</strong></div>;
}

function NetworkQualityTrend({ samples }: { samples: readonly NetworkQualityResult[] }) {
  const { t } = useAppTranslation();
  const latest = samples[samples.length - 1]!;
  const windowStart = latest.sampledAtMs - NETWORK_QUALITY_WINDOW_MS;
  const values = samples.flatMap((sample) => [sample.averageLatencyMs, sample.jitterMs])
    .filter((value): value is number => value !== null);
  const maximum = Math.max(20, ...values);
  const xFor = (sampledAtMs: number) => QUALITY_CHART_LEFT +
    ((sampledAtMs - windowStart) / NETWORK_QUALITY_WINDOW_MS) *
      (QUALITY_CHART_RIGHT - QUALITY_CHART_LEFT);
  const yFor = (value: number) => QUALITY_CHART_BOTTOM -
    (value / maximum) * (QUALITY_CHART_BOTTOM - QUALITY_CHART_TOP);
  const latencySegments = buildQualityLineSegments(samples, "averageLatencyMs", xFor, yFor);
  const jitterSegments = buildQualityLineSegments(samples, "jitterMs", xFor, yFor);
  const latencyValues = samples
    .map((sample) => sample.averageLatencyMs)
    .filter((value): value is number => value !== null);
  const averageLatency = latencyValues.length > 0
    ? latencyValues.reduce((total, value) => total + value, 0) / latencyValues.length
    : null;
  const peakLatency = latencyValues.length > 0 ? Math.max(...latencyValues) : null;
  const anomalies = samples.filter(isNetworkQualityAnomaly).length;
  const newestLatency = latest.averageLatencyMs;
  const newestJitter = latest.jitterMs;

  return (
    <section className="network-quality__trend" aria-labelledby="network-quality-trend-title">
      <header>
        <div>
          <h3 id="network-quality-trend-title">{t("network:quality.trendTitle")}</h3>
          <span>{t("network:quality.trendWindow")}</span>
        </div>
        <div className="network-quality__legend" aria-label={t("network:quality.legend")}>
          <span className="is-latency">{t("network:quality.latency")}</span>
          <span className="is-jitter">{t("network:quality.jitter")}</span>
          <span className="is-loss">{t("network:quality.loss")}</span>
        </div>
      </header>
      <div className="network-quality__chart-wrap">
        <svg
          className="network-quality__chart"
          viewBox={`0 0 ${QUALITY_CHART_WIDTH} ${QUALITY_CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("network:quality.chartLabel", { count: samples.length })}
        >
          {[0, 1, 2, 3].map((index) => {
            const y = QUALITY_CHART_TOP + index * ((QUALITY_CHART_BOTTOM - QUALITY_CHART_TOP) / 3);
            return <line className="network-quality__grid" key={index} x1={QUALITY_CHART_LEFT} x2={QUALITY_CHART_RIGHT} y1={y} y2={y} />;
          })}
          {samples.map((sample) => {
            if (sample.packetLossPercent <= 0) return null;
            const height = Math.max(4, (sample.packetLossPercent / 100) * (QUALITY_CHART_BOTTOM - QUALITY_CHART_TOP));
            return (
              <rect
                className="network-quality__loss-bar"
                key={`loss-${sample.sampledAtMs}`}
                x={Math.max(QUALITY_CHART_LEFT, xFor(sample.sampledAtMs) - 4)}
                y={QUALITY_CHART_BOTTOM - height}
                width={8}
                height={height}
                rx={3}
              />
            );
          })}
          {latencySegments.map((points, index) => <polyline className="network-quality__line is-latency" key={`latency-${index}`} points={points} />)}
          {jitterSegments.map((points, index) => <polyline className="network-quality__line is-jitter" key={`jitter-${index}`} points={points} />)}
          {newestLatency !== null ? <circle className="network-quality__point is-latency" cx={xFor(latest.sampledAtMs)} cy={yFor(newestLatency)} r={4} /> : null}
          {newestJitter !== null ? <circle className="network-quality__point is-jitter" cx={xFor(latest.sampledAtMs)} cy={yFor(newestJitter)} r={3.5} /> : null}
        </svg>
        {samples.length < 2 ? <span className="network-quality__collecting">{t("network:quality.trendCollecting")}</span> : null}
        <span className="network-quality__axis is-start">−15 min</span>
        <span className="network-quality__axis is-end">{t("network:quality.now")}</span>
      </div>
      <dl className="network-quality__trend-summary">
        <div><dt>{t("network:quality.windowAverage")}</dt><dd>{formatMilliseconds(averageLatency)}</dd></div>
        <div><dt>{t("network:quality.windowPeak")}</dt><dd>{formatMilliseconds(peakLatency)}</dd></div>
        <div><dt>{t("network:quality.anomalies")}</dt><dd>{t("network:quality.anomalyCount", { count: anomalies })}</dd></div>
      </dl>
    </section>
  );
}

function buildQualityLineSegments(
  samples: readonly NetworkQualityResult[],
  metric: "averageLatencyMs" | "jitterMs",
  xFor: (sampledAtMs: number) => number,
  yFor: (value: number) => number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const sample of samples) {
    const value = sample[metric];
    if (value === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${xFor(sample.sampledAtMs).toFixed(2)},${yFor(value).toFixed(2)}`);
  }
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

function isNetworkQualityAnomaly(sample: NetworkQualityResult): boolean {
  return sample.status !== "online" ||
    sample.packetLossPercent > 0 ||
    (sample.averageLatencyMs ?? 0) >= 150 ||
    (sample.jitterMs ?? 0) >= 50;
}

function formatMilliseconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`;
}

function ConnectionHistoryPanel({
  entries,
  error,
  enabled,
  retentionDays,
  onEnabledChange,
  onRetentionChange,
  onClear,
}: {
  entries: ConnectionHistoryEntry[];
  error: string | null;
  enabled: boolean;
  retentionDays: 1 | 7 | 30;
  onEnabledChange: (enabled: boolean) => void;
  onRetentionChange: (days: 1 | 7 | 30) => void;
  onClear: () => void;
}) {
  const { t, i18n } = useAppTranslation();
  const [groupBy, setGroupBy] = useState<ConnectionHistoryGroupBy>("application");
  const groups = useMemo(() => aggregateConnectionHistory(entries, groupBy).slice(0, 20), [entries, groupBy]);

  return (
    <section className="panel connection-history" aria-labelledby="connection-history-title">
      <header className="network-section-heading">
        <div>
          <span className="eyebrow">{t("network:history.eyebrow")}</span>
          <h2 id="connection-history-title">{t("network:history.title")}</h2>
          <p>{t("network:history.description")}</p>
        </div>
        <label className="settings-switch connection-history__switch">
          <input type="checkbox" role="switch" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
          <span>{enabled ? t("common:enabled") : t("common:disabled")}</span>
        </label>
      </header>
      {!enabled ? (
        <div className="connection-history__opt-in">
          <Globe2 size={22} />
          <p>{t("network:history.optIn")}</p>
          <button className="button button--primary" type="button" onClick={() => onEnabledChange(true)}>{t("network:history.enable")}</button>
        </div>
      ) : (
        <>
          <div className="connection-history__toolbar">
            <div className="network-connection-filters" role="group" aria-label={t("network:history.groupBy")}>
              {(["application", "domain"] as const).map((value) => (
                <button type="button" key={value} className={groupBy === value ? "is-active" : ""} onClick={() => setGroupBy(value)}>
                  {t(`network:history.${value}`)}
                </button>
              ))}
            </div>
            <label>{t("network:history.retention")}
              <select value={retentionDays} onChange={(event) => onRetentionChange(Number(event.target.value) as 1 | 7 | 30)}>
                {[1, 7, 30].map((days) => <option value={days} key={days}>{t("network:history.days", { count: days })}</option>)}
              </select>
            </label>
            <button className="button button--plain" type="button" onClick={onClear}>{t("network:history.clear")}</button>
          </div>
          {error ? <p className="network-connections__notice">{t("network:history.lookupFallback")}</p> : null}
          {groups.length > 0 ? (
            <div className="connection-history__list">
              {groups.map((group) => (
                <div key={group.key} className="connection-history__row">
                  <strong title={group.label}>{group.label}</strong>
                  <span>{t("network:history.observations", { count: group.observationCount })}</span>
                  <small>{new Date(group.lastSeenAtMs).toLocaleString(i18n.resolvedLanguage)}</small>
                </div>
              ))}
            </div>
          ) : <p className="network-quality__empty">{t("network:history.empty")}</p>}
          <small className="network-quality__method">{t("network:history.privacy")}</small>
        </>
      )}
    </section>
  );
}

function NetworkConnectionsPanel({
  snapshot,
  error,
  loading,
  onRefresh,
  refreshIntervalMs,
  processes,
  onSelectProcess,
}: {
  snapshot: NetworkConnectionsSnapshot | null;
  error: CommandError | null;
  loading: boolean;
  onRefresh: () => void;
  refreshIntervalMs: number;
  processes: ProcessRow[];
  onSelectProcess: (process: ProcessRow) => void;
}) {
  const { t, i18n } = useAppTranslation();
  const [filter, setFilter] = useState<NetworkConnectionFilter>("all");
  const [rowLimit, setRowLimit] = useState(CONNECTION_PAGE_SIZE);
  const filteredConnections = useMemo(
    () => filterNetworkConnections(snapshot?.connections ?? [], filter),
    [filter, snapshot?.connections],
  );
  const processByPid = useMemo(() => indexNetworkProcesses(processes), [processes]);
  const visibleConnections = filteredConnections.slice(0, rowLimit);
  const hasMore = visibleConnections.length < filteredConnections.length;

  return (
    <section
      className="panel network-connections"
      aria-labelledby="network-connections-title"
    >
      <header className="network-connections__heading">
        <div>
          <span className="eyebrow">{t("network:connections.collection")}</span>
          <h2 id="network-connections-title">{t("network:connections.title")}</h2>
          <p>{t("network:connections.description", { seconds: refreshIntervalMs / 1_000 })}</p>
        </div>
        <div className="network-connections__status">
          <span>
            {snapshot
              ? t("network:connections.updatedAt", {
                  time: new Date(snapshot.sampledAtMs).toLocaleTimeString(
                    i18n.resolvedLanguage,
                    { hour12: false },
                  ),
                })
              : t("network:connections.waiting")}
          </span>
          <button
            className="network-connections__refresh"
            type="button"
            aria-label={t("network:connections.refresh")}
            title={t("network:connections.refresh")}
            onClick={onRefresh}
          >
            <RefreshCw size={13} aria-hidden="true" />
            {t("common:refresh")}
          </button>
        </div>
      </header>

      {snapshot ? (
        <div className="network-connection-summary" aria-label={t("network:connections.summary")}>
          <ConnectionSummaryItem
            label={t("network:connections.allConnections")}
            value={snapshot.summary.totalCount}
            context={t("network:connections.attributedSummary", {
              count: snapshot.summary.attributedCount,
            })}
          />
          <ConnectionSummaryItem
            label={t("network:connections.established")}
            value={snapshot.summary.establishedCount}
            tone="established"
          />
          <ConnectionSummaryItem
            label={t("network:connections.listening")}
            value={snapshot.summary.listeningCount}
            tone="listen"
          />
          <ConnectionSummaryItem
            label={t("network:connections.tcpUdp")}
            value={`${snapshot.summary.tcpCount} / ${snapshot.summary.udpCount}`}
          />
        </div>
      ) : null}

      {error ? (
        <div className="network-connections__notice is-error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{t("network:connections.failure", { message: error.message })}</span>
          <button className="button button--secondary" type="button" onClick={onRefresh}>
            <RefreshCw size={13} />{t("common:retry")}
          </button>
        </div>
      ) : null}

      {snapshot && (snapshot.truncated || snapshot.skippedEntryCount > 0) ? (
        <div className="network-connections__notice" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          {snapshot.truncated ? t("network:connections.truncated") : null}
          {snapshot.truncated && snapshot.skippedEntryCount > 0 ? " " : null}
          {snapshot.skippedEntryCount > 0
            ? t("network:connections.skipped", { count: snapshot.skippedEntryCount })
            : null}
        </div>
      ) : null}

      {snapshot && snapshot.processAttribution !== "available" ? (
        <div className="network-connections__notice" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          {t(
            `network:connections.attribution.${snapshot.processAttribution}`,
          )}
        </div>
      ) : null}

      <div className="network-connections__toolbar">
        <div className="network-connection-filters" role="group" aria-label={t("network:connections.filters")}>
          {CONNECTION_FILTERS.map((value) => (
            <button
              className={filter === value ? "is-active" : ""}
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setRowLimit(CONNECTION_PAGE_SIZE);
              }}
            >
              {t(`network:connections.filtersLabel.${value}`)}
            </button>
          ))}
        </div>
        <span>
          {t("network:connections.count", { count: filteredConnections.length })}
          {loading ? ` · ${t("network:connections.updating")}` : ""}
        </span>
      </div>

      {snapshot && visibleConnections.length > 0 ? (
        <>
          <div className="network-connection-table" role="table" aria-label={t("network:connections.table")}>
            <div className="network-connection-row network-connection-row--header" role="row">
              <span role="columnheader">{t("network:connections.protocol")}</span>
              <span role="columnheader">{t("network:connections.state")}</span>
              <span role="columnheader">{t("network:connections.localAddress")}</span>
              <span role="columnheader">{t("network:connections.remoteAddress")}</span>
              <span role="columnheader">{t("network:connections.process")}</span>
            </div>
            {visibleConnections.map((connection, index) => (
              <div
                className="network-connection-row"
                role="row"
                key={`${connection.protocol}-${formatNetworkEndpoint(connection.localEndpoint)}-${formatNetworkEndpoint(connection.remoteEndpoint)}-${connection.state}-${index}`}
              >
                <span role="cell">
                  <strong>{connection.protocol.toUpperCase()}</strong>
                  <small>{connection.addressFamily.toUpperCase()}</small>
                </span>
                <span role="cell">
                  <i className={`network-connection-state network-connection-state--${connection.state}`}>
                    {t(`network:connections.states.${connection.state}`)}
                  </i>
                </span>
                <code role="cell" title={formatNetworkEndpoint(connection.localEndpoint)}>
                  {formatNetworkEndpoint(connection.localEndpoint)}
                </code>
                <code role="cell" title={formatNetworkEndpoint(connection.remoteEndpoint)}>
                  {formatNetworkEndpoint(connection.remoteEndpoint)}
                </code>
                <ConnectionOwnersCell
                  connection={connection}
                  processByPid={processByPid}
                  onSelectProcess={onSelectProcess}
                />
              </div>
            ))}
          </div>
          {hasMore ? (
            <button
              className="network-connections__more"
              type="button"
              onClick={() => setRowLimit((current) => current + CONNECTION_PAGE_SIZE)}
            >
              {t("network:connections.more", { count: filteredConnections.length - visibleConnections.length })}
            </button>
          ) : null}
        </>
      ) : (
        <div className="network-empty" aria-live="polite">
          <Network size={20} />
          {loading && !snapshot
            ? t("network:connections.collecting")
            : error && !snapshot
              ? t("network:connections.unavailable")
              : t("network:connections.empty")}
        </div>
      )}
    </section>
  );
}

function ConnectionOwnersCell({
  connection,
  processByPid,
  onSelectProcess,
}: {
  connection: NetworkConnection;
  processByPid: NetworkProcessIndex;
  onSelectProcess: (process: ProcessRow) => void;
}) {
  const { t } = useAppTranslation();
  const owners = resolveNetworkConnectionOwners(connection, processByPid);
  const primary = owners.processes[0];
  const reportedCount =
    owners.processes.length + owners.unavailablePids.length;

  if (primary) {
    return (
      <div className="network-connection-owner" role="cell">
        <button
          type="button"
          title={t("network:connections.inspectProcess", {
            name: primary.name || `PID ${primary.pid}`,
          })}
          onClick={() => onSelectProcess(primary)}
        >
          <ApplicationAvatar
            name={primary.name}
            source={processApplicationIconSource(primary)}
            className="network-owner-avatar"
          />
          <span>
            <strong>{primary.name || `PID ${primary.pid}`}</strong>
            <small>PID {primary.pid}</small>
          </span>
        </button>
        {reportedCount > 1 ? <em>+{reportedCount - 1}</em> : null}
      </div>
    );
  }

  if (owners.unavailablePids[0] !== undefined) {
    return (
      <div className="network-connection-owner is-unavailable" role="cell">
        <span>PID {owners.unavailablePids[0]}</span>
        <small>{t("network:connections.ownerUnavailable")}</small>
        {reportedCount > 1 ? <em>+{reportedCount - 1}</em> : null}
      </div>
    );
  }

  return (
    <div className="network-connection-owner is-empty" role="cell">
      {t("network:connections.unattributed")}
    </div>
  );
}

function ConnectionSummaryItem({
  label,
  value,
  context,
  tone = "default",
}: {
  label: string;
  value: number | string;
  context?: string;
  tone?: "default" | "established" | "listen";
}) {
  return (
    <div className={`network-connection-summary__item network-connection-summary__item--${tone}`}>
      <span>{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString() : value}</strong>
      {context ? <small>{context}</small> : null}
    </div>
  );
}

interface NetworkSummaryItemProps {
  icon: typeof Network;
  label: string;
  value: string;
  context?: string;
  tone: "received" | "transmitted" | "session";
}

function NetworkSummaryItem({
  icon: Icon,
  label,
  value,
  context,
  tone,
}: NetworkSummaryItemProps) {
  return (
    <div className={`network-summary__item network-summary__item--${tone}`}>
      <Icon size={16} aria-hidden="true" />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        {context ? <em>{context}</em> : null}
      </span>
    </div>
  );
}

function NetworkThroughput({
  history,
  network,
}: {
  history: HistoryPoint[];
  network: NetworkSnapshot;
}) {
  const { t } = useAppTranslation();
  const points = networkHistoryWindow(history);
  const receivedSegments = networkHistorySegments(points, "received");
  const transmittedSegments = networkHistorySegments(points, "transmitted");
  const values = [...receivedSegments, ...transmittedSegments].flatMap((segment) =>
    segment.map((point) => point.value),
  );
  const maximum = Math.max(1, ...values);
  const windowEnd = points[points.length - 1]?.timestamp ?? 0;
  const windowStart = windowEnd - 5 * 60 * 1_000;
  const receivedPeak = Math.max(
    0,
    ...receivedSegments.flatMap((segment) => segment.map((point) => point.value)),
  );
  const transmittedPeak = Math.max(
    0,
    ...transmittedSegments.flatMap((segment) => segment.map((point) => point.value)),
  );

  return (
    <section className="panel network-history" aria-labelledby="network-history-title">
      <header className="network-section-heading">
        <div>
          <span className="eyebrow">{t("common:fiveMinutes")}</span>
          <h2 id="network-history-title">{t("network:throughput")}</h2>
        </div>
        <div className="network-history__legend" aria-label={t("network:throughputLegend")}>
          <span><i className="is-received" />{t("network:receive")} {formatRate(network.receivedBytesPerSecond)}</span>
          <span><i className="is-transmitted" />{t("network:send")} {formatRate(network.transmittedBytesPerSecond)}</span>
        </div>
      </header>

      {points.length < 2 ? (
        <div className="network-history__empty">
          <span className="live-status-dot" />{t("network:establishingBaseline")}
        </div>
      ) : (
        <>
          <svg
            className="network-history__chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t("network:chartLabel", {
              receive: formatRate(network.receivedBytesPerSecond),
              send: formatRate(network.transmittedBytesPerSecond),
            })}
          >
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line
                className="network-history__grid-line"
                key={ratio}
                x1="0"
                x2={CHART_WIDTH}
                y1={CHART_TOP + ratio * (CHART_BOTTOM - CHART_TOP)}
                y2={CHART_TOP + ratio * (CHART_BOTTOM - CHART_TOP)}
              />
            ))}
            {receivedSegments.map((segment, index) => (
              <path
                className="network-history__line network-history__line--received"
                d={networkPath(segment, windowStart, windowEnd, maximum)}
                key={`received-${index}`}
              />
            ))}
            {transmittedSegments.map((segment, index) => (
              <path
                className="network-history__line network-history__line--transmitted"
                d={networkPath(segment, windowStart, windowEnd, maximum)}
                key={`transmitted-${index}`}
              />
            ))}
            <text x="0" y="172">{t("common:fiveMinutesBack")}</text>
            <text x={CHART_WIDTH} y="172" textAnchor="end">{t("common:now")}</text>
          </svg>
          <div className="network-history__peaks">
            <span>{t("network:receivePeak")} <strong>{formatRate(receivedPeak)}</strong></span>
            <span>{t("network:sendPeak")} <strong>{formatRate(transmittedPeak)}</strong></span>
          </div>
        </>
      )}
    </section>
  );
}

function NetworkInterfaceRow({
  networkInterface,
}: {
  networkInterface: NetworkInterfaceSnapshot;
}) {
  const { t } = useAppTranslation();
  const errorCount =
    networkInterface.receiveErrorsSinceLaunch +
    networkInterface.transmitErrorsSinceLaunch;
  const packetCount =
    networkInterface.packetsReceivedSinceLaunch +
    networkInterface.packetsTransmittedSinceLaunch;
  const sessionTotal =
    networkInterface.receivedBytesSinceLaunch +
    networkInterface.transmittedBytesSinceLaunch;
  const stateLabel = t(
    `network:interfaceStates.${networkInterface.operationalState}`,
  );

  return (
    <li className="network-interface-row">
      <div className="network-interface-identity">
        <span
          className={`network-interface-state network-interface-state--${networkInterface.operationalState}`}
        >
          <i />{stateLabel}
        </span>
        <strong>{networkInterface.name}</strong>
        <code title={networkInterface.ipNetworks.join(" · ")}>
          {networkInterface.ipNetworks.length > 0
            ? networkInterface.ipNetworks.join(" · ")
            : t("network:noIp")}
        </code>
      </div>
      <div className="network-interface-metric network-interface-metric--received">
        <small>{t("network:receive")}</small>
        <strong>{formatRate(networkInterface.receivedBytesPerSecond)}</strong>
        <span>{t("network:accumulated", { value: formatBytes(networkInterface.receivedBytesSinceLaunch) })}</span>
      </div>
      <div className="network-interface-metric network-interface-metric--transmitted">
        <small>{t("network:send")}</small>
        <strong>{formatRate(networkInterface.transmittedBytesPerSecond)}</strong>
        <span>{t("network:accumulated", { value: formatBytes(networkInterface.transmittedBytesSinceLaunch) })}</span>
      </div>
      <div className="network-interface-session">
        <small>{t("common:session")}</small>
        <strong>{formatBytes(sessionTotal)}</strong>
        <span>{t("network:packets", { count: packetCount })}</span>
      </div>
      <div className="network-interface-details">
        <span>MTU {networkInterface.mtu || t("network:unknownMtu")}</span>
        <span title={networkInterface.macAddress ?? undefined}>
          {networkInterface.macAddress ?? t("network:noMac")}
        </span>
        {errorCount > 0 ? (
          <em><AlertTriangle size={10} />{t("common:errors", { count: errorCount })}</em>
        ) : (
          <em className="is-healthy">{t("common:errors", { count: 0 })}</em>
        )}
      </div>
    </li>
  );
}

function networkPath(
  segment: readonly NetworkSeriesPoint[],
  windowStart: number,
  windowEnd: number,
  maximum: number,
): string {
  const duration = Math.max(1, windowEnd - windowStart);
  const commands = segment.map((point, index) => {
    const x = ((point.timestamp - windowStart) / duration) * CHART_WIDTH;
    const y = CHART_BOTTOM - (point.value / maximum) * (CHART_BOTTOM - CHART_TOP);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  if (commands.length === 1) commands.push("h0.01");
  return commands.join(" ");
}
