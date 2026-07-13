use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{
    CpuRefreshKind, Disks, MINIMUM_CPU_UPDATE_INTERVAL, Networks, ProcessRefreshKind,
    ProcessesToUpdate, Signal, System, UpdateKind, Users,
};

use crate::error::CommandError;
use crate::identity::{ensure_birth_token, read_birth_token};
use crate::models::{
    Capabilities, CpuSnapshot, DiskSnapshot, HostSnapshot, MemorySnapshot, NetworkSnapshot,
    ProcessAction, ProcessActionRequest, ProcessActionResult, ProcessDetail, ProcessDetailRequest,
    ProcessKey, ProcessRow, SNAPSHOT_SCHEMA_VERSION, SystemSnapshot, VolumeSnapshot,
};

pub struct SystemMonitor {
    system: System,
    networks: Networks,
    disks: Disks,
    users: Users,
    host: HostSnapshot,
    sequence: u64,
    last_sample: Instant,
    own_pid: u32,
}

impl SystemMonitor {
    pub fn new() -> Self {
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
            own_pid: std::process::id(),
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
        self.disks.refresh(true);

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
        let network_received_delta = self.networks.list().values().fold(0_u64, |total, network| {
            total.saturating_add(network.received())
        });
        let network_transmitted_delta =
            self.networks.list().values().fold(0_u64, |total, network| {
                total.saturating_add(network.transmitted())
            });

        let mut processes = self
            .system
            .processes()
            .values()
            .map(|process| {
                let pid = process.pid().as_u32();
                let disk_usage = process.disk_usage();
                ProcessRow {
                    pid,
                    birth_token: read_birth_token(pid).ok(),
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

        let volumes = self
            .disks
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
            .collect();

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
                interface_count: self.networks.list().len(),
            },
            processes,
            capabilities: capabilities(),
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
            can_terminate: protected_reason.is_none() && identity_error.is_none(),
            protected_reason: protected_reason.map(str::to_owned),
            identity_error,
        })
    }

    pub fn execute_action(
        &mut self,
        request: ProcessActionRequest,
    ) -> Result<ProcessActionResult, CommandError> {
        if let Some(reason) = protected_reason(request.key.pid, self.own_pid) {
            return Err(CommandError::new("protected_process", reason));
        }

        ensure_birth_token(request.key.pid, &request.key.birth_token)?;

        let pid = sysinfo::Pid::from_u32(request.key.pid);
        let pids = [pid];
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        let process = self.system.process(pid).ok_or_else(|| {
            CommandError::new("process_exited", "The process has already exited.")
        })?;

        // macOS signals are PID-based. Recheck after refreshing and immediately
        // before sending the signal to minimize the remaining platform race.
        ensure_birth_token(request.key.pid, &request.key.birth_token)?;

        let sent = match request.action {
            ProcessAction::RequestClose => {
                #[cfg(windows)]
                {
                    return Err(CommandError::new(
                        "unsupported_action",
                        "Windows does not provide a universal graceful close operation for arbitrary processes.",
                    ));
                }

                #[cfg(not(windows))]
                {
                    process.kill_with(Signal::Term).ok_or_else(|| {
                        CommandError::new(
                            "unsupported_action",
                            "This platform does not support a TERM request.",
                        )
                    })?
                }
            }
            ProcessAction::ForceKill => process.kill(),
        };

        if !sent {
            return Err(CommandError::new(
                "permission_denied",
                "The operating system rejected the process action.",
            ));
        }

        Ok(ProcessActionResult {
            signal_sent: true,
            outcome: "signal_sent".to_owned(),
            message: match request.action {
                ProcessAction::RequestClose => {
                    "Close request sent. Pulse will keep watching for the process to exit."
                        .to_owned()
                }
                ProcessAction::ForceKill => {
                    "Force-kill request sent. Pulse will keep watching for the process to exit."
                        .to_owned()
                }
            },
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

fn capabilities() -> Capabilities {
    Capabilities {
        platform: std::env::consts::OS.to_owned(),
        request_close: !cfg!(windows),
        force_kill: true,
        requires_confirmation: true,
    }
}

fn protected_reason(pid: u32, own_pid: u32) -> Option<&'static str> {
    if pid == own_pid {
        Some("Pulse cannot terminate itself.")
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
    use super::{bytes_per_second, protected_reason};

    #[test]
    fn converts_delta_bytes_using_the_real_interval() {
        assert_eq!(bytes_per_second(1_024, 500), 2_048);
    }

    #[test]
    fn handles_zero_interval_without_dividing_by_zero() {
        assert_eq!(bytes_per_second(u64::MAX, 0), 0);
    }

    #[test]
    fn protects_self_and_critical_system_pids() {
        assert!(protected_reason(0, 42).is_some());
        assert!(protected_reason(1, 42).is_some());
        assert!(protected_reason(42, 42).is_some());
        assert!(protected_reason(43, 42).is_none());
    }
}
