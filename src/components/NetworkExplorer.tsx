import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  Network,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAppTranslation } from "../i18n/useAppTranslation";

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
import type {
  CommandError,
  HistoryPoint,
  NetworkConnection,
  NetworkConnectionsSnapshot,
  NetworkInterfaceSnapshot,
  NetworkSnapshot,
  ProcessRow,
} from "../types";
import { formatBytes, formatRate } from "../utils";

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
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 176;
const CHART_TOP = 12;
const CHART_BOTTOM = 148;
const CONNECTION_PAGE_SIZE = 100;

const CONNECTION_FILTERS: NetworkConnectionFilter[] = [
  "all",
  "established",
  "listen",
  "tcp",
  "udp",
];

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
}: NetworkExplorerProps) {
  const { t } = useAppTranslation();
  const [showAllInterfaces, setShowAllInterfaces] = useState(false);
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

      <NetworkThroughput history={history} network={network} />

      <NetworkConnectionsPanel
        snapshot={connections}
        error={connectionsError}
        loading={connectionsLoading}
        onRefresh={onRefreshConnections}
        refreshIntervalMs={connectionRefreshIntervalMs}
        processes={processes}
        onSelectProcess={onSelectProcess}
      />

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
          {t("network:connections.failure", { message: error.message })}
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
          <strong>{primary.name || `PID ${primary.pid}`}</strong>
          <small>PID {primary.pid}</small>
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
