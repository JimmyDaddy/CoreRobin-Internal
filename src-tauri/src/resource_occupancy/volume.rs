//! Bounded removable-volume occupancy probe.
//!
//! This module intentionally observes only metadata and process references. It does not walk the
//! volume, read file contents, eject a device, or ask the OS to close another process's handles.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::VOLUME_SCAN_TIMEOUT;
use super::{
    OccupancyCancellation, OccupancyProcess, OccupancyScanResult, OccupancyVolumeScanRequest,
    now_ms,
};

const VOLUME_ACTION_LEASE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VolumeIdentity {
    pub device: u64,
    pub root_inode: u64,
    pub mount_generation: u128,
    mount_point: PathBuf,
    mount_source: Option<String>,
}

/// A native-only, single-use confirmation for a destructive action that is
/// issued exclusively after a clean, no-match volume scan. It deliberately
/// contains no executable action and is consumed before it can return a path.
#[derive(Debug)]
pub(crate) struct VolumeActionLease {
    mount_point: PathBuf,
    identity: VolumeIdentity,
    expires_at: Instant,
}

#[derive(Debug)]
pub(crate) struct VolumeScanForAction {
    pub(crate) result: OccupancyScanResult,
    pub(crate) action_lease: Option<VolumeActionLease>,
}

impl VolumeActionLease {
    pub(crate) fn confirm(
        self,
        second_confirmation: bool,
    ) -> Result<PathBuf, crate::error::CommandError> {
        self.confirm_at(second_confirmation, Instant::now())
    }

    fn confirm_at(
        self,
        second_confirmation: bool,
        now: Instant,
    ) -> Result<PathBuf, crate::error::CommandError> {
        if !second_confirmation {
            return Err(crate::error::CommandError::new(
                "volume_confirmation_required",
                "必须在重新确认该卷后才能执行推出或其他破坏性操作。",
            ));
        }
        if self.expires_at <= now {
            return Err(crate::error::CommandError::new(
                "volume_action_lease_expired",
                "卷确认已过期；请重新扫描并确认当前挂载状态。",
            ));
        }
        let current = read_volume_identity(&self.mount_point)?;
        if current != self.identity {
            return Err(crate::error::CommandError::new(
                "volume_identity_changed",
                "卷身份或挂载点已变化；CoreRobin 不会继续执行破坏性操作。",
            ));
        }
        Ok(self.mount_point)
    }

    pub(crate) fn is_expired(&self, now: Instant) -> bool {
        self.expires_at <= now
    }
}

pub(crate) fn scan_blocking(
    request: OccupancyVolumeScanRequest,
    cancellation: OccupancyCancellation,
) -> Result<OccupancyScanResult, crate::error::CommandError> {
    scan_blocking_for_action(request, cancellation).map(|outcome| outcome.result)
}

pub(crate) fn scan_blocking_for_action(
    request: OccupancyVolumeScanRequest,
    cancellation: OccupancyCancellation,
) -> Result<VolumeScanForAction, crate::error::CommandError> {
    let _active_scan = super::ActiveScanGuard::acquire(&cancellation)?;
    super::validate_request_id(&request.request_id)?;
    let path = validate_volume_target(&request.path)?;
    let path_hint = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("selected volume")
        .to_owned();
    let identity = read_volume_identity(&path)?;
    let captured_at_ms = now_ms();

    if cancellation.is_cancelled() {
        return Ok(VolumeScanForAction {
            result: cancelled_result(
                &request.request_id,
                &path_hint,
                captured_at_ms,
                "外盘占用诊断在采集开始前被取消。",
            ),
            action_lease: None,
        });
    }

    let result = {
        #[cfg(target_os = "macos")]
        {
            let output = super::run_lsof(&path, true, VOLUME_SCAN_TIMEOUT, &cancellation)?;
            if output.cancelled {
                cancelled_result(
                    &request.request_id,
                    &path_hint,
                    captured_at_ms,
                    "外盘占用诊断已取消，并已回收 lsof 子进程。",
                )
            } else if output.timed_out {
                volume_result(
                    &request.request_id,
                    &path_hint,
                    captured_at_ms,
                    "timed_out",
                    Vec::new(),
                    true,
                    "扫描超过 15 秒，已停止子进程；空结果不代表可以安全推出。",
                )
            } else {
                let (processes, parser_truncated) = super::parse_lsof(&output.stdout);
                let truncated = output.output_truncated || parser_truncated;
                let status = if !output.status.success() && output.status.code() != Some(1) {
                    "partial"
                } else if truncated {
                    "truncated"
                } else {
                    "scoped_complete"
                };
                volume_result(
                    &request.request_id,
                    &path_hint,
                    captured_at_ms,
                    status,
                    processes,
                    truncated,
                    "结果仅覆盖本次 lsof 外盘采集范围；空结果不代表可以安全推出。",
                )
            }
        }

        #[cfg(target_os = "linux")]
        {
            scan_linux_volume(
                &request.request_id,
                &path,
                &path_hint,
                captured_at_ms,
                identity.clone(),
                &cancellation,
            )
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (path, identity);
            volume_result(
                &request.request_id,
                &path_hint,
                captured_at_ms,
                "unsupported",
                Vec::new(),
                false,
                "当前平台不提供外盘整卷占用诊断；不会关闭其他进程句柄。",
            )
        }
    };

    let result = finalize_volume_scan(
        &request.request_id,
        &path_hint,
        captured_at_ms,
        &path,
        &identity,
        &cancellation,
        result,
    );
    let action_lease = action_lease_for(&result, &path, identity);
    Ok(VolumeScanForAction {
        result,
        action_lease,
    })
}

fn action_lease_for(
    result: &OccupancyScanResult,
    mount_point: &Path,
    identity: VolumeIdentity,
) -> Option<VolumeActionLease> {
    (result.status == "scoped_complete" && !result.truncated && result.processes.is_empty()).then(
        || VolumeActionLease {
            mount_point: mount_point.to_owned(),
            identity,
            expires_at: Instant::now() + VOLUME_ACTION_LEASE_TTL,
        },
    )
}

fn finalize_volume_scan(
    request_id: &str,
    path_hint: &str,
    captured_at_ms: u64,
    path: &Path,
    identity: &VolumeIdentity,
    cancellation: &OccupancyCancellation,
    mut result: OccupancyScanResult,
) -> OccupancyScanResult {
    if cancellation.is_cancelled() {
        return cancelled_result(
            request_id,
            path_hint,
            captured_at_ms,
            "外盘占用诊断已取消；结果不完整，不能据此判断没有使用者。",
        );
    }

    match read_volume_identity(path) {
        Ok(current) if current == *identity => result,
        Ok(_) => {
            result.status = "target_changed".to_owned();
            result.processes.clear();
            result.truncated = true;
            result.message =
                Some("卷身份或挂载点在采集期间发生变化；不会继续任何推出动作。".to_owned());
            result
        }
        Err(_) => {
            result.status = "volume_unavailable".to_owned();
            result.processes.clear();
            result.truncated = true;
            result.message =
                Some("卷在采集期间离线、无权限或无法复验；不会继续任何推出动作。".to_owned());
            result
        }
    }
}

fn validate_volume_target(raw_path: &str) -> Result<PathBuf, crate::error::CommandError> {
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        return Err(crate::error::CommandError::new(
            "invalid_volume_target",
            "外盘诊断只接受用户选择的绝对挂载路径。",
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        crate::error::CommandError::new(
            "volume_unavailable",
            format!("无法读取外盘挂载点：{error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(crate::error::CommandError::new(
            "invalid_volume_target",
            "外盘诊断只接受非符号链接的挂载目录。",
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        crate::error::CommandError::new(
            "volume_unavailable",
            format!("无法确认外盘挂载身份：{error}"),
        )
    })?;
    // Identity reading verifies that this is the selected mount root, rather
    // than an arbitrary directory that happens to live on the same device.
    read_volume_identity(&canonical)?;
    Ok(canonical)
}

fn read_volume_identity(path: &Path) -> Result<VolumeIdentity, crate::error::CommandError> {
    let entry = fs::symlink_metadata(path).map_err(|error| {
        crate::error::CommandError::new("volume_unavailable", format!("无法复验外盘身份：{error}"))
    })?;
    if entry.file_type().is_symlink() || !entry.is_dir() {
        return Err(crate::error::CommandError::new(
            "volume_identity_changed",
            "挂载点不再是原先选择的目录；不会继续推出操作。",
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        crate::error::CommandError::new("volume_unavailable", format!("无法复验外盘身份：{error}"))
    })?;
    if canonical != path {
        return Err(crate::error::CommandError::new(
            "volume_identity_changed",
            "挂载点解析到了不同位置；不会继续推出操作。",
        ));
    }
    let metadata = fs::metadata(&canonical).map_err(|error| {
        crate::error::CommandError::new("volume_unavailable", format!("无法复验外盘身份：{error}"))
    })?;
    #[cfg(target_os = "macos")]
    let (device, root_inode, metadata_generation) = {
        use std::os::unix::fs::MetadataExt;
        (
            metadata.dev(),
            metadata.ino(),
            u128::from(metadata.ctime().unsigned_abs()) * 1_000_000_000
                + u128::from(metadata.ctime_nsec().unsigned_abs()),
        )
    };
    #[cfg(target_os = "linux")]
    let (device, root_inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let (device, root_inode) = (0, 0);

    #[cfg(target_os = "linux")]
    let (mount_generation, mount_source) = (linux_mount_generation(&canonical)?, None);
    #[cfg(target_os = "macos")]
    let (mount_generation, mount_source) = macos_mount_binding(&canonical, metadata_generation)?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let (mount_generation, mount_source) = (metadata.len() as u128, None);

    Ok(VolumeIdentity {
        device,
        root_inode,
        mount_generation,
        mount_point: canonical,
        mount_source,
    })
}

#[cfg(target_os = "linux")]
fn linux_mount_generation(path: &Path) -> Result<u128, crate::error::CommandError> {
    let expected = path.to_str().ok_or_else(|| {
        crate::error::CommandError::new("invalid_volume_target", "外盘挂载路径必须是有效文本。")
    })?;
    let mount_info = fs::read_to_string("/proc/self/mountinfo").map_err(|error| {
        crate::error::CommandError::new(
            "volume_unavailable",
            format!("无法读取当前挂载信息：{error}"),
        )
    })?;
    mount_info
        .lines()
        .filter_map(parse_linux_mount_record)
        .find(|(_, mount_point)| mount_point == expected)
        .map(|(mount_id, _)| mount_id)
        .ok_or_else(|| {
            crate::error::CommandError::new(
                "invalid_volume_target",
                "外盘诊断只接受当前挂载点，不接受其内部目录。",
            )
        })
}

#[cfg(target_os = "linux")]
fn parse_linux_mount_record(line: &str) -> Option<(u128, String)> {
    let mut fields = line.split(" - ").next()?.split_whitespace();
    let mount_id = fields.next()?.parse::<u128>().ok()?;
    fields.next()?;
    fields.next()?;
    fields.next()?;
    let mount_point = fields.next()?;
    Some((mount_id, decode_linux_mount_field(mount_point)))
}

#[cfg(target_os = "linux")]
fn decode_linux_mount_field(field: &str) -> String {
    field
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(target_os = "macos")]
fn macos_mount_binding(
    path: &Path,
    metadata_generation: u128,
) -> Result<(u128, Option<String>), crate::error::CommandError> {
    use std::ffi::{CStr, CString, OsStr};
    use std::os::unix::ffi::OsStrExt;

    let raw_path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        crate::error::CommandError::new("invalid_volume_target", "外盘挂载路径不能包含空字节。")
    })?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    if unsafe { libc::statfs(raw_path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(crate::error::CommandError::new(
            "volume_unavailable",
            format!("无法读取当前挂载信息：{}", std::io::Error::last_os_error()),
        ));
    }
    let stats = unsafe { stats.assume_init() };
    let mount_point = unsafe { CStr::from_ptr(stats.f_mntonname.as_ptr()) }.to_bytes();
    if Path::new(OsStr::from_bytes(mount_point)) != path {
        return Err(crate::error::CommandError::new(
            "invalid_volume_target",
            "外盘诊断只接受当前挂载点，不接受其内部目录。",
        ));
    }
    let source = unsafe { CStr::from_ptr(stats.f_mntfromname.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    let generation = metadata_generation
        ^ (u128::from(stats.f_type) << 64)
        ^ (u128::from(stats.f_fssubtype) << 32)
        ^ u128::from(stats.f_flags);
    Ok((generation, Some(source)))
}

#[cfg(target_os = "linux")]
enum ProbeInterruption {
    Cancelled,
    TimedOut,
}

#[cfg(target_os = "linux")]
fn scan_linux_volume(
    request_id: &str,
    _path: &Path,
    path_hint: &str,
    captured_at_ms: u64,
    identity: VolumeIdentity,
    cancellation: &OccupancyCancellation,
) -> OccupancyScanResult {
    use std::os::unix::fs::MetadataExt;

    let started = Instant::now();
    let mut processes = Vec::new();
    let mut process_count = 0;
    let mut references = 0;
    let mut truncated = false;
    let mut permission_gap = false;
    let Ok(entries) = fs::read_dir("/proc") else {
        return volume_result(
            request_id,
            path_hint,
            captured_at_ms,
            "unsupported",
            Vec::new(),
            false,
            "当前 Linux 构建无法读取可见 /proc；空结果不代表可以安全推出。",
        );
    };

    for entry in entries.flatten() {
        if let Some(interruption) = probe_interruption(&started, cancellation) {
            return interrupted_result(request_id, path_hint, captured_at_ms, interruption);
        }
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        process_count += 1;
        if process_count > super::MAX_PROCESSES {
            truncated = true;
            break;
        }
        let process_dir = entry.path();
        let command = fs::read_to_string(process_dir.join("comm"))
            .ok()
            .map(|value| value.trim().to_owned());
        if command.is_none()
            && fs::metadata(process_dir.join("comm"))
                .is_err_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
        {
            permission_gap = true;
        }

        let mut evidence_types = Vec::new();
        let fd_path = process_dir.join("fd");
        match fs::read_dir(&fd_path) {
            Ok(fds) => {
                for fd in fds.flatten() {
                    if let Some(interruption) = probe_interruption(&started, cancellation) {
                        return interrupted_result(
                            request_id,
                            path_hint,
                            captured_at_ms,
                            interruption,
                        );
                    }
                    references += 1;
                    if references > super::MAX_REFERENCES {
                        truncated = true;
                        break;
                    }
                    match fs::metadata(fd.path()) {
                        Ok(metadata) if metadata.dev() == identity.device => {
                            evidence_types.push("fd".to_owned());
                            break;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            permission_gap |= error.kind() == std::io::ErrorKind::PermissionDenied;
                        }
                    }
                }
            }
            Err(error) => {
                permission_gap |= error.kind() == std::io::ErrorKind::PermissionDenied;
            }
        }
        if truncated {
            break;
        }

        for (kind, candidate) in [
            ("cwd", process_dir.join("cwd")),
            ("root", process_dir.join("root")),
        ] {
            if let Some(interruption) = probe_interruption(&started, cancellation) {
                return interrupted_result(request_id, path_hint, captured_at_ms, interruption);
            }
            references += 1;
            if references > super::MAX_REFERENCES {
                truncated = true;
                break;
            }
            match fs::metadata(candidate) {
                Ok(metadata) if metadata.dev() == identity.device => {
                    evidence_types.push(kind.to_owned())
                }
                Ok(_) => {}
                Err(error) => {
                    permission_gap |= error.kind() == std::io::ErrorKind::PermissionDenied;
                }
            }
        }
        if truncated {
            break;
        }

        match read_proc_maps_volume_match(
            &process_dir,
            identity.device,
            &started,
            cancellation,
            &mut references,
            &mut truncated,
            &mut permission_gap,
        ) {
            Ok(true) => evidence_types.push("maps".to_owned()),
            Ok(false) => {}
            Err(interruption) => {
                return interrupted_result(request_id, path_hint, captured_at_ms, interruption);
            }
        }
        if truncated {
            break;
        }

        if !evidence_types.is_empty() {
            if processes.len() >= super::MAX_RESULTS {
                truncated = true;
                break;
            }
            processes.push(OccupancyProcess {
                pid,
                command,
                user: None,
                evidence_types,
            });
        }
    }

    volume_result(
        request_id,
        path_hint,
        captured_at_ms,
        if permission_gap {
            "partial"
        } else if truncated {
            "truncated"
        } else {
            "scoped_complete"
        },
        processes,
        truncated,
        if permission_gap {
            "部分 /proc 引用因权限或进程竞态不可见；空结果不代表可以安全推出。"
        } else if truncated {
            "结果达到时间、进程、引用或展示上限；空结果不代表可以安全推出。"
        } else {
            "结果仅覆盖可见 /proc 的 fd/cwd/root/maps 身份匹配；空结果不代表可以安全推出。"
        },
    )
}

#[cfg(target_os = "linux")]
fn probe_interruption(
    started: &Instant,
    cancellation: &OccupancyCancellation,
) -> Option<ProbeInterruption> {
    if cancellation.is_cancelled() {
        Some(ProbeInterruption::Cancelled)
    } else if started.elapsed() >= VOLUME_SCAN_TIMEOUT {
        Some(ProbeInterruption::TimedOut)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn interrupted_result(
    request_id: &str,
    path_hint: &str,
    captured_at_ms: u64,
    interruption: ProbeInterruption,
) -> OccupancyScanResult {
    match interruption {
        ProbeInterruption::Cancelled => cancelled_result(
            request_id,
            path_hint,
            captured_at_ms,
            "Linux 外盘占用诊断已取消；结果不完整，不能据此判断没有使用者。",
        ),
        ProbeInterruption::TimedOut => volume_result(
            request_id,
            path_hint,
            captured_at_ms,
            "timed_out",
            Vec::new(),
            true,
            "扫描超过 15 秒，已停止继续读取 /proc；空结果不代表可以安全推出。",
        ),
    }
}

#[cfg(target_os = "linux")]
fn read_proc_maps_volume_match(
    process_dir: &Path,
    volume_device: u64,
    started: &Instant,
    cancellation: &OccupancyCancellation,
    references: &mut usize,
    truncated: &mut bool,
    permission_gap: &mut bool,
) -> Result<bool, ProbeInterruption> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;

    let mut file = match fs::File::open(process_dir.join("maps")) {
        Ok(file) => file,
        Err(error) => {
            *permission_gap |= error.kind() == std::io::ErrorKind::PermissionDenied;
            return Ok(false);
        }
    };
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        if let Some(interruption) = probe_interruption(started, cancellation) {
            return Err(interruption);
        }
        let read = match file.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                *permission_gap |= error.kind() == std::io::ErrorKind::PermissionDenied;
                return Ok(false);
            }
        };
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) > super::MAX_PROC_MAPS_BYTES {
            *truncated = true;
            return Ok(false);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    for line in String::from_utf8_lossy(&bytes).lines() {
        if let Some(interruption) = probe_interruption(started, cancellation) {
            return Err(interruption);
        }
        let Some(path) = line.split_whitespace().nth(5) else {
            continue;
        };
        if !path.starts_with('/') {
            continue;
        }
        *references += 1;
        if *references > super::MAX_REFERENCES {
            *truncated = true;
            return Ok(false);
        }
        match fs::metadata(path) {
            Ok(metadata) if metadata.dev() == volume_device => return Ok(true),
            Ok(_) => {}
            Err(error) => {
                *permission_gap |= error.kind() == std::io::ErrorKind::PermissionDenied;
            }
        }
    }
    Ok(false)
}

fn volume_result(
    request_id: &str,
    path_hint: &str,
    captured_at_ms: u64,
    status: &str,
    processes: Vec<OccupancyProcess>,
    truncated: bool,
    message: &str,
) -> OccupancyScanResult {
    OccupancyScanResult {
        request_id: request_id.to_owned(),
        status: status.to_owned(),
        path_hint: path_hint.to_owned(),
        captured_at_ms,
        processes,
        coverage: vec!["用户选择的单一挂载点；固定上限的 lsof 或可见 /proc 引用匹配".to_owned()],
        truncated,
        message: Some(message.to_owned()),
    }
}

fn cancelled_result(
    request_id: &str,
    path_hint: &str,
    captured_at_ms: u64,
    message: &str,
) -> OccupancyScanResult {
    volume_result(
        request_id,
        path_hint,
        captured_at_ms,
        "cancelled",
        Vec::new(),
        false,
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_targets_must_be_current_mount_roots() {
        let root = Path::new("/");
        let identity = read_volume_identity(root).expect("root mount identity reads");
        assert!(validate_volume_target("/").is_ok());
        assert_eq!(
            identity.root_inode,
            read_volume_identity(root).unwrap().root_inode
        );
        assert!(validate_volume_target("relative-volume").is_err());
        let directory = tempfile::tempdir().expect("non-mount directory fixture");
        let error = validate_volume_target(directory.path().to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, "invalid_volume_target");
        let file = directory.path().join("not-a-volume");
        std::fs::write(&file, b"fixture").expect("file fixture writes");
        assert!(validate_volume_target(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn only_clean_complete_empty_results_receive_an_action_lease() {
        let root = Path::new("/");
        let identity = read_volume_identity(root).expect("root mount identity reads");
        let complete = volume_result(
            "request",
            "root",
            1,
            "scoped_complete",
            Vec::new(),
            false,
            "fixture",
        );
        assert!(action_lease_for(&complete, root, identity.clone()).is_some());

        for status in [
            "cancelled",
            "timed_out",
            "partial",
            "truncated",
            "target_changed",
        ] {
            let incomplete =
                volume_result("request", "root", 1, status, Vec::new(), false, "fixture");
            assert!(
                action_lease_for(&incomplete, root, identity.clone()).is_none(),
                "{status} results must never permit a destructive action"
            );
        }
        let with_match = volume_result(
            "request",
            "root",
            1,
            "scoped_complete",
            vec![OccupancyProcess {
                pid: 1,
                command: None,
                user: None,
                evidence_types: vec!["fd".to_owned()],
            }],
            false,
            "fixture",
        );
        assert!(action_lease_for(&with_match, root, identity.clone()).is_none());
        let truncated = volume_result(
            "request",
            "root",
            1,
            "scoped_complete",
            Vec::new(),
            true,
            "fixture",
        );
        assert!(action_lease_for(&truncated, root, identity).is_none());
    }

    #[test]
    fn second_confirmation_expiry_and_identity_change_never_return_a_mount_path() {
        let root = PathBuf::from("/");
        let identity = read_volume_identity(&root).expect("root mount identity reads");
        let make_lease = |identity: VolumeIdentity, expires_at: Instant| VolumeActionLease {
            mount_point: root.clone(),
            identity,
            expires_at,
        };

        let missing_confirmation =
            make_lease(identity.clone(), Instant::now() + Duration::from_secs(1));
        assert_eq!(
            missing_confirmation
                .confirm_at(false, Instant::now())
                .unwrap_err()
                .code,
            "volume_confirmation_required"
        );

        let expired = make_lease(identity.clone(), Instant::now() - Duration::from_millis(1));
        assert_eq!(
            expired.confirm_at(true, Instant::now()).unwrap_err().code,
            "volume_action_lease_expired"
        );

        let mut replacement_mount = identity;
        replacement_mount.mount_generation ^= 1;
        let changed = make_lease(replacement_mount, Instant::now() + Duration::from_secs(1));
        assert_eq!(
            changed.confirm_at(true, Instant::now()).unwrap_err().code,
            "volume_identity_changed"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_mount_records_bind_the_exact_mount_point_and_mount_generation() {
        let record = parse_linux_mount_record(
            "42 28 8:1 / /media/External\\040Drive rw,nosuid - ext4 /dev/sdb1 rw",
        )
        .expect("mountinfo fixture parses");
        assert_eq!(record.0, 42);
        assert_eq!(record.1, "/media/External Drive");
    }
}
