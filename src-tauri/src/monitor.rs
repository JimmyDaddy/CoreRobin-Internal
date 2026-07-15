use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{
    CpuRefreshKind, DiskRefreshKind, Disks, MINIMUM_CPU_UPDATE_INTERVAL, Networks,
    ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind, Users,
};

use crate::error::CommandError;
use crate::identity::{BirthTokenCache, ensure_birth_token};
use crate::models::{
    Capabilities, CpuSnapshot, DiskSnapshot, HostSnapshot, MemorySnapshot,
    NetworkInterfaceSnapshot, NetworkSnapshot, ProcessControlCapabilities, ProcessDetail,
    ProcessDetailRequest, ProcessKey, ProcessRow, SNAPSHOT_SCHEMA_VERSION, SystemSnapshot,
    SystemSummary, VolumeSnapshot,
};
use crate::sensors::SensorSampler;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct NetworkSessionCounters {
    received_bytes: u64,
    transmitted_bytes: u64,
    packets_received: u64,
    packets_transmitted: u64,
    receive_errors: u64,
    transmit_errors: u64,
}

impl NetworkSessionCounters {
    fn record(
        &mut self,
        received_bytes: u64,
        transmitted_bytes: u64,
        packets_received: u64,
        packets_transmitted: u64,
        receive_errors: u64,
        transmit_errors: u64,
    ) {
        self.received_bytes = self.received_bytes.saturating_add(received_bytes);
        self.transmitted_bytes = self.transmitted_bytes.saturating_add(transmitted_bytes);
        self.packets_received = self.packets_received.saturating_add(packets_received);
        self.packets_transmitted = self.packets_transmitted.saturating_add(packets_transmitted);
        self.receive_errors = self.receive_errors.saturating_add(receive_errors);
        self.transmit_errors = self.transmit_errors.saturating_add(transmit_errors);
    }
}

pub struct SystemMonitor {
    system: System,
    networks: Networks,
    disks: Disks,
    users: Users,
    host: HostSnapshot,
    sequence: u64,
    last_sample: Instant,
    network_sessions: HashMap<String, NetworkSessionCounters>,
    own_pid: u32,
    process_control_capabilities: ProcessControlCapabilities,
    sensors: SensorSampler,
    birth_tokens: BirthTokenCache,
    last_summary_sample: Instant,
}

impl SystemMonitor {
    pub fn new(process_control_capabilities: ProcessControlCapabilities) -> Self {
        let mut system = System::new();
        system.refresh_cpu_list(CpuRefreshKind::everything());
        system.refresh_cpu_usage();
        system.refresh_memory();
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());

        let host = HostSnapshot {
            hostname: System::host_name().unwrap_or_else(|| "Local computer".to_owned()),
            os_name: System::name().unwrap_or_else(|| std::env::consts::OS.to_owned()),
            os_version: System::os_version().unwrap_or_default(),
            kernel_version: System::kernel_version().unwrap_or_default(),
            architecture: System::cpu_arch(),
            cpu_name: system
                .cpus()
                .first()
                .map(|cpu| cpu.brand().to_owned())
                .unwrap_or_default(),
        };

        Self {
            system,
            networks: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
            users: Users::new_with_refreshed_list(),
            host,
            sequence: 0,
            last_sample: Instant::now(),
            network_sessions: HashMap::new(),
            own_pid: std::process::id(),
            process_control_capabilities,
            sensors: SensorSampler::new(),
            birth_tokens: BirthTokenCache::default(),
            last_summary_sample: Instant::now(),
        }
    }

    pub fn sample(&mut self) -> SystemSnapshot {
        let elapsed = self.last_sample.elapsed();
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            process_refresh_kind(),
        );
        self.networks.refresh(true);
        // Refreshing the full disk list on macOS asks CoreFoundation for every
        // mounted volume's properties. A stale or busy APFS/network mount can
        // block that call indefinitely and prevent the first snapshot from
        // reaching the UI. The list and capacity metadata are established when
        // the monitor is created; high-frequency samples only need fresh I/O
        // counters.
        for disk in self.disks.list_mut() {
            disk.refresh_specifics(DiskRefreshKind::nothing().with_io_usage());
        }

        self.sequence = self.sequence.saturating_add(1);
        self.last_sample = Instant::now();

        let elapsed_ms = elapsed.as_millis().max(1) as u64;
        let warming_up = self.sequence == 1 || elapsed < MINIMUM_CPU_UPDATE_INTERVAL;
        let cpu_usage = (!warming_up).then(|| self.system.global_cpu_usage().clamp(0.0, 100.0));
        let per_core_percent = self
            .system
            .cpus()
            .iter()
            .map(|cpu| cpu.cpu_usage().clamp(0.0, 100.0))
            .collect::<Vec<_>>();

        let disk_read_delta = self.disks.list().iter().fold(0_u64, |total, disk| {
            total.saturating_add(disk.usage().read_bytes)
        });
        let disk_write_delta = self.disks.list().iter().fold(0_u64, |total, disk| {
            total.saturating_add(disk.usage().written_bytes)
        });
        let mut network_received_delta = 0_u64;
        let mut network_transmitted_delta = 0_u64;
        let mut network_interfaces = Vec::with_capacity(self.networks.list().len());
        for (name, network) in self.networks.list() {
            let received_delta = network.received();
            let transmitted_delta = network.transmitted();
            network_received_delta = network_received_delta.saturating_add(received_delta);
            network_transmitted_delta = network_transmitted_delta.saturating_add(transmitted_delta);

            let counters = self.network_sessions.entry(name.clone()).or_default();
            counters.record(
                received_delta,
                transmitted_delta,
                network.packets_received(),
                network.packets_transmitted(),
                network.errors_on_received(),
                network.errors_on_transmitted(),
            );

            let mac_address = network.mac_address();
            network_interfaces.push(NetworkInterfaceSnapshot {
                name: name.clone(),
                received_bytes_per_second: (!warming_up)
                    .then(|| bytes_per_second(received_delta, elapsed_ms)),
                transmitted_bytes_per_second: (!warming_up)
                    .then(|| bytes_per_second(transmitted_delta, elapsed_ms)),
                received_bytes_since_launch: counters.received_bytes,
                transmitted_bytes_since_launch: counters.transmitted_bytes,
                packets_received_since_launch: counters.packets_received,
                packets_transmitted_since_launch: counters.packets_transmitted,
                receive_errors_since_launch: counters.receive_errors,
                transmit_errors_since_launch: counters.transmit_errors,
                mtu: network.mtu(),
                mac_address: (!mac_address.is_unspecified()).then(|| mac_address.to_string()),
                ip_networks: network
                    .ip_networks()
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                operational_state: network.operational_state().to_string(),
            });
        }
        network_interfaces.sort_by(|left, right| left.name.cmp(&right.name));
        let (network_received_since_launch, network_transmitted_since_launch) = self
            .network_sessions
            .values()
            .fold((0_u64, 0_u64), |(received, transmitted), counters| {
                (
                    received.saturating_add(counters.received_bytes),
                    transmitted.saturating_add(counters.transmitted_bytes),
                )
            });

        let live_identities = self
            .system
            .processes()
            .values()
            .map(|process| (process.pid().as_u32(), process.start_time()))
            .collect::<HashMap<_, _>>();
        self.birth_tokens.retain_live(&live_identities);
        let process_birth_tokens = live_identities
            .iter()
            .map(|(&pid, &start_time)| (pid, self.birth_tokens.resolve(pid, start_time)))
            .collect::<HashMap<_, _>>();

        let mut processes = self
            .system
            .processes()
            .values()
            .map(|process| {
                let pid = process.pid().as_u32();
                let disk_usage = process.disk_usage();
                ProcessRow {
                    pid,
                    birth_token: process_birth_tokens.get(&pid).cloned().flatten(),
                    parent_pid: process.parent().map(|parent| parent.as_u32()),
                    start_time: process.start_time(),
                    run_time_seconds: process.run_time(),
                    name: process.name().to_string_lossy().into_owned(),
                    user: process
                        .user_id()
                        .and_then(|user_id| self.users.get_user_by_id(user_id))
                        .map(|user| user.name().to_owned()),
                    status: format!("{:?}", process.status()),
                    cpu_percent: (!warming_up).then(|| process.cpu_usage().max(0.0)),
                    memory_bytes: process.memory(),
                    disk_read_bytes_per_second: (!warming_up)
                        .then(|| bytes_per_second(disk_usage.read_bytes, elapsed_ms)),
                    disk_write_bytes_per_second: (!warming_up)
                        .then(|| bytes_per_second(disk_usage.written_bytes, elapsed_ms)),
                    protected: protected_reason(pid, self.own_pid).is_some(),
                }
            })
            .collect::<Vec<_>>();

        processes.sort_by(|left, right| {
            right
                .cpu_percent
                .unwrap_or_default()
                .total_cmp(&left.cpu_percent.unwrap_or_default())
                .then_with(|| right.memory_bytes.cmp(&left.memory_bytes))
        });

        let volumes = collapse_macos_system_volume_group(
            self.disks
                .list()
                .iter()
                .filter(|disk| disk.total_space() > 0)
                .map(|disk| VolumeSnapshot {
                    name: disk.name().to_string_lossy().into_owned(),
                    mount_point: disk.mount_point().to_string_lossy().into_owned(),
                    total_bytes: disk.total_space(),
                    available_bytes: disk.available_space(),
                    removable: disk.is_removable(),
                })
                .collect(),
        );

        SystemSnapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            sequence: self.sequence,
            sampled_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_millis() as u64,
            sample_interval_ms: elapsed_ms,
            warming_up,
            host: self.host.clone(),
            cpu: CpuSnapshot {
                usage_percent: cpu_usage,
                per_core_percent,
                logical_core_count: self.system.cpus().len(),
            },
            memory: MemorySnapshot {
                total_bytes: self.system.total_memory(),
                used_bytes: self.system.used_memory(),
                available_bytes: self.system.available_memory(),
                swap_total_bytes: self.system.total_swap(),
                swap_used_bytes: self.system.used_swap(),
            },
            disk: DiskSnapshot {
                read_bytes_per_second: (!warming_up)
                    .then(|| bytes_per_second(disk_read_delta, elapsed_ms)),
                write_bytes_per_second: (!warming_up)
                    .then(|| bytes_per_second(disk_write_delta, elapsed_ms)),
                volumes,
            },
            network: NetworkSnapshot {
                received_bytes_per_second: (!warming_up)
                    .then(|| bytes_per_second(network_received_delta, elapsed_ms)),
                transmitted_bytes_per_second: (!warming_up)
                    .then(|| bytes_per_second(network_transmitted_delta, elapsed_ms)),
                received_bytes_since_launch: network_received_since_launch,
                transmitted_bytes_since_launch: network_transmitted_since_launch,
                interface_count: network_interfaces.len(),
                interfaces: network_interfaces,
            },
            sensors: self.sensors.sample(),
            processes,
            capabilities: Capabilities {
                platform: std::env::consts::OS.to_owned(),
                process_control: self.process_control_capabilities.clone(),
                requires_confirmation: true,
            },
        }
    }

    pub fn sample_summary(&mut self) -> SystemSummary {
        let elapsed = self.last_summary_sample.elapsed();
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.last_summary_sample = Instant::now();

        let cpu_usage = (elapsed >= MINIMUM_CPU_UPDATE_INTERVAL)
            .then(|| self.system.global_cpu_usage().clamp(0.0, 100.0));
        let volumes = collapse_macos_system_volume_group(
            self.disks
                .list()
                .iter()
                .filter(|disk| disk.total_space() > 0)
                .map(|disk| VolumeSnapshot {
                    name: disk.name().to_string_lossy().into_owned(),
                    mount_point: disk.mount_point().to_string_lossy().into_owned(),
                    total_bytes: disk.total_space(),
                    available_bytes: disk.available_space(),
                    removable: disk.is_removable(),
                })
                .collect(),
        );

        SystemSummary {
            sampled_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_millis() as u64,
            cpu: CpuSnapshot {
                usage_percent: cpu_usage,
                per_core_percent: Vec::new(),
                logical_core_count: self.system.cpus().len(),
            },
            memory: MemorySnapshot {
                total_bytes: self.system.total_memory(),
                used_bytes: self.system.used_memory(),
                available_bytes: self.system.available_memory(),
                swap_total_bytes: self.system.total_swap(),
                swap_used_bytes: self.system.used_swap(),
            },
            volumes,
            sensors: self.sensors.sample(),
        }
    }

    pub fn process_detail(
        &mut self,
        request: ProcessDetailRequest,
    ) -> Result<ProcessDetail, CommandError> {
        if let Some(expected) = request.snapshot_birth_token.as_deref() {
            ensure_birth_token(request.pid, expected)?;
        }

        let pid = sysinfo::Pid::from_u32(request.pid);
        let pids = [pid];
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_user(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .without_tasks(),
        );

        let process = self.system.process(pid).ok_or_else(|| {
            CommandError::new(
                "process_exited",
                "The selected process is no longer running.",
            )
        })?;

        if process.start_time() != request.snapshot_start_time {
            return Err(CommandError::new(
                "stale_process",
                "The PID now belongs to a different process.",
            ));
        }

        let protected_reason = protected_reason(request.pid, self.own_pid);
        let (key, identity_error) = match request.snapshot_birth_token.as_deref() {
            Some(expected) => {
                let birth_token = ensure_birth_token(request.pid, expected)?;
                (
                    Some(ProcessKey {
                        pid: request.pid,
                        birth_token,
                    }),
                    None,
                )
            }
            None => (
                None,
                Some(
                    "The sampled process did not expose a precise identity; process actions are disabled."
                        .to_owned(),
                ),
            ),
        };
        let command_line = (!process.cmd().is_empty()).then(|| {
            process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
        });

        Ok(ProcessDetail {
            key,
            pid: request.pid,
            parent_pid: process.parent().map(|parent| parent.as_u32()),
            start_time: process.start_time(),
            run_time_seconds: process.run_time(),
            name: process.name().to_string_lossy().into_owned(),
            user: process
                .user_id()
                .and_then(|user_id| self.users.get_user_by_id(user_id))
                .map(|user| user.name().to_owned()),
            status: format!("{:?}", process.status()),
            cpu_percent: (self.sequence > 1).then(|| process.cpu_usage().max(0.0)),
            memory_bytes: process.memory(),
            virtual_memory_bytes: process.virtual_memory(),
            executable: process
                .exe()
                .map(|path| path.to_string_lossy().into_owned()),
            command_line,
            can_terminate: protected_reason.is_none()
                && identity_error.is_none()
                && (self.process_control_capabilities.request_close.enabled
                    || self.process_control_capabilities.force_kill.enabled),
            protected_reason: protected_reason.map(str::to_owned),
            identity_error,
        })
    }
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_disk_usage()
        .with_user(UpdateKind::OnlyIfNotSet)
        .without_tasks()
}

fn collapse_macos_system_volume_group(mut volumes: Vec<VolumeSnapshot>) -> Vec<VolumeSnapshot> {
    let has_system_root = volumes.iter().any(|volume| volume.mount_point == "/");
    if has_system_root {
        // Modern macOS exposes the sealed system volume and its writable Data
        // partner as separate mounts even though they share one APFS container.
        volumes.retain(|volume| volume.mount_point != "/System/Volumes/Data");
    }
    volumes
}

pub(crate) fn protected_reason(pid: u32, own_pid: u32) -> Option<&'static str> {
    if pid == own_pid {
        Some("StatusOrbit cannot terminate itself.")
    } else if pid <= 1 {
        Some("This critical system process is protected.")
    } else {
        None
    }
}

fn bytes_per_second(bytes: u64, elapsed_ms: u64) -> u64 {
    if elapsed_ms == 0 {
        return 0;
    }
    ((bytes as u128).saturating_mul(1_000) / elapsed_ms as u128).min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::{
        NetworkSessionCounters, bytes_per_second, collapse_macos_system_volume_group,
        protected_reason,
    };
    use crate::models::VolumeSnapshot;

    fn volume(name: &str, mount_point: &str) -> VolumeSnapshot {
        VolumeSnapshot {
            name: name.to_owned(),
            mount_point: mount_point.to_owned(),
            total_bytes: 1_000,
            available_bytes: 250,
            removable: false,
        }
    }

    #[test]
    fn converts_delta_bytes_using_the_real_interval() {
        assert_eq!(bytes_per_second(1_024, 500), 2_048);
    }

    #[test]
    fn handles_zero_interval_without_dividing_by_zero() {
        assert_eq!(bytes_per_second(u64::MAX, 0), 0);
    }

    #[test]
    fn accumulates_network_counters_for_the_current_status_orbit_session() {
        let mut counters = NetworkSessionCounters::default();
        counters.record(1_024, 512, 10, 5, 1, 0);
        counters.record(2_048, 256, 20, 4, 0, 2);

        assert_eq!(
            counters,
            NetworkSessionCounters {
                received_bytes: 3_072,
                transmitted_bytes: 768,
                packets_received: 30,
                packets_transmitted: 9,
                receive_errors: 1,
                transmit_errors: 2,
            }
        );
    }

    #[test]
    fn protects_self_and_critical_system_pids() {
        assert!(protected_reason(0, 42).is_some());
        assert!(protected_reason(1, 42).is_some());
        assert!(protected_reason(42, 42).is_some());
        assert!(protected_reason(43, 42).is_none());
    }

    #[test]
    fn collapses_the_macos_system_and_data_volume_group() {
        let volumes = collapse_macos_system_volume_group(vec![
            volume("Macintosh HD", "/"),
            volume("Macintosh HD", "/System/Volumes/Data"),
            volume("Backup", "/Volumes/Backup"),
        ]);

        assert_eq!(volumes.len(), 2);
        assert_eq!(volumes[0].mount_point, "/");
        assert_eq!(volumes[1].mount_point, "/Volumes/Backup");
    }

    #[test]
    fn preserves_a_data_mount_when_the_system_root_is_absent() {
        let volumes =
            collapse_macos_system_volume_group(vec![volume("Data", "/System/Volumes/Data")]);

        assert_eq!(volumes.len(), 1);
        assert_eq!(volumes[0].mount_point, "/System/Volumes/Data");
    }
}
