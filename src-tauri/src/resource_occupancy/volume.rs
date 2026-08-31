//! Bounded removable-volume occupancy probe.
//!
//! This module intentionally observes only metadata and process references. It does not walk the
//! volume, read file contents, eject a device, or ask the OS to close another process's handles.

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::VOLUME_SCAN_TIMEOUT;
use super::{
    OccupancyCancellation, OccupancyProcess, OccupancyScanResult, OccupancyVolumeScanRequest,
    now_ms,
};
#[cfg(target_os = "linux")]
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VolumeIdentity {
    pub device: u64,
    pub root_inode: u64,
    pub mount_generation: u128,
}

pub(crate) fn scan_blocking(
    request: OccupancyVolumeScanRequest,
    cancellation: OccupancyCancellation,
) -> Result<OccupancyScanResult, crate::error::CommandError> {
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
        return Ok(cancelled_result(
            &request.request_id,
            &path_hint,
            captured_at_ms,
            "外盘占用诊断在采集开始前被取消。",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let output = super::run_lsof(&path, true, VOLUME_SCAN_TIMEOUT, &cancellation)?;
        if output.cancelled {
            return Ok(cancelled_result(
                &request.request_id,
                &path_hint,
                captured_at_ms,
                "外盘占用诊断已取消，并已回收 lsof 子进程。",
            ));
        }
        if output.timed_out {
            return Ok(volume_result(
                &request.request_id,
                &path_hint,
                captured_at_ms,
                "timed_out",
                Vec::new(),
                true,
                "扫描超过 15 秒，已停止子进程；空结果不代表可以安全推出。",
            ));
        }
        let (processes, parser_truncated) = super::parse_lsof(&output.stdout);
        let truncated = output.output_truncated || parser_truncated;
        let status = if !output.status.success() && output.status.code() != Some(1) {
            "partial"
        } else if truncated {
            "truncated"
        } else {
            "scoped_complete"
        };
        let mut result = volume_result(
            &request.request_id,
            &path_hint,
            captured_at_ms,
            status,
            processes,
            truncated,
            "结果仅覆盖本次 lsof 外盘采集范围；空结果不代表可以安全推出。",
        );
        if read_volume_identity(&path).ok() != Some(identity) {
            result.status = "target_changed".to_owned();
            result.processes.clear();
            result.message =
                Some("卷身份在采集期间发生变化；必须重新确认后才能继续任何推出动作。".to_owned());
        }
        Ok(result)
    }

    #[cfg(target_os = "linux")]
    {
        let mut result = scan_linux_volume(
            &request.request_id,
            &path,
            &path_hint,
            captured_at_ms,
            identity,
            &cancellation,
        );
        if read_volume_identity(&path).ok() != Some(identity) {
            result.status = "target_changed".to_owned();
            result.processes.clear();
            result.message =
                Some("卷身份在采集期间发生变化；必须重新确认后才能继续任何推出动作。".to_owned());
        }
        Ok(result)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, identity);
        Ok(volume_result(
            &request.request_id,
            &path_hint,
            captured_at_ms,
            "unsupported",
            Vec::new(),
            false,
            "当前平台不提供外盘整卷占用诊断；不会关闭其他进程句柄。",
        ))
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
    fs::canonicalize(path).map_err(|error| {
        crate::error::CommandError::new(
            "volume_unavailable",
            format!("无法确认外盘挂载身份：{error}"),
        )
    })
}

fn read_volume_identity(path: &Path) -> Result<VolumeIdentity, crate::error::CommandError> {
    let metadata = fs::metadata(path).map_err(|error| {
        crate::error::CommandError::new("volume_unavailable", format!("无法复验外盘身份：{error}"))
    })?;
    #[cfg(unix)]
    let (device, root_inode, mount_generation) = {
        use std::os::unix::fs::MetadataExt;
        (
            metadata.dev(),
            metadata.ino(),
            u128::from(metadata.ctime().unsigned_abs()) * 1_000_000_000
                + u128::from(metadata.ctime_nsec().unsigned_abs()),
        )
    };
    #[cfg(not(unix))]
    let (device, root_inode, mount_generation) = (0, 0, metadata.len() as u128);
    Ok(VolumeIdentity {
        device,
        root_inode,
        mount_generation,
    })
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
    let mut truncated = false;
    for entry in entries.flatten() {
        if cancellation.is_cancelled() {
            return cancelled_result(
                request_id,
                path_hint,
                captured_at_ms,
                "Linux 外盘占用诊断已取消。",
            );
        }
        if started.elapsed() >= VOLUME_SCAN_TIMEOUT {
            truncated = true;
            break;
        }
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let process_dir = entry.path();
        let command = fs::read_to_string(process_dir.join("comm"))
            .ok()
            .map(|value| value.trim().to_owned());
        let mut evidence_types = Vec::new();
        for (kind, candidate) in [
            ("fd", process_dir.join("fd")),
            ("cwd", process_dir.join("cwd")),
            ("root", process_dir.join("root")),
        ] {
            let matches = if kind == "fd" {
                let Ok(fds) = fs::read_dir(&candidate) else {
                    continue;
                };
                fds.flatten().any(|fd| {
                    fs::metadata(fd.path())
                        .ok()
                        .is_some_and(|metadata| metadata.dev() == identity.device)
                })
            } else {
                fs::metadata(&candidate)
                    .ok()
                    .is_some_and(|metadata| metadata.dev() == identity.device)
            };
            if matches {
                evidence_types.push(kind.to_owned());
            }
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
        if truncated {
            "truncated"
        } else {
            "scoped_complete"
        },
        processes,
        truncated,
        "结果仅覆盖可见 /proc 的 fd/cwd/root 身份匹配；空结果不代表可以安全推出。",
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_targets_are_absolute_directories_and_have_an_identity() {
        let root = tempfile::tempdir().expect("temporary mount fixture");
        let identity = read_volume_identity(root.path()).expect("directory identity reads");
        assert!(validate_volume_target(root.path().to_str().unwrap()).is_ok());
        assert_eq!(
            identity.root_inode,
            read_volume_identity(root.path()).unwrap().root_inode
        );
        assert!(validate_volume_target("relative-volume").is_err());
        let file = root.path().join("not-a-volume");
        std::fs::write(&file, b"fixture").expect("file fixture writes");
        assert!(validate_volume_target(file.to_str().unwrap()).is_err());
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
