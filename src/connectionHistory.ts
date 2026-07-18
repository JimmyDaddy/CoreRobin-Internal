import type {
  NetworkConnectionsSnapshot,
  NetworkHostLookup,
  ProcessRow,
} from "./types";

export const CONNECTION_HISTORY_STORAGE_KEY = "core-robin.network-connection-history.v1";
const BUCKET_MS = 5 * 60 * 1_000;
const MAX_ENTRIES = 5_000;

export interface ConnectionHistoryEntry {
  bucketStartMs: number;
  lastSeenAtMs: number;
  applicationName: string;
  remoteAddress: string;
  hostname: string | null;
  protocol: "tcp" | "udp";
  remotePort: number;
  observationCount: number;
}

export type ConnectionHistoryGroupBy = "application" | "domain";

export interface ConnectionHistoryAggregate {
  key: string;
  label: string;
  connectionCount: number;
  observationCount: number;
  lastSeenAtMs: number;
}

export function mergeConnectionHistory(
  current: ConnectionHistoryEntry[],
  snapshot: NetworkConnectionsSnapshot,
  processes: ProcessRow[],
  lookups: NetworkHostLookup[],
  retentionDays: number,
  now = Date.now(),
): ConnectionHistoryEntry[] {
  const processNames = new Map(processes.map((process) => [process.pid, process.name]));
  const hostnames = new Map(lookups.map((lookup) => [lookup.address, lookup.hostname]));
  const bucketStartMs = Math.floor(snapshot.sampledAtMs / BUCKET_MS) * BUCKET_MS;
  const merged = new Map(current.map((entry) => [entryKey(entry), entry]));

  for (const connection of snapshot.connections) {
    const remote = connection.remoteEndpoint;
    if (!remote || remote.port === 0 || isUnspecifiedAddress(remote.address)) continue;
    const names = connection.associatedPids
      .map((pid) => processNames.get(pid))
      .filter((name): name is string => Boolean(name));
    const applicationName = [...new Set(names)].sort().join(", ") || "Unattributed";
    const entry: ConnectionHistoryEntry = {
      bucketStartMs,
      lastSeenAtMs: snapshot.sampledAtMs,
      applicationName,
      remoteAddress: remote.address,
      hostname: hostnames.get(remote.address) ?? null,
      protocol: connection.protocol,
      remotePort: remote.port,
      observationCount: 1,
    };
    const key = entryKey(entry);
    const previous = merged.get(key);
    merged.set(key, previous
      ? {
          ...previous,
          hostname: entry.hostname ?? previous.hostname,
          lastSeenAtMs: Math.max(previous.lastSeenAtMs, entry.lastSeenAtMs),
          observationCount: previous.observationCount + 1,
        }
      : entry);
  }

  const cutoff = now - retentionDays * 86_400_000;
  return [...merged.values()]
    .filter((entry) => entry.lastSeenAtMs >= cutoff)
    .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
    .slice(0, MAX_ENTRIES);
}

export function aggregateConnectionHistory(
  entries: ConnectionHistoryEntry[],
  groupBy: ConnectionHistoryGroupBy,
): ConnectionHistoryAggregate[] {
  const groups = new Map<string, ConnectionHistoryAggregate>();
  for (const entry of entries) {
    const label = groupBy === "application"
      ? entry.applicationName
      : entry.hostname ?? entry.remoteAddress;
    const current = groups.get(label);
    groups.set(label, {
      key: label,
      label,
      connectionCount: (current?.connectionCount ?? 0) + 1,
      observationCount: (current?.observationCount ?? 0) + entry.observationCount,
      lastSeenAtMs: Math.max(current?.lastSeenAtMs ?? 0, entry.lastSeenAtMs),
    });
  }
  return [...groups.values()].sort((left, right) =>
    right.observationCount - left.observationCount || right.lastSeenAtMs - left.lastSeenAtMs
  );
}

export function loadConnectionHistory(storage: Storage): ConnectionHistoryEntry[] {
  try {
    const parsed = JSON.parse(storage.getItem(CONNECTION_HISTORY_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isConnectionHistoryEntry).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function saveConnectionHistory(
  storage: Storage,
  entries: ConnectionHistoryEntry[],
): void {
  try {
    storage.setItem(CONNECTION_HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // History remains available for the current session when storage is unavailable.
  }
}

export function clearConnectionHistory(storage: Storage): void {
  try {
    storage.removeItem(CONNECTION_HISTORY_STORAGE_KEY);
  } catch {
    // Nothing else to clear when storage is unavailable.
  }
}

function entryKey(entry: ConnectionHistoryEntry): string {
  return [
    entry.bucketStartMs,
    entry.applicationName,
    entry.remoteAddress,
    entry.protocol,
    entry.remotePort,
  ].join("\u0000");
}

function isUnspecifiedAddress(address: string): boolean {
  return address === "0.0.0.0" || address === "::" || address === "*";
}

function isConnectionHistoryEntry(value: unknown): value is ConnectionHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ConnectionHistoryEntry>;
  return typeof entry.bucketStartMs === "number" &&
    typeof entry.lastSeenAtMs === "number" &&
    typeof entry.applicationName === "string" &&
    typeof entry.remoteAddress === "string" &&
    (entry.hostname === null || typeof entry.hostname === "string") &&
    (entry.protocol === "tcp" || entry.protocol === "udp") &&
    typeof entry.remotePort === "number" &&
    typeof entry.observationCount === "number";
}
