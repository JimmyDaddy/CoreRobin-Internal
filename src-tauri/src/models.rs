use serde::{Deserialize, Serialize};

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 2;

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
    pub processes: Vec<ProcessRow>,
    pub capabilities: Capabilities,
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
    pub interface_count: usize,
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
    pub request_close: bool,
    pub force_kill: bool,
    pub requires_confirmation: bool,
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessAction {
    RequestClose,
    ForceKill,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActionRequest {
    pub key: ProcessKey,
    pub action: ProcessAction,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessActionResult {
    pub signal_sent: bool,
    pub outcome: String,
    pub message: String,
}
