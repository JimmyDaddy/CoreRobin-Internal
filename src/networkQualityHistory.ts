import type { NetworkQualityResult, NetworkQualityStatus } from "./types";

export const NETWORK_QUALITY_HISTORY_STORAGE_KEY =
  "core-robin.network-quality-history.v1";
export const NETWORK_QUALITY_HISTORY_BUCKET_MS = 5 * 60 * 1_000;

export type NetworkQualityHistoryHours = 1 | 24 | 168;
export type NetworkQualityHistoryEventKind =
  | "sleep_gap"
  | "interface_change"
  | "status_change"
  | "dns_failure"
  | "direct_failure";

export interface NetworkQualityHistoryEvent {
  kind: NetworkQualityHistoryEventKind;
  atMs: number;
  previousStatus?: NetworkQualityStatus;
  status?: NetworkQualityStatus;
}

export interface NetworkQualityHistoryPoint {
  bucketStartMs: number;
  sampledAtMs: number;
  sampleCount: number;
  status: NetworkQualityStatus;
  dnsLookupMs: number | null;
  dnsSampleCount: number;
  averageLatencyMs: number | null;
  latencySampleCount: number;
  jitterMs: number | null;
  jitterSampleCount: number;
  probeCount: number;
  successfulProbeCount: number;
  events: NetworkQualityHistoryEvent[];
  networkSignatureHash: string | null;
  dnsStatus: "passed" | "degraded" | "failed" | "unavailable";
  directStatus: "passed" | "degraded" | "failed" | "unavailable";
}

export function loadNetworkQualityHistory(
  storage: Storage = window.localStorage,
): NetworkQualityHistoryPoint[] {
  try {
    const value = JSON.parse(
      storage.getItem(NETWORK_QUALITY_HISTORY_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(value)
      ? value.filter(isNetworkQualityHistoryPoint).map(normalizeHistoryPoint)
      : [];
  } catch {
    return [];
  }
}

export function saveNetworkQualityHistory(
  points: readonly NetworkQualityHistoryPoint[],
  storage: Storage = window.localStorage,
): void {
  try {
    storage.setItem(
      NETWORK_QUALITY_HISTORY_STORAGE_KEY,
      JSON.stringify(points),
    );
  } catch {
    // The live network-quality result remains usable without persistence.
  }
}

export function clearNetworkQualityHistory(
  storage: Storage = window.localStorage,
): void {
  try {
    storage.removeItem(NETWORK_QUALITY_HISTORY_STORAGE_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

export function mergeNetworkQualityHistory(
  current: readonly NetworkQualityHistoryPoint[],
  sample: NetworkQualityResult,
  retentionHours: NetworkQualityHistoryHours,
  now = sample.sampledAtMs,
  networkSignature?: string,
): NetworkQualityHistoryPoint[] {
  const cutoff = now - retentionHours * 60 * 60 * 1_000;
  const bucketStartMs =
    Math.floor(sample.sampledAtMs / NETWORK_QUALITY_HISTORY_BUCKET_MS)
    * NETWORK_QUALITY_HISTORY_BUCKET_MS;
  const buckets = new Map(
    current
      .filter((point) => point.sampledAtMs >= cutoff)
      .map((point) => [point.bucketStartMs, point]),
  );
  const latest = [...buckets.values()]
    .sort((left, right) => right.sampledAtMs - left.sampledAtMs)[0];
  const signatureSource = [networkSignature, sample.routeSignature]
    .filter((value): value is string => Boolean(value))
    .join("|");
  const signatureHash = signatureSource
    ? stableNetworkSignatureHash(signatureSource)
    : null;
  const events = deriveNetworkQualityEvents(latest, sample, signatureHash);
  const previous = buckets.get(bucketStartMs);
  buckets.set(bucketStartMs, previous
    ? mergeBucket(previous, sample, events, signatureHash)
    : pointFromSample(sample, bucketStartMs, events, signatureHash));
  return [...buckets.values()]
    .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
    .filter((point) => point.sampledAtMs >= cutoff);
}

export function networkQualityHistoryForDisplay(
  points: readonly NetworkQualityHistoryPoint[],
  hours: NetworkQualityHistoryHours,
): NetworkQualityHistoryPoint[] {
  if (hours !== 168) return [...points];
  const bucketMs = 30 * 60 * 1_000;
  const grouped = new Map<number, NetworkQualityHistoryPoint>();
  for (const point of points) {
    const bucketStartMs = Math.floor(point.sampledAtMs / bucketMs) * bucketMs;
    const previous = grouped.get(bucketStartMs);
    grouped.set(
      bucketStartMs,
      previous
        ? mergeHistoryPoints(previous, point, bucketStartMs)
        : { ...point, bucketStartMs },
    );
  }
  return [...grouped.values()].sort(
    (left, right) => left.bucketStartMs - right.bucketStartMs,
  );
}

export function networkQualityFailurePercent(
  point: Pick<NetworkQualityHistoryPoint, "probeCount" | "successfulProbeCount">,
): number {
  if (point.probeCount <= 0) return 0;
  return Math.max(
    0,
    (point.probeCount - point.successfulProbeCount) / point.probeCount * 100,
  );
}

function pointFromSample(
  sample: NetworkQualityResult,
  bucketStartMs: number,
  events: NetworkQualityHistoryEvent[],
  networkSignatureHash: string | null,
): NetworkQualityHistoryPoint {
  return {
    bucketStartMs,
    sampledAtMs: sample.sampledAtMs,
    sampleCount: 1,
    status: sample.status,
    dnsLookupMs: sample.dnsLookupMs,
    dnsSampleCount: sample.dnsLookupMs === null ? 0 : 1,
    averageLatencyMs: sample.averageLatencyMs,
    latencySampleCount: sample.averageLatencyMs === null ? 0 : 1,
    jitterMs: sample.jitterMs,
    jitterSampleCount: sample.jitterMs === null ? 0 : 1,
    probeCount: sample.probeCount,
    successfulProbeCount: sample.successfulProbeCount,
    events,
    networkSignatureHash,
    dnsStatus: diagnosticStatus(sample, "dns"),
    directStatus: diagnosticStatus(sample, "internet"),
  };
}

function mergeBucket(
  previous: NetworkQualityHistoryPoint,
  sample: NetworkQualityResult,
  events: NetworkQualityHistoryEvent[],
  networkSignatureHash: string | null,
): NetworkQualityHistoryPoint {
  return {
    ...previous,
    sampledAtMs: Math.max(previous.sampledAtMs, sample.sampledAtMs),
    sampleCount: previous.sampleCount + 1,
    status: worseStatus(previous.status, sample.status),
    dnsLookupMs: mergeAverage(
      previous.dnsLookupMs,
      previous.dnsSampleCount,
      sample.dnsLookupMs,
    ),
    dnsSampleCount:
      previous.dnsSampleCount + (sample.dnsLookupMs === null ? 0 : 1),
    averageLatencyMs: mergeAverage(
      previous.averageLatencyMs,
      previous.latencySampleCount,
      sample.averageLatencyMs,
    ),
    latencySampleCount:
      previous.latencySampleCount + (sample.averageLatencyMs === null ? 0 : 1),
    jitterMs: mergeAverage(
      previous.jitterMs,
      previous.jitterSampleCount,
      sample.jitterMs,
    ),
    jitterSampleCount:
      previous.jitterSampleCount + (sample.jitterMs === null ? 0 : 1),
    probeCount: previous.probeCount + sample.probeCount,
    successfulProbeCount:
      previous.successfulProbeCount + sample.successfulProbeCount,
    events: deduplicateEvents([...previous.events, ...events]),
    networkSignatureHash:
      networkSignatureHash ?? previous.networkSignatureHash,
    dnsStatus: diagnosticStatus(sample, "dns"),
    directStatus: diagnosticStatus(sample, "internet"),
  };
}

function mergeHistoryPoints(
  left: NetworkQualityHistoryPoint,
  right: NetworkQualityHistoryPoint,
  bucketStartMs: number,
): NetworkQualityHistoryPoint {
  return {
    ...left,
    bucketStartMs,
    sampledAtMs: Math.max(left.sampledAtMs, right.sampledAtMs),
    sampleCount: left.sampleCount + right.sampleCount,
    status: worseStatus(left.status, right.status),
    dnsLookupMs: weightedAverage(
      left.dnsLookupMs,
      left.dnsSampleCount,
      right.dnsLookupMs,
      right.dnsSampleCount,
    ),
    dnsSampleCount: left.dnsSampleCount + right.dnsSampleCount,
    averageLatencyMs: weightedAverage(
      left.averageLatencyMs,
      left.latencySampleCount,
      right.averageLatencyMs,
      right.latencySampleCount,
    ),
    latencySampleCount: left.latencySampleCount + right.latencySampleCount,
    jitterMs: weightedAverage(
      left.jitterMs,
      left.jitterSampleCount,
      right.jitterMs,
      right.jitterSampleCount,
    ),
    jitterSampleCount: left.jitterSampleCount + right.jitterSampleCount,
    probeCount: left.probeCount + right.probeCount,
    successfulProbeCount:
      left.successfulProbeCount + right.successfulProbeCount,
    events: deduplicateEvents([...left.events, ...right.events]),
    networkSignatureHash:
      right.networkSignatureHash ?? left.networkSignatureHash,
    dnsStatus: right.dnsStatus,
    directStatus: right.directStatus,
  };
}

function mergeAverage(
  previous: number | null,
  previousCount: number,
  next: number | null,
): number | null {
  if (previous === null) return next;
  if (next === null) return previous;
  return (previous * previousCount + next) / (previousCount + 1);
}

function weightedAverage(
  left: number | null,
  leftCount: number,
  right: number | null,
  rightCount: number,
): number | null {
  if (left === null || leftCount === 0) return right;
  if (right === null || rightCount === 0) return left;
  return (left * leftCount + right * rightCount) / (leftCount + rightCount);
}

function deriveNetworkQualityEvents(
  previous: NetworkQualityHistoryPoint | undefined,
  sample: NetworkQualityResult,
  networkSignatureHash: string | null,
): NetworkQualityHistoryEvent[] {
  const events: NetworkQualityHistoryEvent[] = [];
  if (
    previous
    && sample.sampledAtMs - previous.sampledAtMs > 12 * 60 * 1_000
  ) {
    events.push({ kind: "sleep_gap", atMs: sample.sampledAtMs });
  }
  if (
    previous?.networkSignatureHash
    && networkSignatureHash
    && previous.networkSignatureHash !== networkSignatureHash
  ) {
    events.push({ kind: "interface_change", atMs: sample.sampledAtMs });
  }
  if (previous && previous.status !== sample.status) {
    events.push({
      kind: "status_change",
      atMs: sample.sampledAtMs,
      previousStatus: previous.status,
      status: sample.status,
    });
  }
  const dnsStatus = diagnosticStatus(sample, "dns");
  if (
    (dnsStatus === "failed" || dnsStatus === "degraded")
    && previous?.dnsStatus !== dnsStatus
  ) {
    events.push({ kind: "dns_failure", atMs: sample.sampledAtMs });
  }
  const directStatus = diagnosticStatus(sample, "internet");
  if (
    (directStatus === "failed" || directStatus === "degraded")
    && previous?.directStatus !== directStatus
  ) {
    events.push({ kind: "direct_failure", atMs: sample.sampledAtMs });
  }
  return events;
}

function diagnosticStatus(
  sample: NetworkQualityResult,
  kind: "dns" | "internet",
): NetworkQualityHistoryPoint["dnsStatus"] {
  return sample.diagnostics.find((diagnostic) => diagnostic.kind === kind)?.status
    ?? "unavailable";
}

function stableNetworkSignatureHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function deduplicateEvents(
  events: readonly NetworkQualityHistoryEvent[],
): NetworkQualityHistoryEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.kind}:${event.atMs}:${event.status ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function worseStatus(
  left: NetworkQualityStatus,
  right: NetworkQualityStatus,
): NetworkQualityStatus {
  const order: Record<NetworkQualityStatus, number> = {
    online: 0,
    limited: 1,
    offline: 2,
  };
  return order[left] >= order[right] ? left : right;
}

function isNetworkQualityHistoryPoint(
  value: unknown,
): value is NetworkQualityHistoryPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<NetworkQualityHistoryPoint>;
  return (
    finite(point.bucketStartMs)
    && finite(point.sampledAtMs)
    && finite(point.sampleCount)
    && (point.status === "online"
      || point.status === "limited"
      || point.status === "offline")
    && nullableFinite(point.dnsLookupMs)
    && finite(point.dnsSampleCount)
    && nullableFinite(point.averageLatencyMs)
    && finite(point.latencySampleCount)
    && nullableFinite(point.jitterMs)
    && finite(point.jitterSampleCount)
    && finite(point.probeCount)
    && finite(point.successfulProbeCount)
  );
}

function normalizeHistoryPoint(
  point: NetworkQualityHistoryPoint,
): NetworkQualityHistoryPoint {
  return {
    ...point,
    events: Array.isArray(point.events)
      ? point.events.filter(isNetworkQualityHistoryEvent)
      : [],
    networkSignatureHash:
      typeof point.networkSignatureHash === "string"
        ? point.networkSignatureHash
        : null,
    dnsStatus: validDiagnosticStatus(point.dnsStatus)
      ? point.dnsStatus
      : "unavailable",
    directStatus: validDiagnosticStatus(point.directStatus)
      ? point.directStatus
      : "unavailable",
  };
}

function isNetworkQualityHistoryEvent(
  value: unknown,
): value is NetworkQualityHistoryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<NetworkQualityHistoryEvent>;
  return (
    (event.kind === "sleep_gap"
      || event.kind === "interface_change"
      || event.kind === "status_change"
      || event.kind === "dns_failure"
      || event.kind === "direct_failure")
    && finite(event.atMs)
  );
}

function validDiagnosticStatus(
  value: unknown,
): value is NetworkQualityHistoryPoint["dnsStatus"] {
  return value === "passed"
    || value === "degraded"
    || value === "failed"
    || value === "unavailable";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || finite(value);
}
