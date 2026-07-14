import type {
  HistoryPoint,
  NetworkConnection,
  NetworkEndpoint,
  NetworkInterfaceSnapshot,
  ProcessRow,
} from "./types";

export const NETWORK_HISTORY_WINDOW_MS = 5 * 60 * 1_000;
export const NETWORK_SAMPLE_GAP_MS = 5_000;

export type NetworkMetric = "received" | "transmitted";
export type NetworkConnectionFilter =
  | "all"
  | "established"
  | "listen"
  | "tcp"
  | "udp";

export interface NetworkSeriesPoint {
  timestamp: number;
  value: number;
}

export interface VisibleNetworkInterfaces {
  interfaces: NetworkInterfaceSnapshot[];
  hiddenCount: number;
}

export interface NetworkConnectionOwners {
  processes: ProcessRow[];
  unavailablePids: number[];
}

export function resolveNetworkConnectionOwners(
  connection: NetworkConnection,
  processes: readonly ProcessRow[],
): NetworkConnectionOwners {
  const processByPid = new Map(processes.map((process) => [process.pid, process]));
  const resolved: ProcessRow[] = [];
  const unavailablePids: number[] = [];
  for (const pid of [...new Set(connection.associatedPids)].sort((left, right) => left - right)) {
    const process = processByPid.get(pid);
    if (process) resolved.push(process);
    else unavailablePids.push(pid);
  }
  return { processes: resolved, unavailablePids };
}

export function filterNetworkConnections(
  connections: readonly NetworkConnection[],
  filter: NetworkConnectionFilter,
): NetworkConnection[] {
  if (filter === "all") return [...connections];
  if (filter === "tcp" || filter === "udp") {
    return connections.filter(({ protocol }) => protocol === filter);
  }
  return connections.filter(({ state }) => state === filter);
}

export function formatNetworkEndpoint(endpoint: NetworkEndpoint | null): string {
  if (!endpoint) return "—";
  const address = endpoint.address.includes(":")
    ? `[${endpoint.address}]`
    : endpoint.address;
  return `${address}:${endpoint.port}`;
}

export function networkInterfaceRate(
  networkInterface: NetworkInterfaceSnapshot,
): number | null {
  if (
    networkInterface.receivedBytesPerSecond === null &&
    networkInterface.transmittedBytesPerSecond === null
  ) {
    return null;
  }
  return (
    (networkInterface.receivedBytesPerSecond ?? 0) +
    (networkInterface.transmittedBytesPerSecond ?? 0)
  );
}

export function sortNetworkInterfaces(
  interfaces: readonly NetworkInterfaceSnapshot[],
): NetworkInterfaceSnapshot[] {
  return [...interfaces].sort((left, right) => {
    const rateDifference =
      (networkInterfaceRate(right) ?? Number.NEGATIVE_INFINITY) -
      (networkInterfaceRate(left) ?? Number.NEGATIVE_INFINITY);
    if (rateDifference !== 0) return rateDifference;

    const stateDifference =
      Number(right.operationalState === "up") -
      Number(left.operationalState === "up");
    if (stateDifference !== 0) return stateDifference;

    const rightSessionTotal =
      right.receivedBytesSinceLaunch + right.transmittedBytesSinceLaunch;
    const leftSessionTotal =
      left.receivedBytesSinceLaunch + left.transmittedBytesSinceLaunch;
    return (
      rightSessionTotal - leftSessionTotal || left.name.localeCompare(right.name)
    );
  });
}

function hasSessionActivity(networkInterface: NetworkInterfaceSnapshot): boolean {
  return (
    networkInterface.receivedBytesSinceLaunch > 0 ||
    networkInterface.transmittedBytesSinceLaunch > 0 ||
    networkInterface.receiveErrorsSinceLaunch > 0 ||
    networkInterface.transmitErrorsSinceLaunch > 0
  );
}

export function visibleNetworkInterfaces(
  interfaces: readonly NetworkInterfaceSnapshot[],
  showAll: boolean,
): VisibleNetworkInterfaces {
  const sorted = sortNetworkInterfaces(interfaces);
  if (showAll) return { interfaces: sorted, hiddenCount: 0 };

  const active = sorted.filter(hasSessionActivity);
  const visible =
    active.length > 0
      ? active
      : sorted.filter(({ operationalState }) => operationalState === "up").slice(0, 3);
  return {
    interfaces: visible,
    hiddenCount: Math.max(0, sorted.length - visible.length),
  };
}

export function networkHistoryWindow(
  history: readonly HistoryPoint[],
): HistoryPoint[] {
  if (history.length === 0) return [];
  const ordered = [...history].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const latestTimestamp = ordered[ordered.length - 1]?.timestamp ?? 0;
  const cutoff = latestTimestamp - NETWORK_HISTORY_WINDOW_MS;
  return ordered.filter((point) => point.timestamp >= cutoff);
}

export function networkHistorySegments(
  history: readonly HistoryPoint[],
  metric: NetworkMetric,
): NetworkSeriesPoint[][] {
  const points = networkHistoryWindow(history);
  const segments: NetworkSeriesPoint[][] = [];
  let current: NetworkSeriesPoint[] = [];
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const followsGap =
      previous !== undefined &&
      point.timestamp - previous.timestamp > NETWORK_SAMPLE_GAP_MS;
    if (followsGap && current.length > 0) {
      segments.push(current);
      current = [];
    }

    const value =
      metric === "received"
        ? point.networkReceivedBytesPerSecond
        : point.networkTransmittedBytesPerSecond;
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ timestamp: point.timestamp, value: Math.max(0, value) });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
