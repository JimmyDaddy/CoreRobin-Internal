export const SNAPSHOT_SCHEMA_VERSION = 4;

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
  receivedBytesSinceLaunch: number;
  transmittedBytesSinceLaunch: number;
  interfaceCount: number;
  interfaces: NetworkInterfaceSnapshot[];
}

export type NetworkInterfaceOperationalState =
  | "other"
  | "up"
  | "down"
  | "testing"
  | "unknown"
  | "dormant"
  | "notpresent"
  | "lowerlayerdown";

export interface NetworkInterfaceSnapshot {
  name: string;
  receivedBytesPerSecond: number | null;
  transmittedBytesPerSecond: number | null;
  receivedBytesSinceLaunch: number;
  transmittedBytesSinceLaunch: number;
  packetsReceivedSinceLaunch: number;
  packetsTransmittedSinceLaunch: number;
  receiveErrorsSinceLaunch: number;
  transmitErrorsSinceLaunch: number;
  mtu: number;
  macAddress: string | null;
  ipNetworks: string[];
  operationalState: NetworkInterfaceOperationalState;
}

export type NetworkTransportProtocol = "tcp" | "udp";
export type NetworkAddressFamily = "ipv4" | "ipv6";
export type NetworkConnectionState =
  | "closed"
  | "listen"
  | "syn_sent"
  | "syn_received"
  | "established"
  | "fin_wait1"
  | "fin_wait2"
  | "close_wait"
  | "closing"
  | "last_ack"
  | "time_wait"
  | "delete_tcb"
  | "unconnected"
  | "unknown";

export interface NetworkEndpoint {
  address: string;
  port: number;
}

export interface NetworkConnection {
  protocol: NetworkTransportProtocol;
  addressFamily: NetworkAddressFamily;
  localEndpoint: NetworkEndpoint;
  remoteEndpoint: NetworkEndpoint | null;
  state: NetworkConnectionState;
}

export interface NetworkConnectionSummary {
  totalCount: number;
  tcpCount: number;
  udpCount: number;
  establishedCount: number;
  listeningCount: number;
}

export interface NetworkConnectionsSnapshot {
  sampledAtMs: number;
  summary: NetworkConnectionSummary;
  connections: NetworkConnection[];
  truncated: boolean;
  skippedEntryCount: number;
}

export interface ProcessRow {
  pid: number;
  birthToken: string | null;
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
  processControl: ProcessControlCapabilities;
  requiresConfirmation: boolean;
}

export type ProcessControlTargeting =
  | "stable_handle"
  | "best_effort_pid"
  | "unavailable";

export type ProcessActionSemantic = "sigterm" | "sigkill" | "terminate_process";

export interface ProcessActionCapability {
  enabled: boolean;
  semantic: ProcessActionSemantic | null;
  disabledReason: string | null;
}

export interface ProcessControlCapabilities {
  targeting: ProcessControlTargeting;
  requestClose: ProcessActionCapability;
  forceKill: ProcessActionCapability;
  leaseTtlMs: number;
}

export interface ProcessKey {
  pid: number;
  birthToken: string;
}

export interface ProcessDetailRequest {
  pid: number;
  snapshotStartTime: number;
  snapshotBirthToken: string | null;
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

export interface ProcessControlLeaseRequest {
  key: ProcessKey;
  action: ProcessAction;
  acknowledgeBestEffort: boolean;
}

export interface ProcessControlLease {
  id: string;
  key: ProcessKey;
  action: ProcessAction;
  targeting: ProcessControlTargeting;
  expiresAtMs: number;
}

export interface ProcessControlLeaseReleaseRequest {
  leaseId: string;
}

export interface ProcessActionRequest {
  leaseId: string;
  key: ProcessKey;
  action: ProcessAction;
}

export type ProcessActionOutcome = "exited" | "still_running" | "already_exited";

export interface ProcessActionResult {
  signalSent: boolean;
  outcome: ProcessActionOutcome;
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
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  networkReceivedBytesPerSecond: number | null;
  networkTransmittedBytesPerSecond: number | null;
}

export interface ProcessHistoryPoint {
  sequence: number;
  timestamp: number;
  cpuPercent: number | null;
  memoryBytes: number;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
}

export type ProcessSortKey = "cpu" | "memory" | "disk" | "name";
export type SortDirection = "ascending" | "descending";
export type ProcessViewMode = "flat" | "tree";
