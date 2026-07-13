export interface SystemSnapshot {
  schemaVersion: number;
  sequence: number;
  sampledAtMs: number;
  sampleIntervalMs: number;
  warmingUp: boolean;
  host: HostSnapshot;
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  disk: DiskSnapshot;
  network: NetworkSnapshot;
  processes: ProcessRow[];
  capabilities: Capabilities;
}

export interface HostSnapshot {
  hostname: string;
  osName: string;
  osVersion: string;
  kernelVersion: string;
  architecture: string;
  cpuName: string;
}

export interface CpuSnapshot {
  usagePercent: number | null;
  perCorePercent: number[];
  logicalCoreCount: number;
}

export interface MemorySnapshot {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface DiskSnapshot {
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  volumes: VolumeSnapshot[];
}

export interface VolumeSnapshot {
  name: string;
  mountPoint: string;
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
}

export interface NetworkSnapshot {
  receivedBytesPerSecond: number | null;
  transmittedBytesPerSecond: number | null;
  interfaceCount: number;
}

export interface ProcessRow {
  pid: number;
  parentPid: number | null;
  startTime: number;
  runTimeSeconds: number;
  name: string;
  user: string | null;
  status: string;
  cpuPercent: number | null;
  memoryBytes: number;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  protected: boolean;
}

export interface Capabilities {
  platform: string;
  requestClose: boolean;
  forceKill: boolean;
  requiresConfirmation: boolean;
}

export interface ProcessKey {
  pid: number;
  birthToken: string;
}

export interface ProcessDetailRequest {
  pid: number;
  snapshotStartTime: number;
}

export interface ProcessDetail {
  key: ProcessKey | null;
  pid: number;
  parentPid: number | null;
  startTime: number;
  runTimeSeconds: number;
  name: string;
  user: string | null;
  status: string;
  cpuPercent: number | null;
  memoryBytes: number;
  virtualMemoryBytes: number;
  executable: string | null;
  commandLine: string | null;
  canTerminate: boolean;
  protectedReason: string | null;
  identityError: string | null;
}

export type ProcessAction = "request_close" | "force_kill";

export interface ProcessActionRequest {
  key: ProcessKey;
  action: ProcessAction;
}

export interface ProcessActionResult {
  signalSent: boolean;
  outcome: string;
  message: string;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface HistoryPoint {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
}

export type ProcessSortKey = "cpu" | "memory" | "disk" | "name";
export type SortDirection = "ascending" | "descending";
