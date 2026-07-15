use serde::{Deserialize, Serialize};

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 6;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub schema_version: u16,
    pub sequence: u64,
    pub sampled_at_ms: u64,
    pub sample_interval_ms: u64,
    pub warming_up: bool,
    pub host: HostSnapshot,
    pub cpu: CpuSnapshot,
    pub memory: MemorySnapshot,
    pub disk: DiskSnapshot,
    pub network: NetworkSnapshot,
    pub sensors: SensorsSnapshot,
    pub processes: Vec<ProcessRow>,
    pub capabilities: Capabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSummary {
    pub sampled_at_ms: u64,
    pub cpu: CpuSnapshot,
    pub memory: MemorySnapshot,
    pub volumes: Vec<VolumeSnapshot>,
    pub sensors: SensorsSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorsSnapshot {
    pub sampled_at_ms: u64,
    pub temperature: TemperatureSnapshot,
    pub battery: BatterySnapshot,
    pub sleep: SleepSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperatureSnapshot {
    pub celsius: Option<f32>,
    pub component_label: Option<String>,
    pub critical_celsius: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatterySnapshot {
    pub present: bool,
    pub charge_percent: Option<f32>,
    pub state: BatteryState,
    pub time_remaining_minutes: Option<u64>,
    pub power_source: PowerSource,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepSnapshot {
    pub sampled_at_ms: u64,
    pub available: bool,
    pub blockers: Vec<SleepBlocker>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepBlocker {
    pub pid: Option<u32>,
    pub process_name: String,
    pub reason: Option<String>,
    pub kind: SleepBlockerKind,
    pub duration_seconds: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Hash)]
#[allow(dead_code)] // Sleep blocker kinds are currently populated by the macOS sampler only.
pub enum SleepBlockerKind {
    #[serde(rename = "system_sleep")]
    System,
    #[serde(rename = "idle_sleep")]
    Idle,
    #[serde(rename = "display_sleep")]
    Display,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItemsSnapshot {
    pub sampled_at_ms: u64,
    pub items: Vec<StartupItem>,
    pub unreadable_location_count: usize,
    pub management_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub command: Option<String>,
    pub path: String,
    pub source: StartupItemSource,
    pub scope: StartupItemScope,
    pub enabled: bool,
    pub system: bool,
    pub launch_kind: StartupLaunchKind,
    pub management_status: StartupManagementStatus,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Protected startup items are currently identified by the macOS backend only.
pub enum StartupManagementStatus {
    Available,
    System,
    Protected,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupManagementAction {
    Disable,
    Enable,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupManagementLeaseRequest {
    pub item_id: String,
    pub action: StartupManagementAction,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupManagementLease {
    pub id: String,
    pub item_id: String,
    pub item_name: String,
    pub action: StartupManagementAction,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupManagementExecutionRequest {
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupManagementLeaseReleaseRequest {
    pub lease_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupManagementResult {
    pub item_id: String,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum StartupItemSource {
    LaunchAgent,
    LaunchDaemon,
    DesktopEntry,
    RegistryRun,
    StartupFolder,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupItemScope {
    User,
    System,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Conditional launch semantics are currently reported by the macOS backend only.
pub enum StartupLaunchKind {
    Login,
    Conditional,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BatteryState {
    Charging,
    Discharging,
    Full,
    NotCharging,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PowerSource {
    Ac,
    Battery,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub kernel_version: String,
    pub architecture: String,
    pub cpu_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuSnapshot {
    pub usage_percent: Option<f32>,
    pub per_core_percent: Vec<f32>,
    pub logical_core_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSnapshot {
    pub read_bytes_per_second: Option<u64>,
    pub write_bytes_per_second: Option<u64>,
    pub volumes: Vec<VolumeSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSnapshot {
    pub name: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSnapshot {
    pub received_bytes_per_second: Option<u64>,
    pub transmitted_bytes_per_second: Option<u64>,
    pub received_bytes_since_launch: u64,
    pub transmitted_bytes_since_launch: u64,
    pub interface_count: usize,
    pub interfaces: Vec<NetworkInterfaceSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceSnapshot {
    pub name: String,
    pub received_bytes_per_second: Option<u64>,
    pub transmitted_bytes_per_second: Option<u64>,
    pub received_bytes_since_launch: u64,
    pub transmitted_bytes_since_launch: u64,
    pub packets_received_since_launch: u64,
    pub packets_transmitted_since_launch: u64,
    pub receive_errors_since_launch: u64,
    pub transmit_errors_since_launch: u64,
    pub mtu: u64,
    pub mac_address: Option<String>,
    pub ip_networks: Vec<String>,
    pub operational_state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScan {
    pub sampled_at_ms: u64,
    pub duration_ms: u64,
    /// The real directory hierarchy rooted at the system disk.
    /// Category summaries are kept separately in `locations` and must not be
    /// used to fabricate the filesystem tree shown by the path map.
    pub root: CleanupNode,
    pub locations: Vec<CleanupLocation>,
    pub largest_files: Vec<CleanupFile>,
    pub installed_applications: Vec<CleanupApplication>,
    pub application_inventory_available: bool,
    pub scanned_entry_count: usize,
    pub unreadable_entry_count: usize,
    pub unreadable_paths: Vec<String>,
    pub deletion_available: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupApplication {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub last_used_at_ms: Option<u64>,
    pub modified_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupLocation {
    pub kind: CleanupLocationKind,
    pub paths: Vec<String>,
    pub size_bytes: u64,
    pub item_count: usize,
    pub safety: CleanupSafety,
    pub available: bool,
    pub nodes: Vec<CleanupNode>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupNodeKind {
    Folder,
    File,
    Aggregate,
    Restricted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupNode {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    /// Kept as the primary display size for existing consumers. It matches
    /// `allocated_size_bytes`, which is the space that can actually be reclaimed.
    pub size_bytes: u64,
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: u64,
    pub item_count: usize,
    pub safety: CleanupSafety,
    pub kind: CleanupNodeKind,
    /// Whether the directory contains entries beyond the currently materialized
    /// visualization tree. The frontend can request a fresh bounded subtree on
    /// demand without forcing the initial scan to return every file node.
    pub has_children: bool,
    pub children: Vec<CleanupNode>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSubtreeRequest {
    pub request_id: String,
    pub path: String,
    pub safety: CleanupSafety,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScanProgress {
    pub scanned_entry_count: usize,
    pub discovered_bytes: u64,
    pub current_path: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Platform-specific variants are serialized by different desktop targets.
pub enum CleanupFullDiskAccessStatus {
    Granted,
    NotGranted,
    NotRequired,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScanAccess {
    pub full_disk_access: CleanupFullDiskAccessStatus,
    pub full_disk_access_recommended: bool,
    pub application_bundle_available: bool,
    pub application_bundle_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPathState {
    pub path: String,
    pub exists: bool,
    pub modified_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteLeaseRequest {
    pub paths: Vec<String>,
    pub scan_sampled_at_ms: u64,
    pub expected_targets: Vec<CleanupDeleteTargetEvidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteTargetEvidence {
    pub path: String,
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: u64,
    pub item_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteLease {
    pub id: String,
    pub paths: Vec<String>,
    pub changed_paths: Vec<String>,
    pub refreshed_targets: Vec<CleanupDeleteTargetEvidence>,
    pub executable: bool,
    pub refreshed_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteExecutionRequest {
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteLeaseReleaseRequest {
    pub lease_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteResult {
    pub deleted: Vec<CleanupDeleteSuccess>,
    pub deleted_bytes: u64,
    pub failed: Vec<CleanupDeleteFailure>,
    pub cancelled: bool,
    pub interrupted_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupDeleteProgressPhase {
    Deleting,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteProgress {
    pub phase: CleanupDeleteProgressPhase,
    pub processed_entry_count: usize,
    pub total_entry_count: usize,
    pub completed_target_count: usize,
    pub total_target_count: usize,
    pub current_path: String,
    pub deleted_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteSuccess {
    pub path: String,
    pub deleted_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteFailure {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupLocationKind {
    Downloads,
    Trash,
    AppCache,
    DeveloperCache,
    HiddenData,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupSafety {
    Reclaimable,
    Review,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConnectionsSnapshot {
    pub sampled_at_ms: u64,
    pub summary: NetworkConnectionSummary,
    pub connections: Vec<NetworkConnection>,
    pub process_attribution: NetworkProcessAttribution,
    pub truncated: bool,
    pub skipped_entry_count: usize,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConnectionSummary {
    pub total_count: usize,
    pub tcp_count: usize,
    pub udp_count: usize,
    pub established_count: usize,
    pub listening_count: usize,
    pub attributed_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConnection {
    pub protocol: NetworkTransportProtocol,
    pub address_family: NetworkAddressFamily,
    pub local_endpoint: NetworkEndpoint,
    pub remote_endpoint: Option<NetworkEndpoint>,
    pub state: NetworkConnectionState,
    pub associated_pids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Availability differs by target OS and is serialized for the frontend.
pub enum NetworkProcessAttribution {
    Available,
    Partial,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEndpoint {
    pub address: String,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkTransportProtocol {
    Tcp,
    Udp,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkAddressFamily {
    Ipv4,
    Ipv6,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkConnectionState {
    Closed,
    Listen,
    SynSent,
    SynReceived,
    Established,
    FinWait1,
    FinWait2,
    CloseWait,
    Closing,
    LastAck,
    TimeWait,
    DeleteTcb,
    Unconnected,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u32,
    pub birth_token: Option<String>,
    pub parent_pid: Option<u32>,
    pub start_time: u64,
    pub run_time_seconds: u64,
    pub name: String,
    pub user: Option<String>,
    pub status: String,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: u64,
    pub disk_read_bytes_per_second: Option<u64>,
    pub disk_write_bytes_per_second: Option<u64>,
    pub protected: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub process_control: ProcessControlCapabilities,
    pub requires_confirmation: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Some variants are constructed only by other target-specific backends.
pub enum ProcessControlTargeting {
    StableHandle,
    BestEffortPid,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)] // Windows-only semantics are intentionally absent on Unix builds.
pub enum ProcessActionSemantic {
    Sigterm,
    Sigkill,
    TerminateProcess,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActionCapability {
    pub enabled: bool,
    pub semantic: Option<ProcessActionSemantic>,
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessControlCapabilities {
    pub targeting: ProcessControlTargeting,
    pub request_close: ProcessActionCapability,
    pub force_kill: ProcessActionCapability,
    pub lease_ttl_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKey {
    pub pid: u32,
    pub birth_token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetailRequest {
    pub pid: u32,
    pub snapshot_start_time: u64,
    pub snapshot_birth_token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetail {
    pub key: Option<ProcessKey>,
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub start_time: u64,
    pub run_time_seconds: u64,
    pub name: String,
    pub user: Option<String>,
    pub status: String,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: u64,
    pub virtual_memory_bytes: u64,
    pub executable: Option<String>,
    pub command_line: Option<String>,
    pub can_terminate: bool,
    pub protected_reason: Option<String>,
    pub identity_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIcon {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessAction {
    RequestClose,
    ForceKill,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessControlLeaseRequest {
    pub key: ProcessKey,
    pub action: ProcessAction,
    pub acknowledge_best_effort: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessControlLease {
    pub id: String,
    pub key: ProcessKey,
    pub action: ProcessAction,
    pub targeting: ProcessControlTargeting,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessControlLeaseReleaseRequest {
    pub lease_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActionRequest {
    pub lease_id: String,
    pub key: ProcessKey,
    pub action: ProcessAction,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessActionOutcome {
    Exited,
    StillRunning,
    AlreadyExited,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActionResult {
    pub signal_sent: bool,
    pub outcome: ProcessActionOutcome,
    pub message: String,
}
