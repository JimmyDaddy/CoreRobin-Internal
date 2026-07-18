export const SNAPSHOT_SCHEMA_VERSION = 7;

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
  sensors: SensorsSnapshot;
  processes: ProcessRow[];
  capabilities: Capabilities;
}

export interface SystemSummary {
  sequence: number;
  sampledAtMs: number;
  sampleIntervalMs: number;
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  disk: DiskSnapshot;
  network: NetworkSnapshot;
  sensors: SensorsSnapshot;
}

export type SystemHealthSnapshot = Pick<
  SystemSnapshot,
  | "sequence"
  | "sampledAtMs"
  | "sampleIntervalMs"
  | "cpu"
  | "memory"
  | "disk"
  | "network"
  | "sensors"
> & Partial<Pick<SystemSnapshot, "processes" | "capabilities">>;

export type BatteryState =
  | "charging"
  | "discharging"
  | "full"
  | "not_charging"
  | "unknown";
export type PowerSource = "ac" | "battery" | "unknown";

export interface SensorsSnapshot {
  sampledAtMs: number;
  temperature: TemperatureSnapshot;
  battery: BatterySnapshot;
  sleep: SleepSnapshot;
}

export interface TemperatureSnapshot {
  celsius: number | null;
  componentLabel: string | null;
  criticalCelsius: number | null;
}

export interface BatterySnapshot {
  present: boolean;
  chargePercent: number | null;
  healthPercent: number | null;
  cycleCount: number | null;
  state: BatteryState;
  timeRemainingMinutes: number | null;
  powerSource: PowerSource;
}

export type SleepBlockerKind = "system_sleep" | "idle_sleep" | "display_sleep";

export interface SleepSnapshot {
  sampledAtMs: number;
  available: boolean;
  blockers: SleepBlocker[];
}

export interface SleepBlocker {
  pid: number | null;
  processName: string;
  reason: string | null;
  kind: SleepBlockerKind;
  durationSeconds: number | null;
}

export type StartupItemSource =
  | "launch_agent"
  | "launch_daemon"
  | "desktop_entry"
  | "registry_run"
  | "startup_folder";
export type StartupItemScope = "user" | "system";
export type StartupLaunchKind = "login" | "conditional";
export type StartupManagementStatus =
  | "available"
  | "system"
  | "protected"
  | "unsupported";
export type StartupManagementAction = "disable" | "enable";

export interface StartupItemsSnapshot {
  sampledAtMs: number;
  items: StartupItem[];
  unreadableLocationCount: number;
  managementAvailable: boolean;
}

export interface StartupItem {
  id: string;
  name: string;
  publisher: string | null;
  command: string | null;
  path: string;
  source: StartupItemSource;
  scope: StartupItemScope;
  enabled: boolean;
  system: boolean;
  launchKind: StartupLaunchKind;
  managementStatus: StartupManagementStatus;
}

export interface StartupManagementLeaseRequest {
  itemId: string;
  action: StartupManagementAction;
}

export interface StartupManagementLease {
  id: string;
  itemId: string;
  itemName: string;
  action: StartupManagementAction;
  expiresAtMs: number;
}

export interface StartupManagementExecutionRequest {
  leaseId: string;
}

export interface StartupManagementLeaseReleaseRequest {
  leaseId: string;
}

export interface StartupManagementResult {
  itemId: string;
  enabled: boolean;
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

export type CleanupLocationKind =
  | "downloads"
  | "trash"
  | "app_cache"
  | "developer_cache"
  | "hidden_data";
export type CleanupSafety = "reclaimable" | "review";
export type CleanupNodeKind = "folder" | "file" | "aggregate" | "restricted";
export type CleanupProtectionReason =
  | "system_location"
  | "home_root"
  | "trash_root"
  | "sensitive_user_data"
  | "aggregate"
  | "restricted";

export interface CleanupScan {
  sampledAtMs: number;
  durationMs: number;
  /** The actual directory hierarchy rooted at the scanned system disk. */
  root: CleanupNode;
  locations: CleanupLocation[];
  largestFiles: CleanupFile[];
  installedApplications: CleanupApplication[];
  applicationInventoryAvailable: boolean;
  scannedEntryCount: number;
  unreadableEntryCount: number;
  unreadablePaths: string[];
  deletionAvailable: boolean;
}

export interface CleanupApplication {
  name: string;
  path: string;
  sizeBytes: number;
  lastUsedAtMs: number | null;
  modifiedAtMs: number | null;
}

export interface CleanupLocation {
  kind: CleanupLocationKind;
  paths: string[];
  sizeBytes: number;
  itemCount: number;
  safety: CleanupSafety;
  available: boolean;
  nodes: CleanupNode[];
}

export interface CleanupNode {
  id: string;
  name: string;
  path: string | null;
  /** Physical/allocated bytes and the primary value shown in the cleanup UI. */
  sizeBytes: number;
  logicalSizeBytes: number;
  allocatedSizeBytes: number;
  itemCount: number;
  safety: CleanupSafety;
  kind: CleanupNodeKind;
  /** Backend-derived hint for the UI. Delete leases enforce the same policy again. */
  deletionProtected?: boolean;
  protectionReason?: CleanupProtectionReason | null;
  hasChildren: boolean;
  children: CleanupNode[];
}

export interface CleanupSubtreeRequest {
  requestId: string;
  path: string;
  safety: CleanupSafety;
}

export interface CleanupScanProgress {
  scannedEntryCount: number;
  discoveredBytes: number;
  currentPath: string;
  elapsedMs: number;
}

export type CleanupFullDiskAccessStatus =
  | "granted"
  | "not_granted"
  | "not_required"
  | "unknown";

export interface CleanupScanAccess {
  fullDiskAccess: CleanupFullDiskAccessStatus;
  fullDiskAccessRecommended: boolean;
  applicationBundleAvailable: boolean;
  applicationBundlePath: string | null;
}

export interface CleanupPathState {
  path: string;
  exists: boolean;
  modifiedAtMs: number | null;
}

export interface CleanupDeleteLeaseRequest {
  paths: string[];
  scanSampledAtMs: number;
  expectedTargets: CleanupDeleteTargetEvidence[];
  mode: CleanupDeleteMode;
}

export type CleanupDeleteMode = "trash" | "permanent";

export interface CleanupDeleteTargetEvidence {
  path: string;
  logicalSizeBytes: number;
  allocatedSizeBytes: number;
  itemCount: number;
}

export interface CleanupDeleteLease {
  id: string;
  mode: CleanupDeleteMode;
  paths: string[];
  changedPaths: string[];
  refreshedTargets: CleanupDeleteTargetEvidence[];
  executable: boolean;
  refreshedAtMs: number;
  expiresAtMs: number;
}

export interface CleanupDeleteExecutionRequest {
  leaseId: string;
}

export interface CleanupDeleteLeaseReleaseRequest {
  leaseId: string;
}

export interface CleanupDeleteResult {
  deleted: CleanupDeleteSuccess[];
  deletedBytes: number;
  failed: CleanupDeleteFailure[];
  cancelled: boolean;
  interruptedPath: string | null;
}

export type CleanupDeleteProgressPhase = "preparing" | "moving_to_trash" | "deleting";

export interface CleanupDeleteProgress {
  phase: CleanupDeleteProgressPhase;
  processedEntryCount: number;
  totalEntryCount: number;
  completedTargetCount: number;
  totalTargetCount: number;
  currentPath: string;
  deletedBytes: number;
}

export interface CleanupDeleteSuccess {
  path: string;
  deletedBytes: number;
}

export interface CleanupDeleteFailure {
  path: string;
  message: string;
}

export interface CleanupFile {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAtMs: number | null;
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
  associatedPids: number[];
}

export type NetworkProcessAttribution =
  | "available"
  | "partial"
  | "unavailable";

export interface NetworkConnectionSummary {
  totalCount: number;
  tcpCount: number;
  udpCount: number;
  establishedCount: number;
  listeningCount: number;
  attributedCount: number;
}

export interface NetworkConnectionsSnapshot {
  sampledAtMs: number;
  summary: NetworkConnectionSummary;
  connections: NetworkConnection[];
  processAttribution: NetworkProcessAttribution;
  truncated: boolean;
  skippedEntryCount: number;
}

export type NetworkQualityStatus = "online" | "limited" | "offline";

export interface NetworkQualityResult {
  sampledAtMs: number;
  targetHost: string;
  targetPort: number;
  status: NetworkQualityStatus;
  dnsAvailable: boolean;
  dnsLookupMs: number | null;
  resolvedAddressCount: number;
  probeCount: number;
  successfulProbeCount: number;
  averageLatencyMs: number | null;
  minimumLatencyMs: number | null;
  maximumLatencyMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number;
}

export interface NetworkHostLookup {
  address: string;
  hostname: string | null;
}

export interface StartupContext {
  backgroundLaunch: boolean;
  launchedAtMs: number;
}

export type FileInsightsPhase = "discovering" | "hashing";

export interface FileInsightsProgress {
  phase: FileInsightsPhase;
  scannedEntryCount: number;
  candidateFileCount: number;
  hashedFileCount: number;
  currentPath: string;
}

export interface FileInsightsScan {
  sampledAtMs: number;
  durationMs: number;
  scannedEntryCount: number;
  candidateFileCount: number;
  hashedFileCount: number;
  duplicateGroups: DuplicateFileGroup[];
  longUnmodifiedFiles: FileInsightFile[];
  unreadableEntryCount: number;
  truncated: boolean;
}

export interface DuplicateFileGroup {
  digest: string;
  sizeBytes: number;
  reclaimableBytes: number;
  files: FileInsightFile[];
}

export interface FileInsightFile {
  name: string;
  path: string;
  sizeBytes: number;
  logicalSizeBytes: number;
  allocatedSizeBytes: number;
  modifiedAtMs: number | null;
}

export interface GpuEnergySnapshot {
  sampledAtMs: number;
  gpuAvailable: boolean;
  processEnergyAvailable: boolean;
  adapters: GpuAdapterSnapshot[];
  processEnergy: ProcessEnergySample[];
}

export interface GpuAdapterSnapshot {
  name: string;
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  coreCount: number | null;
}

export interface ProcessEnergySample {
  pid: number;
  impact: number;
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

export interface ApplicationIcon {
  mimeType: string;
  bytes: number[];
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

export type SystemSettingsDestination = "login_items" | "battery" | "network";

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
