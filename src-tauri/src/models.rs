use serde::{Deserialize, Serialize};

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 7;

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
    pub sequence: u64,
    pub sampled_at_ms: u64,
    pub sample_interval_ms: u64,
    pub cpu: CpuSnapshot,
    pub memory: MemorySnapshot,
    pub disk: DiskSnapshot,
    pub network: NetworkSnapshot,
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
    pub health_percent: Option<f32>,
    pub cycle_count: Option<u64>,
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
    pub scan_warnings: Vec<StartupScanWarning>,
    pub management_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupScanWarning {
    pub source: StartupItemSource,
    pub issue: StartupScanIssue,
    pub count: usize,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupScanIssue {
    UnreadableLocation,
    InvalidEntry,
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    SourceUnavailable,
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
    pub bundle_id: Option<String>,
    pub team_id: Option<String>,
    pub signature_status: Option<String>,
    pub executable_path: Option<String>,
    pub responsible_application: Option<String>,
    pub last_run_status: Option<String>,
    pub orphaned: bool,
    pub modern_background_item: bool,
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
    BackgroundTask,
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
    #[serde(default)]
    pub scan_id: String,
    #[serde(default)]
    pub profile: CleanupScanProfile,
    #[serde(default)]
    pub scope_paths: Vec<String>,
    #[serde(default)]
    pub indexed: bool,
    #[serde(default)]
    pub index_byte_size: u64,
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
    #[serde(default)]
    pub target_kind: CleanupScanTargetKind,
    #[serde(default)]
    pub target_path: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupScanTargetKind {
    #[default]
    SystemDisk,
    Volume,
    Folder,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupScanProfile {
    CommonLocations,
    #[default]
    Complete,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScanRequest {
    #[serde(default)]
    pub profile: CleanupScanProfile,
    pub target_kind: CleanupScanTargetKind,
    pub target_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupScanJobPhase {
    Preparing,
    Scanning,
    Paused,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
    Stalled,
}

impl CleanupScanJobPhase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Cancelled | Self::Completed | Self::Failed)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScanJobStatus {
    pub job_id: String,
    pub generation: u64,
    pub phase: CleanupScanJobPhase,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_heartbeat_at_ms: Option<u64>,
    pub last_progress_at_ms: Option<u64>,
    pub progress: CleanupScanProgress,
    pub target: CleanupScanRequest,
    pub result_available: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
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
pub struct InstalledApplication {
    pub name: String,
    pub path: String,
    pub bundle_id: Option<String>,
    pub size_bytes: u64,
    pub last_used_at_ms: Option<u64>,
    pub modified_at_ms: Option<u64>,
    pub uninstallable: bool,
    pub unavailable_reason: Option<String>,
    #[serde(default)]
    pub installation_source: ApplicationInstallationSource,
    #[serde(default)]
    pub native_uninstall_identifier: Option<String>,
    #[serde(default)]
    pub native_uninstall_requires_elevation: bool,
    #[serde(default)]
    pub icon_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationInstallationSource {
    MacosBundle,
    WindowsMsi,
    WindowsMsix,
    WindowsUninstaller,
    LinuxFlatpak,
    LinuxDeb,
    LinuxRpm,
    LinuxSnap,
    Portable,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInventorySnapshot {
    pub sampled_at_ms: u64,
    pub platform_supported: bool,
    pub cached: bool,
    pub refresh_recommended: bool,
    pub applications: Vec<InstalledApplication>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedApplication {
    pub name: String,
    pub path: String,
    pub bundle_id: Option<String>,
    pub modified_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "snake_case")]
pub enum ApplicationArtifactKind {
    Application,
    ApplicationSupport,
    Cache,
    Preferences,
    SavedState,
    Container,
    WebData,
    HttpStorage,
    Cookies,
    Logs,
    LaunchAgent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallArtifact {
    pub kind: ApplicationArtifactKind,
    pub path: String,
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: u64,
    pub item_count: usize,
    pub required: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallPlan {
    pub sampled_at_ms: u64,
    pub application: InstalledApplication,
    pub artifacts: Vec<ApplicationUninstallArtifact>,
    pub skipped_paths: Vec<String>,
    pub native_uninstall: Option<NativeApplicationUninstallPlan>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeApplicationUninstallPlan {
    pub id: String,
    pub source: ApplicationInstallationSource,
    pub identifier: String,
    pub method: String,
    pub requires_elevation: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeApplicationUninstallExecutionRequest {
    pub plan_id: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeApplicationUninstallOutcome {
    Succeeded,
    Cancelled,
    Failed,
    RestartRequired,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeApplicationUninstallResult {
    pub outcome: NativeApplicationUninstallOutcome,
    pub exit_code: Option<i32>,
    pub message: String,
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupProtectionReason {
    SystemLocation,
    HomeRoot,
    TrashRoot,
    SensitiveUserData,
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
    /// Defense-in-depth marker for locations that the cleanup workflow must
    /// never enqueue or delete. The delete lease validates the path again and
    /// does not trust this UI-facing flag.
    #[serde(default)]
    pub deletion_protected: bool,
    #[serde(default)]
    pub protection_reason: Option<CleanupProtectionReason>,
    /// Whether the directory contains indexed entries beyond the currently
    /// materialized visualization tree.
    pub has_children: bool,
    pub children: Vec<CleanupNode>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIndexedDirectoryRequest {
    pub scan_id: String,
    pub directory_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIndexedChildrenRequest {
    pub scan_id: String,
    pub directory_id: String,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
    pub query: Option<String>,
    pub sort_by: Option<CleanupIndexedSort>,
    pub descending: Option<bool>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupIndexedSort {
    #[default]
    Size,
    Name,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIndexedChildrenPage {
    pub items: Vec<CleanupNode>,
    pub next_cursor: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDirectoryRefreshRequest {
    pub scan_id: String,
    pub directory_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIndexDeletionRequest {
    pub scan_id: String,
    pub node_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScanIndexSummary {
    pub available: bool,
    pub byte_size: u64,
    pub scan_count: usize,
    pub updated_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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
    #[serde(default)]
    pub scan_id: Option<String>,
    #[serde(default)]
    pub directory_ids: Vec<String>,
    pub paths: Vec<String>,
    pub scan_sampled_at_ms: u64,
    #[serde(default)]
    pub scan_root: Option<String>,
    #[serde(default)]
    pub scan_target_kind: CleanupScanTargetKind,
    pub expected_targets: Vec<CleanupDeleteTargetEvidence>,
    pub mode: CleanupDeleteMode,
    #[serde(default)]
    pub application_uninstall: Option<ApplicationUninstallScope>,
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUninstallScope {
    pub application_path: String,
    pub bundle_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupDeleteMode {
    Trash,
    Permanent,
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
    pub mode: CleanupDeleteMode,
    pub paths: Vec<String>,
    pub missing_paths: Vec<String>,
    pub unavailable_paths: Vec<String>,
    pub changed_paths: Vec<String>,
    pub refreshed_targets: Vec<CleanupDeleteTargetEvidence>,
    pub executable: bool,
    pub refreshed_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteLeaseModeRequest {
    pub lease_id: String,
    pub mode: CleanupDeleteMode,
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
    pub selected_logical_bytes: u64,
    pub selected_allocated_bytes: u64,
    pub deleted_bytes: u64,
    pub available_bytes_before: Option<u64>,
    pub available_bytes_after: Option<u64>,
    pub failed: Vec<CleanupDeleteFailure>,
    pub cancelled: bool,
    pub interrupted_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CleanupDeleteProgressPhase {
    MovingToTrash,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum QuickCleanCategory {
    UserCache,
    Logs,
    TempFiles,
    Trash,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCleanCategorySummary {
    pub category: QuickCleanCategory,
    pub byte_size: u64,
    pub item_count: u64,
    pub skipped_count: u64,
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCleanRequest {
    pub categories: Vec<QuickCleanCategory>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCleanProgress {
    pub category: QuickCleanCategory,
    pub processed_item_count: usize,
    pub total_item_count: usize,
    pub freed_bytes: u64,
    pub freed_items: u64,
    pub skipped_items: u64,
    pub current_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCleanCategoryResult {
    pub category: QuickCleanCategory,
    pub freed_bytes: u64,
    pub freed_items: u64,
    pub skipped_items: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCleanResult {
    pub freed_bytes: u64,
    pub freed_items: u64,
    pub skipped_items: u64,
    pub results: Vec<QuickCleanCategoryResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDeleteFailure {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
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

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkQualityStatus {
    Online,
    Limited,
    Offline,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkQualityDiagnosticKind {
    LocalLink,
    Dns,
    Ipv4,
    Ipv6,
    Internet,
    IndependentService,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkQualityDiagnosticStatus {
    Passed,
    Degraded,
    Failed,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkQualityDiagnostic {
    pub kind: NetworkQualityDiagnosticKind,
    pub status: NetworkQualityDiagnosticStatus,
    pub latency_ms: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkQualityResult {
    pub sampled_at_ms: u64,
    /// A one-way fingerprint of the operating system's selected default route.
    /// Raw interface, gateway, and address values never leave the backend.
    pub route_signature: Option<String>,
    pub target_host: String,
    pub target_port: u16,
    pub target_count: usize,
    pub successful_target_count: usize,
    pub status: NetworkQualityStatus,
    pub dns_available: bool,
    pub dns_lookup_ms: Option<u64>,
    pub resolved_address_count: usize,
    pub probe_count: usize,
    pub successful_probe_count: usize,
    pub average_latency_ms: Option<f64>,
    pub minimum_latency_ms: Option<f64>,
    pub maximum_latency_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub tcp_probe_failure_percent: f64,
    pub diagnostics: Vec<NetworkQualityDiagnostic>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkHostLookupRequest {
    pub addresses: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkHostLookup {
    pub address: String,
    pub hostname: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupContext {
    pub background_launch: bool,
    pub launched_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInsightsProgress {
    pub phase: FileInsightsPhase,
    pub scanned_entry_count: usize,
    pub candidate_file_count: usize,
    pub hashed_file_count: usize,
    pub current_path: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileInsightsPhase {
    Discovering,
    Hashing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInsightsScan {
    pub sampled_at_ms: u64,
    pub duration_ms: u64,
    pub scanned_entry_count: usize,
    pub candidate_file_count: usize,
    pub hashed_file_count: usize,
    pub duplicate_groups: Vec<DuplicateFileGroup>,
    pub long_unmodified_files: Vec<FileInsightFile>,
    pub unreadable_entry_count: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFileGroup {
    pub digest: String,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
    pub files: Vec<FileInsightFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInsightFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: u64,
    pub modified_at_ms: Option<u64>,
    #[serde(default)]
    pub modified_at_us: Option<u64>,
    #[serde(default)]
    pub device_id: Option<u64>,
    #[serde(default)]
    pub inode: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuEnergySnapshot {
    pub sampled_at_ms: u64,
    pub gpu_available: bool,
    pub process_energy_available: bool,
    pub adapters: Vec<GpuAdapterSnapshot>,
    pub process_energy: Vec<ProcessEnergySample>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapterSnapshot {
    pub name: String,
    pub utilization_percent: Option<f32>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub core_count: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEnergySample {
    pub pid: u32,
    /// Platform-provided relative activity score. This is not electrical power.
    pub impact: f32,
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
    pub application_id: Option<String>,
    pub user: Option<String>,
    pub status: String,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: u64,
    pub disk_read_bytes_per_second: Option<u64>,
    pub disk_write_bytes_per_second: Option<u64>,
    pub protected: bool,
    pub orphaned: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrphanReason {
    ParentExited,
    ParentMissing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanProcess {
    pub pid: u32,
    pub start_time: u64,
    pub name: String,
    pub command_line: String,
    pub parent_pid: Option<u32>,
    pub parent_name: Option<String>,
    pub user: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub status: String,
    pub orphan_reason: OrphanReason,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanKillTarget {
    pub pid: u32,
    pub expected_start_time: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanKillRequest {
    pub targets: Vec<OrphanKillTarget>,
    pub force: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrphanKillStatus {
    Killed,
    ForceKilled,
    Survived,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanKillOutcome {
    pub pid: u32,
    pub name: String,
    pub status: OrphanKillStatus,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanKillReport {
    pub outcomes: Vec<OrphanKillOutcome>,
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
    WmClose,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIconRequest {
    pub process: Option<ProcessDetailRequest>,
    pub application_path: Option<String>,
    pub executable_path: Option<String>,
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
