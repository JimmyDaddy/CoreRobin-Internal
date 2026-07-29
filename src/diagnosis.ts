import { volumeUsage } from "./storageExplorer";
import type {
  HistoryPoint,
  NetworkConnectionsSnapshot,
  ProcessDetailRequest,
  ProcessRow,
  SystemHealthSnapshot,
} from "./types";
import { memoryUsagePercent, processDiskRate, processIdentity } from "./utils";

const MEBIBYTE = 1_024 ** 2;
const GIBIBYTE = 1_024 ** 3;

export const DIAGNOSIS_SUSTAINED_MS = 10_000;
export const DIAGNOSIS_CPU_THRESHOLD = 75;
export const DIAGNOSIS_DISK_RATE_THRESHOLD = 50 * MEBIBYTE;
export const DIAGNOSIS_NETWORK_RATE_THRESHOLD = 25 * MEBIBYTE;
export const DIAGNOSIS_CONNECTION_COUNT_THRESHOLD = 500;

export const DIAGNOSIS_CATEGORIES = [
  "cpu",
  "memory",
  "storage",
  "disk_io",
  "network",
] as const;

export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number];
export type DiagnosisStatus = "observing" | "healthy" | "attention" | "urgent";
export type DiagnosisSeverity = "attention" | "urgent";
export type DiagnosisFindingCode =
  | "sustained_cpu"
  | "memory_pressure"
  | "low_storage"
  | "busy_disk"
  | "high_network";
export type DiagnosisActionTarget = "processes" | "storage" | "cleanup" | "network";
export type DiagnosisRecommendationKind =
  | "request_close"
  | "open_cleanup"
  | "open_network"
  | "inspect_process";
export type DiagnosisRecommendationSafety =
  | "safe"
  | "confirmation"
  | "protected";

export interface ApplicationImpact {
  id: string;
  applicationId?: string;
  name: string;
  processCount: number;
  cpuPercent: number;
  memoryBytes: number;
  diskBytesPerSecond: number;
  systemComponent: boolean;
  representativeIdentity: string;
  actionIdentity: string | null;
  memberIdentities: string[];
  iconProcess: ProcessDetailRequest;
}

export interface DiagnosisRecommendation {
  kind: DiagnosisRecommendationKind;
  safety: DiagnosisRecommendationSafety;
  target: DiagnosisActionTarget;
  processIdentity: string | null;
  applicationName: string | null;
}

export interface DiagnosisFinding {
  id: DiagnosisFindingCode;
  code: DiagnosisFindingCode;
  category: DiagnosisCategory;
  severity: DiagnosisSeverity;
  actionTarget: DiagnosisActionTarget;
  value: number;
  threshold: number;
  durationMs: number;
  secondaryValue: number | null;
  resourceLabel: string | null;
  culprit: ApplicationImpact | null;
  recommendation: DiagnosisRecommendation;
}

type DiagnosisFindingDraft = Omit<DiagnosisFinding, "recommendation">;

export interface SmartDiagnosisResult {
  analyzedAtMs: number;
  status: DiagnosisStatus;
  findings: DiagnosisFinding[];
  applications: ApplicationImpact[];
  baselineReady: boolean;
  sampleSpanMs: number;
  checkedCategories: readonly DiagnosisCategory[];
}

export interface SmartDiagnosisInput {
  snapshot: SystemHealthSnapshot;
  history: readonly HistoryPoint[];
  connections: NetworkConnectionsSnapshot | null;
}

export function analyzeSystemHealth({
  snapshot,
  history,
  connections,
}: SmartDiagnosisInput): SmartDiagnosisResult {
  const orderedHistory = [...history].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const sampleSpanMs = Math.max(
    0,
    (orderedHistory[orderedHistory.length - 1]?.timestamp ?? snapshot.sampledAtMs) -
      (orderedHistory[0]?.timestamp ?? snapshot.sampledAtMs),
  );
  const baselineReady = sampleSpanMs >= DIAGNOSIS_SUSTAINED_MS;
  const applications = aggregateApplications(snapshot.processes ?? []);
  const findings = [
    diagnoseCpu(snapshot, orderedHistory, applications),
    diagnoseMemory(snapshot, orderedHistory, applications),
    diagnoseStorage(snapshot),
    diagnoseDisk(snapshot, orderedHistory, applications),
    diagnoseNetwork(snapshot, orderedHistory, connections),
  ]
    .filter((finding): finding is DiagnosisFindingDraft => finding !== null)
    .map((finding) => ({
      ...finding,
      recommendation: recommendationFor(finding, snapshot),
    }))
    .sort(compareFindings);

  return {
    analyzedAtMs: snapshot.sampledAtMs,
    status: diagnosisStatus(findings, baselineReady),
    findings,
    applications,
    baselineReady,
    sampleSpanMs,
    checkedCategories: DIAGNOSIS_CATEGORIES,
  };
}

export function aggregateApplications(
  processes: readonly ProcessRow[],
): ApplicationImpact[] {
  const processesByPid = new Map(processes.map((process) => [process.pid, process]));
  const groups = new Map<string, { name: string; members: ProcessRow[] }>();
  for (const process of processes) {
    const name = applicationGroupName(process, processesByPid);
    const stableId = process.applicationId ?? `name:${name.toLocaleLowerCase()}`;
    const key = `${process.user ?? "system"}:${stableId}`;
    const group = groups.get(key) ?? { name, members: [] };
    group.members.push(process);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([id, { name, members }]) => {
      const representative = [...members].sort(
        (left, right) =>
          (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0) ||
          right.memoryBytes - left.memoryBytes ||
          processIdentity(left).localeCompare(processIdentity(right)),
      )[0];
      if (!representative) return null;
      const actionProcess = applicationActionProcess(members);
      return {
        id,
        applicationId:
          members.find((member) => member.applicationId)?.applicationId
          ?? `name:${name.toLocaleLowerCase()}`,
        name,
        processCount: members.length,
        cpuPercent: members.reduce(
          (total, process) => total + Math.max(0, process.cpuPercent ?? 0),
          0,
        ),
        memoryBytes: members.reduce(
          (total, process) => total + Math.max(0, process.memoryBytes),
          0,
        ),
        diskBytesPerSecond: members.reduce(
          (total, process) => total + Math.max(0, processDiskRate(process) ?? 0),
          0,
        ),
        systemComponent: members.every(isSystemProcess),
        representativeIdentity: processIdentity(representative),
        actionIdentity: actionProcess ? processIdentity(actionProcess) : null,
        memberIdentities: members.map(processIdentity),
        iconProcess: {
          pid: representative.pid,
          snapshotStartTime: representative.startTime,
          snapshotBirthToken: representative.birthToken,
        },
      };
    })
    .filter(
      (application): application is NonNullable<typeof application> =>
        application !== null,
    )
    .sort(
      (left, right) =>
        right.cpuPercent - left.cpuPercent ||
        right.memoryBytes - left.memoryBytes ||
        left.name.localeCompare(right.name),
    );
}

function diagnoseCpu(
  snapshot: SystemHealthSnapshot,
  history: readonly HistoryPoint[],
  applications: readonly ApplicationImpact[],
): DiagnosisFindingDraft | null {
  const durationMs = sustainedTailDuration(
    history,
    (point) => point.cpuPercent >= DIAGNOSIS_CPU_THRESHOLD,
    snapshot,
  );
  if (durationMs < DIAGNOSIS_SUSTAINED_MS) return null;
  const value = history[history.length - 1]?.cpuPercent ?? snapshot.cpu.usagePercent ?? 0;
  const culprit = highestApplication(applications, "cpuPercent", 20);
  return finding({
    code: "sustained_cpu",
    category: "cpu",
    severity: value >= 90 ? "urgent" : "attention",
    actionTarget: "processes",
    value,
    threshold: DIAGNOSIS_CPU_THRESHOLD,
    durationMs,
    secondaryValue: culprit?.cpuPercent ?? null,
    culprit,
  });
}

function diagnoseMemory(
  snapshot: SystemHealthSnapshot,
  history: readonly HistoryPoint[],
  applications: readonly ApplicationImpact[],
): DiagnosisFindingDraft | null {
  const { memory } = snapshot;
  if (memory.totalBytes <= 0) return null;
  const availablePercent = Math.min(
    100,
    Math.max(0, memory.availableBytes / memory.totalBytes * 100),
  );
  const usedPercent = memoryUsagePercent(memory.usedBytes, memory.totalBytes);
  const hasSwapPressure =
    memory.swapUsedBytes >= 512 * MEBIBYTE &&
    (memory.swapTotalBytes <= 0 || memory.swapUsedBytes / memory.swapTotalBytes >= 0.1);
  const durationMs = sustainedTailDuration(
    history,
    (point) => point.memoryPercent >= 90,
    snapshot,
  );
  const immediateUrgent = availablePercent <= 3 && memory.swapUsedBytes >= GIBIBYTE;
  const sustainedPressure =
    availablePercent <= 10 &&
    hasSwapPressure &&
    durationMs >= DIAGNOSIS_SUSTAINED_MS;
  if (!immediateUrgent && !sustainedPressure) return null;
  const culprit = highestApplication(
    applications,
    "memoryBytes",
    memory.totalBytes * 0.08,
  );
  return finding({
    code: "memory_pressure",
    category: "memory",
    severity: availablePercent <= 5 && memory.swapUsedBytes >= GIBIBYTE
      ? "urgent"
      : "attention",
    actionTarget: "processes",
    value: usedPercent,
    threshold: 90,
    durationMs: immediateUrgent ? 0 : durationMs,
    secondaryValue: memory.swapUsedBytes,
    culprit,
  });
}

function diagnoseStorage(snapshot: SystemHealthSnapshot): DiagnosisFindingDraft | null {
  const volumes = snapshot.disk.volumes
    .filter((volume) => volume.totalBytes >= 4 * GIBIBYTE)
    .map(volumeUsage)
    .sort(
      (left, right) =>
        left.volume.availableBytes - right.volume.availableBytes ||
        right.usagePercent - left.usagePercent,
    );
  const constrained = volumes.find(
    ({ volume, usagePercent }) =>
      usagePercent >= 85 || volume.availableBytes <= 10 * GIBIBYTE,
  );
  if (!constrained) return null;
  const urgent =
    constrained.usagePercent >= 95 ||
    constrained.volume.availableBytes <= 2 * GIBIBYTE;
  return finding({
    code: "low_storage",
    category: "storage",
    severity: urgent ? "urgent" : "attention",
    actionTarget: "storage",
    value: constrained.usagePercent,
    threshold: urgent ? 95 : 85,
    durationMs: 0,
    secondaryValue: constrained.volume.availableBytes,
    culprit: null,
    resourceLabel:
      constrained.volume.name || constrained.volume.mountPoint || null,
  });
}

function diagnoseDisk(
  snapshot: SystemHealthSnapshot,
  history: readonly HistoryPoint[],
  applications: readonly ApplicationImpact[],
): DiagnosisFindingDraft | null {
  const durationMs = sustainedTailDuration(
    history,
    (point) => rateTotal(
      point.diskReadBytesPerSecond,
      point.diskWriteBytesPerSecond,
    ) >= DIAGNOSIS_DISK_RATE_THRESHOLD,
    snapshot,
  );
  if (durationMs < DIAGNOSIS_SUSTAINED_MS) return null;
  const latest = history[history.length - 1];
  const value = latest
    ? rateTotal(latest.diskReadBytesPerSecond, latest.diskWriteBytesPerSecond)
    : rateTotal(
        snapshot.disk.readBytesPerSecond,
        snapshot.disk.writeBytesPerSecond,
      );
  const culprit = highestApplication(
    applications,
    "diskBytesPerSecond",
    5 * MEBIBYTE,
  );
  return finding({
    code: "busy_disk",
    category: "disk_io",
    severity: value >= 200 * MEBIBYTE ? "urgent" : "attention",
    actionTarget: "processes",
    value,
    threshold: DIAGNOSIS_DISK_RATE_THRESHOLD,
    durationMs,
    secondaryValue: culprit?.diskBytesPerSecond ?? null,
    culprit,
  });
}

function diagnoseNetwork(
  snapshot: SystemHealthSnapshot,
  history: readonly HistoryPoint[],
  connections: NetworkConnectionsSnapshot | null,
): DiagnosisFindingDraft | null {
  const durationMs = sustainedTailDuration(
    history,
    (point) => rateTotal(
      point.networkReceivedBytesPerSecond,
      point.networkTransmittedBytesPerSecond,
    ) >= DIAGNOSIS_NETWORK_RATE_THRESHOLD,
    snapshot,
  );
  const connectionCount = connections?.summary.totalCount ?? 0;
  const highTraffic = durationMs >= DIAGNOSIS_SUSTAINED_MS;
  const manyConnections = connectionCount >= DIAGNOSIS_CONNECTION_COUNT_THRESHOLD;
  if (!highTraffic && !manyConnections) return null;
  const latest = history[history.length - 1];
  const value = latest
    ? rateTotal(
        latest.networkReceivedBytesPerSecond,
        latest.networkTransmittedBytesPerSecond,
      )
    : rateTotal(
        snapshot.network.receivedBytesPerSecond,
        snapshot.network.transmittedBytesPerSecond,
      );
  return finding({
    code: "high_network",
    category: "network",
    severity:
      value >= 100 * MEBIBYTE || connectionCount >= 1_000
        ? "urgent"
        : "attention",
    actionTarget: "network",
    value,
    threshold: DIAGNOSIS_NETWORK_RATE_THRESHOLD,
    durationMs: highTraffic ? durationMs : 0,
    secondaryValue: connectionCount,
    culprit: null,
  });
}

function sustainedTailDuration(
  history: readonly HistoryPoint[],
  predicate: (point: HistoryPoint) => boolean,
  snapshot: Pick<SystemHealthSnapshot, "sampledAtMs" | "sampleIntervalMs">,
): number {
  const latest = history[history.length - 1];
  if (!latest || !predicate(latest)) return 0;
  const maximumGap = Math.max(6_000, snapshot.sampleIntervalMs * 2.5);
  if (snapshot.sampledAtMs - latest.timestamp > maximumGap) return 0;
  let firstTimestamp = latest.timestamp;
  let nextTimestamp = latest.timestamp;
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const point = history[index];
    if (!point || !predicate(point) || nextTimestamp - point.timestamp > maximumGap) {
      break;
    }
    firstTimestamp = point.timestamp;
    nextTimestamp = point.timestamp;
  }
  return Math.max(0, latest.timestamp - firstTimestamp);
}

function highestApplication(
  applications: readonly ApplicationImpact[],
  metric: "cpuPercent" | "memoryBytes" | "diskBytesPerSecond",
  minimum: number,
): ApplicationImpact | null {
  const highest = [...applications].sort(
    (left, right) => right[metric] - left[metric],
  )[0];
  return highest && highest[metric] >= minimum ? highest : null;
}

function finding(
  input: Omit<DiagnosisFindingDraft, "id" | "resourceLabel"> & {
    resourceLabel?: string | null;
  },
): DiagnosisFindingDraft {
  return {
    ...input,
    id: input.code,
    resourceLabel: input.resourceLabel ?? null,
  };
}

function recommendationFor(
  finding: DiagnosisFindingDraft,
  snapshot: SystemHealthSnapshot,
): DiagnosisRecommendation {
  if (finding.code === "low_storage") {
    return {
      kind: "open_cleanup",
      safety: "safe",
      target: "cleanup",
      processIdentity: null,
      applicationName: null,
    };
  }
  if (finding.code === "high_network") {
    return {
      kind: "open_network",
      safety: "safe",
      target: "network",
      processIdentity: null,
      applicationName: null,
    };
  }

  const culprit = finding.culprit;
  if (culprit?.systemComponent) {
    return {
      kind: "inspect_process",
      safety: "protected",
      target: "processes",
      processIdentity: culprit.representativeIdentity,
      applicationName: culprit.name,
    };
  }
  if (
    culprit?.actionIdentity &&
    snapshot.capabilities?.processControl.requestClose.enabled
  ) {
    return {
      kind: "request_close",
      safety: "confirmation",
      target: "processes",
      processIdentity: culprit.actionIdentity,
      applicationName: culprit.name,
    };
  }
  return {
    kind: "inspect_process",
    safety: "safe",
    target: "processes",
    processIdentity: culprit?.representativeIdentity ?? null,
    applicationName: culprit?.name ?? null,
  };
}

function diagnosisStatus(
  findings: readonly DiagnosisFinding[],
  baselineReady: boolean,
): DiagnosisStatus {
  if (findings.some(({ severity }) => severity === "urgent")) return "urgent";
  if (findings.length > 0) return "attention";
  return baselineReady ? "healthy" : "observing";
}

function compareFindings(
  left: DiagnosisFinding,
  right: DiagnosisFinding,
): number {
  const severity = Number(right.severity === "urgent") - Number(left.severity === "urgent");
  if (severity !== 0) return severity;
  return DIAGNOSIS_CATEGORIES.indexOf(left.category) -
    DIAGNOSIS_CATEGORIES.indexOf(right.category);
}

function applicationName(processName: string): string {
  const normalized = processName.trim().replace(/\.exe$/i, "");
  const helper = normalized.match(/^(.+?) Helper(?: \(.+\))?$/i);
  return helper?.[1]?.trim() || normalized || "Unknown application";
}

function applicationGroupName(
  process: ProcessRow,
  processesByPid: ReadonlyMap<number, ProcessRow>,
): string {
  let candidate = process;
  let name = applicationName(candidate.name);
  const visited = new Set<number>([candidate.pid]);
  for (let depth = 0; depth < 6 && isGenericRuntimeName(name); depth += 1) {
    const parent = candidate.parentPid === null
      ? null
      : processesByPid.get(candidate.parentPid) ?? null;
    if (
      !parent ||
      visited.has(parent.pid) ||
      parent.user !== process.user ||
      isSystemProcess(parent)
    ) {
      break;
    }
    visited.add(parent.pid);
    candidate = parent;
    name = applicationName(candidate.name);
  }
  return name;
}

function isGenericRuntimeName(name: string): boolean {
  return /^(?:node|bun|deno|python(?:\d+(?:\.\d+)*)?|ruby|java|php|perl|bash|zsh|sh|fish|cargo|rustc|clang|swift|make|cmake)$/i.test(name);
}

function applicationActionProcess(members: readonly ProcessRow[]): ProcessRow | null {
  const memberPids = new Set(members.map(({ pid }) => pid));
  return [...members]
    .filter((process) =>
      process.birthToken !== null && !process.protected && !isSystemProcess(process))
    .sort((left, right) => {
      const leftIsRoot = left.parentPid === null || !memberPids.has(left.parentPid);
      const rightIsRoot = right.parentPid === null || !memberPids.has(right.parentPid);
      const leftIsHelper = / Helper(?: \(.+\))?$/i.test(left.name);
      const rightIsHelper = / Helper(?: \(.+\))?$/i.test(right.name);
      return Number(rightIsRoot) - Number(leftIsRoot) ||
        Number(leftIsHelper) - Number(rightIsHelper) ||
        left.startTime - right.startTime ||
        left.pid - right.pid;
    })[0] ?? null;
}

function isSystemProcess(process: ProcessRow): boolean {
  const user = process.user?.toLocaleLowerCase() ?? "";
  return (
    process.protected ||
    user === "root" ||
    user === "system" ||
    user === "local service" ||
    user === "network service" ||
    user.startsWith("_")
  );
}

function rateTotal(left: number | null, right: number | null): number {
  return Math.max(0, left ?? 0) + Math.max(0, right ?? 0);
}
