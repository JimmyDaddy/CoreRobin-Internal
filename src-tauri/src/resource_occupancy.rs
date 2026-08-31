use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::CommandError;

#[cfg(target_os = "linux")]
const MAX_PROCESSES: usize = 4_096;
#[cfg(target_os = "linux")]
const MAX_REFERENCES: usize = 65_536;
const MAX_RESULTS: usize = 300;
const SCAN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupancyScanRequest {
    pub request_id: String,
    pub path: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupancyScanResult {
    pub request_id: String,
    pub status: String,
    pub path_hint: String,
    pub captured_at_ms: u64,
    pub processes: Vec<OccupancyProcess>,
    pub coverage: Vec<String>,
    pub truncated: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupancyProcess {
    pub pid: u32,
    pub command: Option<String>,
    pub user: Option<String>,
    pub evidence_types: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    length: u64,
    modified_ns: u128,
}

pub async fn scan(request: OccupancyScanRequest) -> Result<OccupancyScanResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(request))
        .await
        .map_err(|error| CommandError::internal(format!("Occupancy scan task failed: {error}")))?
}

fn scan_blocking(request: OccupancyScanRequest) -> Result<OccupancyScanResult, CommandError> {
    let path = validate_target(&request.path)?;
    let path_hint = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("selected file")
        .to_owned();
    let identity = read_identity(&path)?;
    let captured_at_ms = now_ms();

    #[cfg(target_os = "macos")]
    let mut result = scan_macos(&request.request_id, &path, &path_hint, captured_at_ms)?;
    #[cfg(target_os = "linux")]
    let mut result = scan_linux(
        &request.request_id,
        &path,
        &path_hint,
        captured_at_ms,
        identity,
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let mut result = unsupported_result(&request.request_id, &path_hint, captured_at_ms);

    if read_identity(&path).ok() != Some(identity) {
        result.status = "target_changed".to_owned();
        result.message =
            Some("目标文件在采集期间发生变化；结果只能用于诊断，不能作为安全推出证明。".to_owned());
        result.processes.clear();
    }
    Ok(result)
}

fn validate_target(raw_path: &str) -> Result<PathBuf, CommandError> {
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        return Err(CommandError::new(
            "invalid_target",
            "占用诊断只接受用户选择的绝对路径。",
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        CommandError::new("target_unavailable", format!("无法读取目标文件：{error}"))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(CommandError::new(
            "symlink_not_allowed",
            "占用诊断不接受符号链接目标。",
        ));
    }
    if !metadata.is_file() {
        return Err(CommandError::new(
            "not_regular_file",
            "占用诊断只接受普通文件，不扫描目录、设备或管道。",
        ));
    }
    fs::canonicalize(path).map_err(|error| {
        CommandError::new("target_unavailable", format!("无法确认目标身份：{error}"))
    })
}

fn read_identity(path: &Path) -> Result<FileIdentity, CommandError> {
    let metadata = fs::metadata(path).map_err(|error| {
        CommandError::new("target_unavailable", format!("无法复验目标身份：{error}"))
    })?;
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let (device, inode) = (0, 0);
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    Ok(FileIdentity {
        device,
        inode,
        length: metadata.len(),
        modified_ns,
    })
}

#[cfg(target_os = "macos")]
fn scan_macos(
    request_id: &str,
    path: &Path,
    path_hint: &str,
    captured_at_ms: u64,
) -> Result<OccupancyScanResult, CommandError> {
    let mut child = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-Fpcuf", "--"])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            CommandError::new("provider_unavailable", format!("无法启动 lsof：{error}"))
        })?;
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| CommandError::internal(format!("lsof 状态读取失败：{error}")))?
            .is_some()
        {
            break;
        }
        if started.elapsed() >= SCAN_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(OccupancyScanResult {
                request_id: request_id.to_owned(),
                status: "timed_out".to_owned(),
                path_hint: path_hint.to_owned(),
                captured_at_ms,
                processes: Vec::new(),
                coverage: vec!["macOS lsof 固定参数文件引用诊断".to_owned()],
                truncated: false,
                message: Some("扫描超过 10 秒，已停止子进程；空结果不代表没有占用。".to_owned()),
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| CommandError::internal(format!("lsof 输出读取失败：{error}")))?;
    let (processes, truncated) = parse_lsof(&output.stdout);
    Ok(OccupancyScanResult {
        request_id: request_id.to_owned(),
        status: if truncated {
            "truncated"
        } else {
            "scoped_complete"
        }
        .to_owned(),
        path_hint: path_hint.to_owned(),
        captured_at_ms,
        processes,
        coverage: vec!["macOS lsof 固定参数文件引用诊断".to_owned()],
        truncated,
        message: if output.status.success() || output.status.code() == Some(1) {
            Some("结果仅覆盖本次 lsof 采集范围；空结果不代表可以安全推出。".to_owned())
        } else {
            Some("lsof 返回了非零状态，结果可能不完整；请检查系统权限后重试。".to_owned())
        },
    })
}

#[cfg(target_os = "macos")]
fn parse_lsof(bytes: &[u8]) -> (Vec<OccupancyProcess>, bool) {
    let mut processes = Vec::new();
    let mut current: Option<OccupancyProcess> = None;
    let mut truncated = false;
    for line in String::from_utf8_lossy(bytes).lines() {
        let (kind, value) = line.split_at(line.chars().next().map(char::len_utf8).unwrap_or(0));
        match kind {
            "p" => {
                if let Some(process) = current.take() {
                    processes.push(process);
                }
                let Ok(pid) = value.parse::<u32>() else {
                    continue;
                };
                if processes.len() >= MAX_RESULTS {
                    truncated = true;
                    break;
                }
                current = Some(OccupancyProcess {
                    pid,
                    command: None,
                    user: None,
                    evidence_types: vec!["file".to_owned()],
                });
            }
            "c" => {
                if let Some(process) = current.as_mut() {
                    process.command = Some(value.to_owned());
                }
            }
            "u" => {
                if let Some(process) = current.as_mut() {
                    process.user = Some(value.to_owned());
                }
            }
            "f" => {
                if let Some(process) = current.as_mut() {
                    process.evidence_types = vec![format!("fd:{value}")];
                }
            }
            _ => {}
        }
    }
    if let Some(process) = current {
        if processes.len() < MAX_RESULTS {
            processes.push(process);
        } else {
            truncated = true;
        }
    }
    (processes, truncated)
}

#[cfg(target_os = "linux")]
fn scan_linux(
    request_id: &str,
    _path: &Path,
    path_hint: &str,
    captured_at_ms: u64,
    identity: FileIdentity,
) -> OccupancyScanResult {
    use std::os::unix::fs::MetadataExt;

    let started = Instant::now();
    let mut processes = Vec::new();
    let mut process_count = 0;
    let mut references = 0;
    let mut truncated = false;
    let Ok(entries) = fs::read_dir("/proc") else {
        return unsupported_result(request_id, path_hint, captured_at_ms);
    };
    for entry in entries.flatten() {
        if started.elapsed() >= SCAN_TIMEOUT {
            truncated = true;
            break;
        }
        let name = entry.file_name();
        let Ok(pid) = name.to_string_lossy().parse::<u32>() else {
            continue;
        };
        process_count += 1;
        if process_count > MAX_PROCESSES {
            truncated = true;
            break;
        }
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
                    references += 1;
                    if references > MAX_REFERENCES {
                        truncated = true;
                        return true;
                    }
                    fs::metadata(fd.path())
                        .ok()
                        .map(|metadata| {
                            metadata.dev() == identity.device && metadata.ino() == identity.inode
                        })
                        .unwrap_or(false)
                })
            } else {
                fs::metadata(&candidate)
                    .ok()
                    .map(|metadata| {
                        metadata.dev() == identity.device && metadata.ino() == identity.inode
                    })
                    .unwrap_or(false)
            };
            if matches {
                evidence_types.push(kind.to_owned());
            }
            if truncated {
                break;
            }
        }
        if !evidence_types.is_empty() {
            if processes.len() >= MAX_RESULTS {
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
    OccupancyScanResult {
        request_id: request_id.to_owned(),
        status: if truncated {
            "truncated"
        } else {
            "scoped_complete"
        }
        .to_owned(),
        path_hint: path_hint.to_owned(),
        captured_at_ms,
        processes,
        coverage: vec!["Linux /proc fd/cwd/root 身份匹配".to_owned()],
        truncated,
        message: Some("结果仅覆盖可见 /proc 采集范围；空结果不代表可以安全推出。".to_owned()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn unsupported_result(
    request_id: &str,
    path_hint: &str,
    captured_at_ms: u64,
) -> OccupancyScanResult {
    OccupancyScanResult {
        request_id: request_id.to_owned(),
        status: "unsupported".to_owned(),
        path_hint: path_hint.to_owned(),
        captured_at_ms,
        processes: Vec::new(),
        coverage: Vec::new(),
        truncated: false,
        message: Some("当前平台不提供文件占用诊断；不会调用 Windows 整卷关闭接口。".to_owned()),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_paths_and_symlinks() {
        let error = validate_target("relative.txt").expect_err("relative path must be rejected");
        assert_eq!(error.code, "invalid_target");
    }
}
