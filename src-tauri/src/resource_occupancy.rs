use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CommandError;

#[cfg(target_os = "linux")]
const MAX_PROCESSES: usize = 4_096;
#[cfg(target_os = "linux")]
const MAX_REFERENCES: usize = 65_536;
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MAX_RESULTS: usize = 300;
#[cfg(any(target_os = "macos", target_os = "linux"))]
const FILE_SCAN_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const VOLUME_SCAN_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MAX_COMMAND_OUTPUT: usize = 8 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_PROC_MAPS_BYTES: usize = 2 * 1024 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;

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

/// Cancellation is deliberately independent of the ToolboxService lock. The
/// future command wiring can keep one token per scan and call `cancel` from a
/// separate control path while the scanner is reading /proc or lsof output.
#[derive(Clone, Debug, Default)]
pub struct OccupancyCancellation {
    cancelled: Arc<AtomicBool>,
}

impl OccupancyCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)]
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

pub fn cancel_active() -> bool {
    let Some(slot) = ACTIVE_SCAN.get() else {
        return false;
    };
    let Ok(active) = slot.lock() else {
        return false;
    };
    let Some(token) = active.as_ref() else {
        return false;
    };
    token.store(true, Ordering::Release);
    true
}

#[derive(Debug)]
struct ActiveScanGuard {
    cancellation: Arc<AtomicBool>,
}

static ACTIVE_SCAN: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

impl ActiveScanGuard {
    fn acquire(cancellation: &OccupancyCancellation) -> Result<Self, CommandError> {
        let slot = ACTIVE_SCAN.get_or_init(|| Mutex::new(None));
        let mut active = slot
            .lock()
            .map_err(|_| CommandError::internal("占用诊断状态不可用。"))?;
        if active.is_some() {
            return Err(CommandError::new(
                "busy",
                "已有占用诊断正在运行；请等待其结束后再重试。",
            ));
        }
        let token = Arc::clone(&cancellation.cancelled);
        *active = Some(Arc::clone(&token));
        Ok(Self {
            cancellation: token,
        })
    }
}

impl Drop for ActiveScanGuard {
    fn drop(&mut self) {
        if let Some(slot) = ACTIVE_SCAN.get()
            && let Ok(mut active) = slot.lock()
            && active
                .as_ref()
                .is_some_and(|token| Arc::ptr_eq(token, &self.cancellation))
        {
            *active = None;
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    length: u64,
    modified_ns: u128,
    changed_ns: i128,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OccupancyVolumeScanRequest {
    pub request_id: String,
    pub path: String,
}

#[path = "resource_occupancy/volume.rs"]
mod volume;

pub async fn scan(request: OccupancyScanRequest) -> Result<OccupancyScanResult, CommandError> {
    scan_with_cancellation(request, OccupancyCancellation::new()).await
}

pub async fn scan_with_cancellation(
    request: OccupancyScanRequest,
    cancellation: OccupancyCancellation,
) -> Result<OccupancyScanResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(request, cancellation))
        .await
        .map_err(|error| CommandError::internal(format!("Occupancy scan task failed: {error}")))?
}

pub async fn scan_volume(
    request: OccupancyVolumeScanRequest,
) -> Result<OccupancyScanResult, CommandError> {
    scan_volume_with_cancellation(request, OccupancyCancellation::new()).await
}

pub async fn scan_volume_with_cancellation(
    request: OccupancyVolumeScanRequest,
    cancellation: OccupancyCancellation,
) -> Result<OccupancyScanResult, CommandError> {
    tauri::async_runtime::spawn_blocking(move || volume::scan_blocking(request, cancellation))
        .await
        .map_err(|error| CommandError::internal(format!("Volume occupancy task failed: {error}")))?
}

fn scan_blocking(
    request: OccupancyScanRequest,
    cancellation: OccupancyCancellation,
) -> Result<OccupancyScanResult, CommandError> {
    let _active_scan = ActiveScanGuard::acquire(&cancellation)?;
    validate_request_id(&request.request_id)?;
    let path = validate_target(&request.path)?;
    let path_hint = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("selected file")
        .to_owned();
    let identity = read_identity(&path)?;
    let captured_at_ms = now_ms();

    if cancellation.is_cancelled() {
        return Ok(cancelled_result(
            &request.request_id,
            &path_hint,
            captured_at_ms,
            "文件占用诊断在采集开始前被取消。",
        ));
    }

    #[cfg(target_os = "macos")]
    let mut result = scan_macos(
        &request.request_id,
        &path,
        &path_hint,
        captured_at_ms,
        &cancellation,
    )?;
    #[cfg(target_os = "linux")]
    let mut result = scan_linux(
        &request.request_id,
        &path,
        &path_hint,
        captured_at_ms,
        identity,
        &cancellation,
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let mut result = unsupported_result(&request.request_id, &path_hint, captured_at_ms);

    if cancellation.is_cancelled() && result.status == "scoped_complete" {
        result.status = "cancelled".to_owned();
        result.truncated = false;
        result.message =
            Some("文件占用诊断已取消；结果不完整，不能据此判断没有使用者。".to_owned());
        result.processes.clear();
    }

    if read_identity(&path).ok() != Some(identity) {
        result.status = "target_changed".to_owned();
        result.message =
            Some("目标文件在采集期间发生变化；结果只能用于诊断，不能作为安全推出证明。".to_owned());
        result.processes.clear();
    }
    Ok(result)
}

fn validate_request_id(request_id: &str) -> Result<(), CommandError> {
    if request_id.trim().is_empty() || request_id.len() > MAX_REQUEST_ID_BYTES {
        return Err(CommandError::new(
            "invalid_request",
            "占用诊断 requestId 必须非空且不超过 128 字节。",
        ));
    }
    Ok(())
}

fn validate_target(raw_path: &str) -> Result<PathBuf, CommandError> {
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        return Err(CommandError::new(
            "invalid_target",
            "占用诊断只接受用户选择的绝对路径。",
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| path_error("target", error))?;
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
    fs::canonicalize(path).map_err(|error| path_error("target", error))
}

fn read_identity(path: &Path) -> Result<FileIdentity, CommandError> {
    let metadata = fs::metadata(path).map_err(|error| path_error("target", error))?;
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
    #[cfg(unix)]
    let changed_ns = {
        use std::os::unix::fs::MetadataExt;
        i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec())
    };
    #[cfg(not(unix))]
    let changed_ns = 0;
    Ok(FileIdentity {
        device,
        inode,
        length: metadata.len(),
        modified_ns,
        changed_ns,
    })
}

fn path_error(kind: &str, error: io::Error) -> CommandError {
    let (code, label) = match error.kind() {
        io::ErrorKind::NotFound => ("target_not_found", "目标不存在或已离线"),
        io::ErrorKind::PermissionDenied => ("permission_denied", "没有权限读取目标"),
        _ => ("io_error", "读取目标时发生 I/O 错误"),
    };
    CommandError::new(code, format!("{kind}：{label}。"))
}

fn cancelled_result(
    request_id: &str,
    path_hint: &str,
    captured_at_ms: u64,
    message: &str,
) -> OccupancyScanResult {
    OccupancyScanResult {
        request_id: request_id.to_owned(),
        status: "cancelled".to_owned(),
        path_hint: path_hint.to_owned(),
        captured_at_ms,
        processes: Vec::new(),
        coverage: Vec::new(),
        truncated: false,
        message: Some(message.to_owned()),
    }
}

#[cfg(target_os = "macos")]
fn scan_macos(
    request_id: &str,
    path: &Path,
    path_hint: &str,
    captured_at_ms: u64,
    cancellation: &OccupancyCancellation,
) -> Result<OccupancyScanResult, CommandError> {
    let output = run_lsof(path, false, FILE_SCAN_TIMEOUT, cancellation)?;
    if output.cancelled {
        return Ok(cancelled_result(
            request_id,
            path_hint,
            captured_at_ms,
            "文件占用诊断已取消，并已回收 lsof 子进程。",
        ));
    }
    if output.timed_out {
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
    let (processes, parser_truncated) = parse_lsof(&output.stdout);
    let truncated = output.output_truncated || parser_truncated;
    let partial_status = !output.status.success() && output.status.code() != Some(1);
    Ok(OccupancyScanResult {
        request_id: request_id.to_owned(),
        status: if partial_status {
            "partial"
        } else if truncated {
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
        message: if partial_status {
            Some("lsof 未能完整读取系统引用；结果只能用于诊断，请检查权限后重试。".to_owned())
        } else if truncated {
            Some("结果达到采集或展示上限；空结果不代表可以安全推出。".to_owned())
        } else {
            Some("结果仅覆盖本次 lsof 采集范围；空结果不代表可以安全推出。".to_owned())
        },
    })
}

#[cfg(target_os = "macos")]
struct LsofOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    output_truncated: bool,
    timed_out: bool,
    cancelled: bool,
}

#[cfg(target_os = "macos")]
fn run_lsof(
    path: &Path,
    volume: bool,
    timeout: Duration,
    cancellation: &OccupancyCancellation,
) -> Result<LsofOutput, CommandError> {
    let arguments: &[&str] = if volume {
        &["-nP", "-Fpcuf", "+f", "--"]
    } else {
        &["-nP", "-Fpcuf", "--"]
    };
    let mut child = Command::new("/usr/sbin/lsof")
        .args(arguments)
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            CommandError::new("provider_unavailable", format!("无法启动 lsof：{error}"))
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::internal("lsof 输出管道未建立。"))?;
    let reader = std::thread::spawn(move || read_capped(stdout, MAX_COMMAND_OUTPUT));
    let started = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| CommandError::internal(format!("lsof 状态读取失败：{error}")))?
        {
            break status;
        }
        if cancellation.is_cancelled() {
            cancelled = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| CommandError::internal(format!("回收 lsof 失败：{error}")))?;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| CommandError::internal(format!("回收 lsof 失败：{error}")))?;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let (stdout, output_truncated) = reader
        .join()
        .map_err(|_| CommandError::internal("lsof 输出读取线程异常退出。"))?
        .map_err(|error| CommandError::internal(format!("lsof 输出读取失败：{error}")))?;
    Ok(LsofOutput {
        status,
        stdout,
        output_truncated,
        timed_out,
        cancelled,
    })
}

#[cfg(target_os = "macos")]
fn read_capped(mut reader: impl Read, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut captured = Vec::with_capacity(limit.min(64 * 1_024));
    let mut buffer = [0_u8; 8 * 1_024];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let keep = remaining.min(read);
        captured.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((captured, truncated))
}

#[cfg(target_os = "macos")]
fn parse_lsof(bytes: &[u8]) -> (Vec<OccupancyProcess>, bool) {
    let mut processes = Vec::new();
    let mut current: Option<OccupancyProcess> = None;
    let mut truncated = false;
    let mut evidence_count = 0;
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
                evidence_count += 1;
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
                    if evidence_count >= MAX_RESULTS {
                        truncated = true;
                        break;
                    }
                    let evidence = format!("fd:{value}");
                    if !process.evidence_types.contains(&evidence) {
                        process.evidence_types.push(evidence);
                        evidence_count += 1;
                    }
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
        return unsupported_result(request_id, path_hint, captured_at_ms);
    };
    for entry in entries.flatten() {
        if cancellation.is_cancelled() {
            return cancelled_result(
                request_id,
                path_hint,
                captured_at_ms,
                "Linux /proc 占用诊断已取消。",
            );
        }
        if started.elapsed() >= FILE_SCAN_TIMEOUT {
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
        if command.is_none()
            && fs::metadata(process_dir.join("comm"))
                .is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied)
        {
            permission_gap = true;
        }
        let mut evidence_types = Vec::new();
        for (kind, candidate) in [
            ("fd", process_dir.join("fd")),
            ("cwd", process_dir.join("cwd")),
            ("root", process_dir.join("root")),
        ] {
            if cancellation.is_cancelled() {
                return cancelled_result(
                    request_id,
                    path_hint,
                    captured_at_ms,
                    "Linux /proc 占用诊断已取消。",
                );
            }
            let matches = if kind == "fd" {
                let fds = match fs::read_dir(&candidate) {
                    Ok(fds) => fds,
                    Err(error) => {
                        permission_gap |= error.kind() == io::ErrorKind::PermissionDenied;
                        continue;
                    }
                };
                fds.flatten().any(|fd| {
                    references += 1;
                    if references > MAX_REFERENCES {
                        truncated = true;
                        return true;
                    }
                    match fs::metadata(fd.path()) {
                        Ok(metadata) => {
                            metadata.dev() == identity.device && metadata.ino() == identity.inode
                        }
                        Err(error) => {
                            permission_gap |= error.kind() == io::ErrorKind::PermissionDenied;
                            false
                        }
                    }
                })
            } else {
                references += 1;
                match fs::metadata(&candidate) {
                    Ok(metadata) => {
                        metadata.dev() == identity.device && metadata.ino() == identity.inode
                    }
                    Err(error) => {
                        permission_gap |= error.kind() == io::ErrorKind::PermissionDenied;
                        false
                    }
                }
            };
            if matches {
                evidence_types.push(kind.to_owned());
            }
            if truncated {
                break;
            }
        }
        if !truncated
            && !cancellation.is_cancelled()
            && read_proc_maps_matches(
                &process_dir,
                identity,
                &mut references,
                &mut truncated,
                &mut permission_gap,
            )
        {
            evidence_types.push("maps".to_owned());
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
        status: if cancellation.is_cancelled() {
            "cancelled"
        } else if permission_gap {
            "partial"
        } else if truncated {
            "truncated"
        } else {
            "scoped_complete"
        }
        .to_owned(),
        path_hint: path_hint.to_owned(),
        captured_at_ms,
        processes,
        coverage: vec!["Linux /proc fd/cwd/root/maps 身份匹配".to_owned()],
        truncated: truncated || cancellation.is_cancelled(),
        message: Some(if cancellation.is_cancelled() {
            "Linux /proc 占用诊断已取消；结果不完整，不能据此判断没有使用者。".to_owned()
        } else if permission_gap {
            "部分 /proc 引用因权限或进程竞态不可见；空结果不代表没有使用者。".to_owned()
        } else if truncated {
            "结果达到进程、引用或展示上限；空结果不代表没有使用者。".to_owned()
        } else {
            "结果仅覆盖可见 /proc 采集范围；空结果不代表可以安全推出。".to_owned()
        }),
    }
}

#[cfg(target_os = "linux")]
fn read_proc_maps_matches(
    process_dir: &Path,
    identity: FileIdentity,
    references: &mut usize,
    truncated: &mut bool,
    permission_gap: &mut bool,
) -> bool {
    let mut file = match fs::File::open(process_dir.join("maps")) {
        Ok(file) => file,
        Err(error) => {
            *permission_gap |= error.kind() == io::ErrorKind::PermissionDenied;
            return false;
        }
    };
    let mut bytes = Vec::new();
    let read_result = file
        .by_ref()
        .take((MAX_PROC_MAPS_BYTES + 1) as u64)
        .read_to_end(&mut bytes);
    if read_result.is_err() {
        return false;
    }
    if bytes.len() > MAX_PROC_MAPS_BYTES {
        *truncated = true;
        return false;
    }
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Some(path) = line.split_whitespace().nth(5) else {
            continue;
        };
        if !path.starts_with('/') {
            continue;
        }
        *references += 1;
        if *references > MAX_REFERENCES {
            *truncated = true;
            return false;
        }
        if let Ok(metadata) = fs::metadata(path)
            && metadata.dev() == identity.device
            && metadata.ino() == identity.inode
        {
            return true;
        }
    }
    false
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
