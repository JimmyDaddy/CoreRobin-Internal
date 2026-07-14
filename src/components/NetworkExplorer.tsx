import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  Network,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  networkHistorySegments,
  networkHistoryWindow,
  visibleNetworkInterfaces,
  type NetworkSeriesPoint,
} from "../networkExplorer";
import type {
  HistoryPoint,
  NetworkInterfaceOperationalState,
  NetworkInterfaceSnapshot,
  NetworkSnapshot,
} from "../types";
import { formatBytes, formatRate } from "../utils";

interface NetworkExplorerProps {
  network: NetworkSnapshot;
  history: HistoryPoint[];
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 176;
const CHART_TOP = 12;
const CHART_BOTTOM = 148;

const STATE_LABELS: Record<NetworkInterfaceOperationalState, string> = {
  other: "其他",
  up: "已连接",
  down: "未连接",
  testing: "测试中",
  unknown: "未知",
  dormant: "待机",
  notpresent: "不存在",
  lowerlayerdown: "底层未连接",
};

export function NetworkExplorer({
  network,
  history,
}: NetworkExplorerProps) {
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
            <span className="eyebrow">本机网络</span>
            <h2 id="network-title">实时接口与会话流量</h2>
            <p>速率按真实采样间隔换算；累计值从本次启动 Pulse 开始。</p>
          </div>
          <span className="network-overview__badge">
            <Network size={14} />
            {connectedCount} / {network.interfaceCount} 个接口已连接
          </span>
        </header>

        <div className="network-summary" aria-label="网络摘要">
          <NetworkSummaryItem
            icon={ArrowDownToLine}
            label="当前接收"
            value={formatRate(network.receivedBytesPerSecond)}
            tone="received"
          />
          <NetworkSummaryItem
            icon={ArrowUpFromLine}
            label="当前发送"
            value={formatRate(network.transmittedBytesPerSecond)}
            tone="transmitted"
          />
          <NetworkSummaryItem
            icon={Activity}
            label="本次启动累计"
            value={formatBytes(sessionTotal)}
            context={`接收 ${formatBytes(network.receivedBytesSinceLaunch)} · 发送 ${formatBytes(network.transmittedBytesSinceLaunch)}`}
            tone="session"
          />
        </div>
      </section>

      <NetworkThroughput history={history} network={network} />

      <section className="panel network-interface-panel" aria-labelledby="interface-title">
        <header className="network-section-heading">
          <div>
            <span className="eyebrow">网络接口</span>
            <h2 id="interface-title">接口活动</h2>
          </div>
          {visible.hiddenCount > 0 || showAllInterfaces ? (
            <button
              className="network-interface-toggle"
              type="button"
              aria-expanded={showAllInterfaces}
              onClick={() => setShowAllInterfaces((current) => !current)}
            >
              {showAllInterfaces ? (
                <><ChevronUp size={13} />收起未使用接口</>
              ) : (
                <><ChevronDown size={13} />显示另外 {visible.hiddenCount} 个接口</>
              )}
            </button>
          ) : (
            <span>按当前总流量排序</span>
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
            <Network size={20} />当前没有可展示的网络接口。
          </div>
        )}
      </section>
    </section>
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
          <span className="eyebrow">最近 5 分钟</span>
          <h2 id="network-history-title">网络吞吐</h2>
        </div>
        <div className="network-history__legend" aria-label="吞吐图例">
          <span><i className="is-received" />接收 {formatRate(network.receivedBytesPerSecond)}</span>
          <span><i className="is-transmitted" />发送 {formatRate(network.transmittedBytesPerSecond)}</span>
        </div>
      </header>

      {points.length < 2 ? (
        <div className="network-history__empty">
          <span className="pulse-dot" />正在建立网络吞吐基线…
        </div>
      ) : (
        <>
          <svg
            className="network-history__chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`网络接收 ${formatRate(network.receivedBytesPerSecond)}，发送 ${formatRate(network.transmittedBytesPerSecond)}`}
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
            <text x="0" y="172">−5 分钟</text>
            <text x={CHART_WIDTH} y="172" textAnchor="end">现在</text>
          </svg>
          <div className="network-history__peaks">
            <span>接收峰值 <strong>{formatRate(receivedPeak)}</strong></span>
            <span>发送峰值 <strong>{formatRate(transmittedPeak)}</strong></span>
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
  const errorCount =
    networkInterface.receiveErrorsSinceLaunch +
    networkInterface.transmitErrorsSinceLaunch;
  const packetCount =
    networkInterface.packetsReceivedSinceLaunch +
    networkInterface.packetsTransmittedSinceLaunch;
  const sessionTotal =
    networkInterface.receivedBytesSinceLaunch +
    networkInterface.transmittedBytesSinceLaunch;
  const stateLabel = STATE_LABELS[networkInterface.operationalState];

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
            : "未报告 IP 地址"}
        </code>
      </div>
      <div className="network-interface-metric network-interface-metric--received">
        <small>接收</small>
        <strong>{formatRate(networkInterface.receivedBytesPerSecond)}</strong>
        <span>累计 {formatBytes(networkInterface.receivedBytesSinceLaunch)}</span>
      </div>
      <div className="network-interface-metric network-interface-metric--transmitted">
        <small>发送</small>
        <strong>{formatRate(networkInterface.transmittedBytesPerSecond)}</strong>
        <span>累计 {formatBytes(networkInterface.transmittedBytesSinceLaunch)}</span>
      </div>
      <div className="network-interface-session">
        <small>本次启动</small>
        <strong>{formatBytes(sessionTotal)}</strong>
        <span>{packetCount.toLocaleString()} 个数据包</span>
      </div>
      <div className="network-interface-details">
        <span>MTU {networkInterface.mtu || "未知"}</span>
        <span title={networkInterface.macAddress ?? undefined}>
          {networkInterface.macAddress ?? "无 MAC 地址"}
        </span>
        {errorCount > 0 ? (
          <em><AlertTriangle size={10} />{errorCount} 个错误</em>
        ) : (
          <em className="is-healthy">0 个错误</em>
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
