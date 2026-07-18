use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, Metadata};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "macos")]
use std::thread;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetCompressedFileSizeW, GetFileInformationByHandle,
};

use crate::error::CommandError;
use crate::models::{
    CleanupApplication, CleanupDeleteExecutionRequest, CleanupDeleteFailure, CleanupDeleteLease,
    CleanupDeleteLeaseRequest, CleanupDeleteMode, CleanupDeleteProgress,
    CleanupDeleteProgressPhase, CleanupDeleteResult, CleanupDeleteSuccess,
    CleanupDeleteTargetEvidence, CleanupFile, CleanupFullDiskAccessStatus, CleanupLocation,
    CleanupNode, CleanupNodeKind, CleanupPathState, CleanupProtectionReason, CleanupSafety,
    CleanupScan, CleanupScanAccess, CleanupScanProgress, CleanupSubtreeRequest,
};
use crate::private_storage;
use crate::safe_fs::{BoundDeleteTarget, DeleteRoot, TreeInspection};

mod paths;

use paths::{LocationDefinition, platform_paths, trash_paths};

#[cfg(test)]
use crate::models::CleanupLocationKind;
#[cfg(test)]
use paths::hidden_user_paths;

#[cfg(not(test))]
const LARGE_FILE_THRESHOLD_BYTES: u64 = 500 * 1_024 * 1_024;
#[cfg(test)]
const LARGE_FILE_THRESHOLD_BYTES: u64 = 512;
const MAX_LARGE_FILES: usize = 12;
const MAX_UNREADABLE_PATHS: usize = 12;
const MAX_CHART_CHILDREN: usize = 24;
const MIN_ALWAYS_VISIBLE_CHILDREN: usize = 8;
const MAX_RESTRICTED_CHILDREN: usize = 4;
const MAX_VISUAL_TREE_DEPTH: usize = 7;
const MAX_VISUAL_NODES_PER_SCAN: usize = 2_500;
const MAX_VISUAL_NODES_PER_LOCATION: usize = 2_500;
const MAX_VISUAL_NODES_PER_SUBTREE: usize = 2_500;
// 0.5 degree of a full circle. Smaller siblings are still fully scanned, but
// are consolidated so the WebView receives a useful hierarchy instead of
// hundreds of thousands of unclickable slivers.
const MIN_CHART_FRACTION_DENOMINATOR: u128 = 720;
const PROGRESS_INTERVAL_ENTRIES: usize = 512;
const CLEANUP_LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_CLEANUP_TARGETS: usize = 32;
const MAX_CLEANUP_LEASES: usize = 8;
const MAX_CLEANUP_SCAN_CACHE_BYTES: u64 = 64 * 1_024 * 1_024;
const CLEANUP_SCAN_CACHE_VERSION: u8 = 6;
#[cfg(target_os = "macos")]
const APPLICATION_CHILD_OUTPUT_LIMIT: usize = 4 * 1_024 * 1_024;
#[cfg(target_os = "macos")]
const APPLICATION_DU_DEADLINE: Duration = Duration::from_secs(30);
#[cfg(target_os = "macos")]
const APPLICATION_MDLS_DEADLINE: Duration = Duration::from_secs(15);
#[cfg(target_os = "macos")]
const APPLICATION_CHILD_POLL_INTERVAL: Duration = Duration::from_millis(25);
static NEXT_CLEANUP_LEASE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupScanCachePayload<'a> {
    version: u8,
    saved_at_ms: u64,
    snapshot: &'a CleanupScan,
}

#[derive(Debug)]
struct CleanupSubtreeOperation {
    request_id: String,
    canonical_path: PathBuf,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
pub struct CleanupWorkCoordinator {
    active_full_scan: Mutex<Option<Arc<AtomicBool>>>,
    active_subtree: Mutex<Option<CleanupSubtreeOperation>>,
    execution: Mutex<()>,
}

impl CleanupWorkCoordinator {
    pub fn begin_full_scan(&self) -> Result<Arc<AtomicBool>, CommandError> {
        let mut active_full_scan = self.active_full_scan.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        if active_full_scan.is_some() {
            return Err(CommandError::new(
                "cleanup_scan_in_progress",
                "A cleanup scan is already in progress.",
            ));
        }
        let active_subtree = self.active_subtree.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        if let Some(operation) = active_subtree.as_ref() {
            operation.cancelled.store(true, Ordering::Relaxed);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active_full_scan = Some(Arc::clone(&cancelled));
        Ok(cancelled)
    }

    pub fn begin_subtree(
        &self,
        request_id: String,
        canonical_path: PathBuf,
    ) -> Result<Arc<AtomicBool>, CommandError> {
        if request_id.trim().is_empty() {
            return Err(CommandError::new(
                "cleanup_subtree_request_invalid",
                "A cleanup subtree request ID is required.",
            ));
        }
        let active_full_scan = self.active_full_scan.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        if active_full_scan.is_some() {
            return Err(CommandError::new(
                "cleanup_scan_in_progress",
                "The full cleanup scan must finish before expanding a folder.",
            ));
        }
        let mut active_subtree = self.active_subtree.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        if let Some(operation) = active_subtree.as_ref() {
            if operation.request_id == request_id && operation.canonical_path == canonical_path {
                return Err(CommandError::new(
                    "cleanup_subtree_duplicate",
                    "This cleanup subtree request is already in progress.",
                ));
            }
            operation.cancelled.store(true, Ordering::Relaxed);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active_subtree = Some(CleanupSubtreeOperation {
            request_id,
            canonical_path,
            cancelled: Arc::clone(&cancelled),
        });
        Ok(cancelled)
    }

    pub fn run_exclusive<T>(
        &self,
        cancelled: &AtomicBool,
        operation: impl FnOnce() -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let _execution = self.execution.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        ensure_scan_active(cancelled)?;
        operation()
    }

    pub fn cancel_full_scan(&self) -> Result<bool, CommandError> {
        let active_full_scan = self.active_full_scan.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        let Some(cancelled) = active_full_scan.as_ref() else {
            return Ok(false);
        };
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    }

    pub fn cancel_subtree(&self, request_id: &str) -> Result<bool, CommandError> {
        let active_subtree = self.active_subtree.lock().map_err(|_| {
            CommandError::internal("The cleanup work coordinator lock was poisoned.")
        })?;
        let Some(operation) = active_subtree.as_ref() else {
            return Ok(false);
        };
        if operation.request_id != request_id {
            return Ok(false);
        }
        operation.cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    }

    pub fn finish_full_scan(&self, cancelled: &Arc<AtomicBool>) {
        if let Ok(mut active_full_scan) = self.active_full_scan.lock()
            && active_full_scan
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, cancelled))
        {
            *active_full_scan = None;
        }
    }

    pub fn finish_subtree(&self, cancelled: &Arc<AtomicBool>) {
        if let Ok(mut active_subtree) = self.active_subtree.lock()
            && active_subtree
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.cancelled, cancelled))
        {
            *active_subtree = None;
        }
    }
}

#[derive(Debug, Default)]
pub struct CleanupDeleteController {
    leases: Vec<CleanupDeleteLeaseEntry>,
}

#[derive(Debug, Default)]
pub struct CleanupDeleteCoordinator {
    active: Mutex<Option<Arc<AtomicBool>>>,
}

impl CleanupDeleteCoordinator {
    pub fn begin(&self) -> Result<Arc<AtomicBool>, CommandError> {
        let mut active = self.active.lock().map_err(|_| {
            CommandError::internal("The cleanup delete coordinator lock was poisoned.")
        })?;
        if active.is_some() {
            return Err(CommandError::new(
                "cleanup_delete_in_progress",
                "A cleanup operation is already in progress.",
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancelled));
        Ok(cancelled)
    }

    pub fn cancel(&self) -> Result<bool, CommandError> {
        let active = self.active.lock().map_err(|_| {
            CommandError::internal("The cleanup delete coordinator lock was poisoned.")
        })?;
        let Some(cancelled) = active.as_ref() else {
            return Ok(false);
        };
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    }

    pub fn finish(&self, cancelled: &Arc<AtomicBool>) {
        if let Ok(mut active) = self.active.lock()
            && active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, cancelled))
        {
            *active = None;
        }
    }
}

#[derive(Clone, Debug)]
struct CleanupDeleteTarget {
    display_path: String,
    canonical_path: PathBuf,
    modified_at_ms: Option<u64>,
    inspection: TreeInspection,
    bound: BoundDeleteTarget,
}

#[derive(Debug)]
struct CleanupDeleteLeaseEntry {
    id: String,
    expires_at: Instant,
    mode: CleanupDeleteMode,
    trash_root: Option<DeleteRoot>,
    targets: Vec<CleanupDeleteTarget>,
}

#[derive(Debug)]
struct CleanupDeleteExecution {
    mode: CleanupDeleteMode,
    trash_root: Option<DeleteRoot>,
    targets: Vec<CleanupDeleteTarget>,
}

impl CleanupDeleteController {
    pub fn create_lease(
        &mut self,
        request: CleanupDeleteLeaseRequest,
    ) -> Result<CleanupDeleteLease, CommandError> {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })?;
        self.create_lease_for_home(request, &home)
    }

    pub fn release_lease(&mut self, lease_id: &str) {
        if let Some(position) = self.leases.iter().position(|lease| lease.id == lease_id) {
            self.leases.remove(position);
        }
    }

    #[cfg(test)]
    pub fn execute(
        &mut self,
        request: CleanupDeleteExecutionRequest,
    ) -> Result<CleanupDeleteResult, CommandError> {
        let cancelled = AtomicBool::new(false);
        self.execute_cancellable(request, &cancelled, &mut |_| {})
    }

    pub fn execute_cancellable(
        &mut self,
        request: CleanupDeleteExecutionRequest,
        cancelled: &AtomicBool,
        on_progress: &mut dyn FnMut(CleanupDeleteProgress),
    ) -> Result<CleanupDeleteResult, CommandError> {
        let execution = self.take_validated_targets(request)?;
        let mode = execution.mode;
        let trash_root = execution.trash_root;
        let targets = execution.targets;
        let total_target_count = targets.len();
        // Deletion deliberately uses indeterminate progress. A complete pre-scan
        // doubles metadata I/O and widens the race window between validation and
        // removal without making the operation atomic.
        let total_entry_count = 0;
        let mut deleted = Vec::new();
        let mut deleted_bytes = 0_u64;
        let mut failed = Vec::new();
        let mut processed_entry_count = 0_usize;
        let mut last_emitted_entry_count = 0_usize;
        let mut last_emitted_at = Instant::now();

        for (target_index, target) in targets.into_iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(cancelled_delete_result(
                    deleted,
                    deleted_bytes,
                    failed,
                    None,
                ));
            }
            let current_path = target.display_path.clone();
            on_progress(CleanupDeleteProgress {
                phase: cleanup_progress_phase(mode),
                processed_entry_count,
                total_entry_count,
                completed_target_count: target_index,
                total_target_count,
                current_path: current_path.clone(),
                deleted_bytes,
            });
            let mut target_deleted_bytes = 0_u64;
            let result = if mode == CleanupDeleteMode::Trash {
                let trash_root = trash_root.as_ref().ok_or_else(|| {
                    CommandError::internal("The cleanup Trash handle was not retained.")
                })?;
                move_cleanup_target_to_trash(&target, trash_root).map(|bytes| {
                    target_deleted_bytes = bytes;
                    deleted_bytes = deleted_bytes.saturating_add(bytes);
                    processed_entry_count = processed_entry_count.saturating_add(1);
                    true
                })
            } else {
                target
                    .bound
                    .delete_cancellable(cancelled, &mut |entry_deleted_bytes| {
                        processed_entry_count = processed_entry_count.saturating_add(1);
                        target_deleted_bytes =
                            target_deleted_bytes.saturating_add(entry_deleted_bytes);
                        deleted_bytes = deleted_bytes.saturating_add(entry_deleted_bytes);
                        if processed_entry_count.saturating_sub(last_emitted_entry_count) >= 128
                            || last_emitted_at.elapsed() >= Duration::from_millis(100)
                        {
                            on_progress(CleanupDeleteProgress {
                                phase: cleanup_progress_phase(mode),
                                processed_entry_count,
                                total_entry_count,
                                completed_target_count: target_index,
                                total_target_count,
                                current_path: current_path.clone(),
                                deleted_bytes,
                            });
                            last_emitted_entry_count = processed_entry_count;
                            last_emitted_at = Instant::now();
                        }
                    })
            };
            match result {
                Ok(true) => {
                    deleted.push(CleanupDeleteSuccess {
                        path: target.display_path,
                        deleted_bytes: target_deleted_bytes,
                    });
                }
                Ok(false) => {
                    return Ok(cancelled_delete_result(
                        deleted,
                        deleted_bytes,
                        failed,
                        Some(target.display_path),
                    ));
                }
                Err(message) => failed.push(CleanupDeleteFailure {
                    path: target.display_path,
                    message,
                }),
            }
            on_progress(CleanupDeleteProgress {
                phase: cleanup_progress_phase(mode),
                processed_entry_count,
                total_entry_count,
                completed_target_count: target_index + 1,
                total_target_count,
                current_path,
                deleted_bytes,
            });
        }
        Ok(CleanupDeleteResult {
            deleted,
            deleted_bytes,
            failed,
            cancelled: false,
            interrupted_path: None,
        })
    }

    fn create_lease_for_home(
        &mut self,
        request: CleanupDeleteLeaseRequest,
        home: &Path,
    ) -> Result<CleanupDeleteLease, CommandError> {
        let now = Instant::now();
        self.leases.retain(|lease| lease.expires_at > now);
        if self.leases.len() >= MAX_CLEANUP_LEASES {
            return Err(CommandError::new(
                "cleanup_confirmation_limit",
                "Too many cleanup confirmations are open. Close one and try again.",
            ));
        }
        let targets = validate_cleanup_targets(&request, home)?;
        if request.expected_targets.len() != targets.len() {
            return Err(CommandError::new(
                "invalid_cleanup_selection",
                "Every cleanup path must include the size and item count currently shown for confirmation.",
            ));
        }
        let trash_root = if request.mode == CleanupDeleteMode::Trash {
            Some(prepare_cleanup_trash_root(home)?)
        } else {
            None
        };
        let refreshed_targets = targets
            .iter()
            .map(cleanup_target_evidence)
            .collect::<Vec<_>>();
        let changed_paths = targets
            .iter()
            .zip(&refreshed_targets)
            .filter(|(target, refreshed)| {
                let expected = request
                    .expected_targets
                    .iter()
                    .find(|expected| expected.path == target.display_path);
                expected != Some(*refreshed)
                    || target
                        .modified_at_ms
                        .is_some_and(|modified| modified > request.scan_sampled_at_ms)
            })
            .map(|(target, _)| target.display_path.clone())
            .collect::<Vec<_>>();
        let id = next_cleanup_lease_id();
        let expires_at = now + CLEANUP_LEASE_TTL;
        let executable = changed_paths.is_empty();
        if executable {
            self.leases.push(CleanupDeleteLeaseEntry {
                id: id.clone(),
                expires_at,
                mode: request.mode,
                trash_root,
                targets: targets.clone(),
            });
        }
        let refreshed_at_ms = now_millis();
        Ok(CleanupDeleteLease {
            id,
            mode: request.mode,
            paths: targets
                .iter()
                .map(|target| target.display_path.clone())
                .collect(),
            changed_paths,
            refreshed_targets,
            executable,
            refreshed_at_ms,
            expires_at_ms: now_millis().saturating_add(CLEANUP_LEASE_TTL.as_millis() as u64),
        })
    }

    #[cfg(test)]
    fn execute_with<F>(
        &mut self,
        request: CleanupDeleteExecutionRequest,
        mut delete_target: F,
    ) -> Result<CleanupDeleteResult, CommandError>
    where
        F: FnMut(&Path) -> Result<u64, String>,
    {
        let execution = self.take_validated_targets(request)?;
        let mut deleted = Vec::new();
        let mut deleted_bytes = 0_u64;
        let mut failed = Vec::new();
        for target in execution.targets {
            match delete_target(&target.canonical_path) {
                Ok(bytes) => {
                    deleted.push(CleanupDeleteSuccess {
                        path: target.display_path,
                        deleted_bytes: bytes,
                    });
                    deleted_bytes = deleted_bytes.saturating_add(bytes);
                }
                Err(message) => failed.push(CleanupDeleteFailure {
                    path: target.display_path,
                    message,
                }),
            }
        }
        Ok(CleanupDeleteResult {
            deleted,
            deleted_bytes,
            failed,
            cancelled: false,
            interrupted_path: None,
        })
    }

    fn take_validated_targets(
        &mut self,
        request: CleanupDeleteExecutionRequest,
    ) -> Result<CleanupDeleteExecution, CommandError> {
        let position = self
            .leases
            .iter()
            .position(|lease| lease.id == request.lease_id)
            .ok_or_else(|| {
                CommandError::new(
                    "cleanup_confirmation_unavailable",
                    "This cleanup confirmation was already used, cancelled, or expired.",
                )
            })?;
        // Consume first so every execution attempt is single-use, including failures.
        let lease = self.leases.remove(position);
        if lease.expires_at <= Instant::now() {
            return Err(CommandError::new(
                "cleanup_confirmation_expired",
                "This cleanup confirmation expired. Review the current files and confirm again.",
            ));
        }
        for target in &lease.targets {
            revalidate_cleanup_target(target)?;
        }
        Ok(CleanupDeleteExecution {
            mode: lease.mode,
            trash_root: lease.trash_root,
            targets: lease.targets,
        })
    }
}

fn cleanup_progress_phase(mode: CleanupDeleteMode) -> CleanupDeleteProgressPhase {
    match mode {
        CleanupDeleteMode::Trash => CleanupDeleteProgressPhase::MovingToTrash,
        CleanupDeleteMode::Permanent => CleanupDeleteProgressPhase::Deleting,
    }
}

fn prepare_cleanup_trash_root(home: &Path) -> Result<DeleteRoot, CommandError> {
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_trash_unavailable",
            format!("CoreRobin could not verify the home directory before opening Trash: {error}"),
        )
    })?;
    let trash_path = trash_paths(&canonical_home)
        .into_iter()
        .next()
        .ok_or_else(|| {
            CommandError::new(
                "cleanup_trash_unavailable",
                "Moving cleanup items to the system Trash is not supported on this platform.",
            )
        })?;
    let relative_trash_path = trash_path.strip_prefix(&canonical_home).map_err(|_| {
        CommandError::new(
            "cleanup_trash_unavailable",
            "The system Trash folder is outside the verified home directory.",
        )
    })?;
    let home_root = DeleteRoot::open(&canonical_home).map_err(|error| {
        CommandError::new(
            "cleanup_trash_unavailable",
            format!("CoreRobin could not retain a stable home directory handle: {error}"),
        )
    })?;
    home_root
        .open_subdirectory(relative_trash_path, true, true)
        .map_err(|error| {
            CommandError::new(
                "cleanup_trash_unavailable",
                format!("CoreRobin could not open a stable system Trash handle: {error}"),
            )
        })
}

fn move_cleanup_target_to_trash(
    target: &CleanupDeleteTarget,
    trash_root: &DeleteRoot,
) -> Result<u64, String> {
    let original_name = target.canonical_path.file_name().ok_or_else(|| {
        format!(
            "CoreRobin could not derive a Trash name for {}.",
            target.display_path
        )
    })?;
    for suffix in 0..10_000_u32 {
        let candidate = cleanup_trash_destination_name(original_name, suffix);
        match target
            .bound
            .move_to_directory_noreplace(trash_root, &candidate)
        {
            Ok(()) => return Ok(target.inspection.allocated_size_bytes),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not move {} to the system Trash: {error}",
                    target.display_path
                ));
            }
        }
    }
    Err(format!(
        "Could not find an unused Trash name for {}.",
        target.display_path
    ))
}

fn cleanup_trash_destination_name(original: &std::ffi::OsStr, suffix: u32) -> std::ffi::OsString {
    if suffix == 0 {
        return original.to_os_string();
    }
    let path = Path::new(original);
    let stem = path.file_stem().unwrap_or(original).to_string_lossy();
    match path.extension() {
        Some(extension) => format!("{stem} ({suffix}).{}", extension.to_string_lossy()).into(),
        None => format!("{stem} ({suffix})").into(),
    }
}

fn cancelled_delete_result(
    deleted: Vec<CleanupDeleteSuccess>,
    deleted_bytes: u64,
    failed: Vec<CleanupDeleteFailure>,
    interrupted_path: Option<String>,
) -> CleanupDeleteResult {
    CleanupDeleteResult {
        deleted,
        deleted_bytes,
        failed,
        cancelled: true,
        interrupted_path,
    }
}

pub fn scan_cleanup(
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    let scan_root = system_disk_root(&home).ok_or_else(|| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            "CoreRobin could not locate the system disk root.",
        )
    })?;
    scan_filesystem(
        &scan_root,
        &home,
        platform_paths(&home),
        true,
        cancelled,
        on_progress,
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupBenchmarkResult {
    pub root: String,
    pub duration_ms: u64,
    pub cpu_user_ms: Option<u64>,
    pub cpu_system_ms: Option<u64>,
    pub peak_rss_bytes: Option<u64>,
    pub read_bytes: Option<u64>,
    pub scanned_entry_count: usize,
    pub unreadable_entry_count: usize,
    pub discovered_allocated_bytes: u64,
}

pub fn benchmark_cleanup_root(root: &Path) -> Result<CleanupBenchmarkResult, String> {
    benchmark_cleanup_root_with_cancel(root, &AtomicBool::new(false))
}

pub fn benchmark_cleanup_root_with_cancel(
    root: &Path,
    cancelled: &AtomicBool,
) -> Result<CleanupBenchmarkResult, String> {
    let canonical_root = root.canonicalize().map_err(|error| {
        format!(
            "Could not verify benchmark root {}: {error}",
            root.display()
        )
    })?;
    if !canonical_root.is_dir() {
        return Err(format!(
            "Benchmark root is not a directory: {}",
            canonical_root.display()
        ));
    }
    let resources_before = benchmark_resource_snapshot();
    let started_at = Instant::now();
    let mut latest_progress = CleanupScanProgress {
        scanned_entry_count: 0,
        discovered_bytes: 0,
        current_path: canonical_root.to_string_lossy().into_owned(),
        elapsed_ms: 0,
    };
    let scan = scan_filesystem(
        &canonical_root,
        &canonical_root,
        Vec::new(),
        false,
        cancelled,
        &mut |progress| latest_progress = progress,
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let resources_after = benchmark_resource_snapshot();
    Ok(CleanupBenchmarkResult {
        root: canonical_root.to_string_lossy().into_owned(),
        duration_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        cpu_user_ms: resource_delta_millis(
            resources_before.user_time_ns,
            resources_after.user_time_ns,
        ),
        cpu_system_ms: resource_delta_millis(
            resources_before.system_time_ns,
            resources_after.system_time_ns,
        ),
        peak_rss_bytes: resources_after.peak_rss_bytes,
        read_bytes: resource_delta(resources_before.read_bytes, resources_after.read_bytes),
        scanned_entry_count: scan.scanned_entry_count,
        unreadable_entry_count: scan.unreadable_entry_count,
        discovered_allocated_bytes: latest_progress.discovered_bytes,
    })
}

#[derive(Clone, Copy, Debug, Default)]
struct BenchmarkResourceSnapshot {
    user_time_ns: Option<u64>,
    system_time_ns: Option<u64>,
    peak_rss_bytes: Option<u64>,
    read_bytes: Option<u64>,
}

fn resource_delta(before: Option<u64>, after: Option<u64>) -> Option<u64> {
    Some(after?.saturating_sub(before?))
}

fn resource_delta_millis(before: Option<u64>, after: Option<u64>) -> Option<u64> {
    resource_delta(before, after).map(|nanoseconds| nanoseconds / 1_000_000)
}

#[cfg(target_os = "macos")]
fn benchmark_resource_snapshot() -> BenchmarkResourceSnapshot {
    use std::mem::MaybeUninit;

    let mut process_usage = MaybeUninit::<libc::rusage_info_v2>::uninit();
    let process_usage_available = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V2,
            process_usage.as_mut_ptr().cast(),
        ) == 0
    };
    let process_usage = process_usage_available.then(|| unsafe { process_usage.assume_init() });

    let mut general_usage = MaybeUninit::<libc::rusage>::uninit();
    let general_usage_available =
        unsafe { libc::getrusage(libc::RUSAGE_SELF, general_usage.as_mut_ptr()) == 0 };
    let general_usage = general_usage_available.then(|| unsafe { general_usage.assume_init() });
    let timeval_nanoseconds = |value: libc::timeval| {
        (value.tv_sec.max(0) as u64)
            .saturating_mul(1_000_000_000)
            .saturating_add((value.tv_usec.max(0) as u64).saturating_mul(1_000))
    };

    BenchmarkResourceSnapshot {
        user_time_ns: general_usage
            .as_ref()
            .map(|usage| timeval_nanoseconds(usage.ru_utime)),
        system_time_ns: general_usage
            .as_ref()
            .map(|usage| timeval_nanoseconds(usage.ru_stime)),
        peak_rss_bytes: general_usage.map(|usage| usage.ru_maxrss.max(0) as u64),
        read_bytes: process_usage.map(|usage| usage.ri_diskio_bytesread),
    }
}

#[cfg(not(target_os = "macos"))]
fn benchmark_resource_snapshot() -> BenchmarkResourceSnapshot {
    BenchmarkResourceSnapshot::default()
}

pub fn canonical_cleanup_subtree_path(path: &str) -> Result<PathBuf, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    expand_cleanup_path(path, &home)?
        .canonicalize()
        .map_err(|error| {
            CommandError::new(
                "cleanup_subtree_unavailable",
                format!("CoreRobin could not verify {path}: {error}"),
            )
        })
}

pub fn scan_cleanup_subtree(
    request: CleanupSubtreeRequest,
    cancelled: &AtomicBool,
) -> Result<CleanupNode, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    let scan_root = system_disk_root(&home).ok_or_else(|| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            "CoreRobin could not locate the system disk root.",
        )
    })?;
    scan_cleanup_subtree_at(request, &home, &scan_root, cancelled)
}

fn scan_cleanup_subtree_at(
    request: CleanupSubtreeRequest,
    home: &Path,
    scan_root: &Path,
    cancelled: &AtomicBool,
) -> Result<CleanupNode, CommandError> {
    ensure_scan_active(cancelled)?;
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not verify the home directory: {error}"),
        )
    })?;
    let canonical_scan_root = scan_root.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not verify the system disk root: {error}"),
        )
    })?;
    let boundary = ScanFilesystemBoundary::for_root(&canonical_scan_root)?;
    let requested_path = expand_cleanup_path(&request.path, &canonical_home)?;
    let metadata = fs::symlink_metadata(&requested_path).map_err(|error| {
        CommandError::new(
            "cleanup_subtree_unavailable",
            format!("CoreRobin could not inspect {}: {error}", request.path),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CommandError::new(
            "cleanup_subtree_unavailable",
            "Only a real directory can be expanded in the space map.",
        ));
    }
    let path = requested_path.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_subtree_unavailable",
            format!("CoreRobin could not verify {}: {error}", request.path),
        )
    })?;
    if !path.starts_with(&canonical_scan_root) {
        return Err(CommandError::new(
            "cleanup_subtree_outside_disk",
            "CoreRobin only expands folders on the system disk.",
        ));
    }
    if !boundary.allows_directory(&metadata) {
        return Err(CommandError::new(
            "cleanup_subtree_outside_disk",
            "CoreRobin does not expand another disk or mounted filesystem from this map.",
        ));
    }

    let mut stats = ScanStats::new();
    let mut largest_files = Vec::new();
    let mut application_sizes = HashMap::new();
    let definitions = Vec::new();
    let mut location_summaries = Vec::new();
    let mut ignore_progress = |_progress: CleanupScanProgress| {};
    let mut context = ScanContext {
        stats: &mut stats,
        largest_files: &mut largest_files,
        home: &canonical_home,
        scan_root: &canonical_scan_root,
        boundary,
        definitions: &definitions,
        location_summaries: &mut location_summaries,
        application_sizes: &mut application_sizes,
        cancelled,
        on_progress: &mut ignore_progress,
    };
    let mut seen_files = HashSet::new();
    let subtree_safety = if path.starts_with(&canonical_home) {
        request.safety
    } else {
        CleanupSafety::Review
    };
    let mut node = scan_path(
        &path,
        false,
        false,
        subtree_safety,
        &mut context,
        &mut seen_files,
        MAX_VISUAL_TREE_DEPTH,
    )?;
    let mut remaining = MAX_VISUAL_NODES_PER_SUBTREE;
    prune_cleanup_node(&mut node, &mut remaining);
    Ok(node)
}

pub fn cleanup_scan_access() -> CleanupScanAccess {
    #[cfg(target_os = "macos")]
    {
        let application_bundle = current_application_bundle();
        let full_disk_access =
            match fs::File::open("/Library/Application Support/com.apple.TCC/TCC.db") {
                Ok(_) => CleanupFullDiskAccessStatus::Granted,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    CleanupFullDiskAccessStatus::NotGranted
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    CleanupFullDiskAccessStatus::Unknown
                }
                Err(_) => CleanupFullDiskAccessStatus::Unknown,
            };
        CleanupScanAccess {
            full_disk_access,
            full_disk_access_recommended: true,
            application_bundle_available: application_bundle.is_some(),
            application_bundle_path: application_bundle
                .map(|path| path.to_string_lossy().into_owned()),
        }
    }

    #[cfg(not(target_os = "macos"))]
    CleanupScanAccess {
        full_disk_access: CleanupFullDiskAccessStatus::NotRequired,
        full_disk_access_recommended: false,
        application_bundle_available: false,
        application_bundle_path: None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn application_bundle_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn current_application_bundle() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    application_bundle_from_executable(&executable)
}

pub fn open_full_disk_access_settings() -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .status()
            .map_err(|error| {
                CommandError::internal(format!(
                    "CoreRobin could not open Full Disk Access settings: {error}"
                ))
            })?;
        if status.success() {
            return Ok(());
        }
        Err(CommandError::internal(
            "macOS did not open Full Disk Access settings.",
        ))
    }

    #[cfg(not(target_os = "macos"))]
    Err(CommandError::new(
        "full_disk_access_not_required",
        "This platform does not use the macOS Full Disk Access setting.",
    ))
}

pub fn reveal_cleanup_application_bundle() -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        let application_bundle = current_application_bundle().ok_or_else(|| {
            CommandError::new(
                "cleanup_application_bundle_unavailable",
                "CoreRobin must be launched from its application bundle before it can be added to Full Disk Access.",
            )
        })?;
        let status = Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&application_bundle)
            .status()
            .map_err(|error| {
                CommandError::internal(format!(
                    "CoreRobin could not reveal its application bundle: {error}"
                ))
            })?;
        if status.success() {
            return Ok(());
        }
        Err(CommandError::internal(
            "macOS did not reveal the CoreRobin application bundle.",
        ))
    }

    #[cfg(not(target_os = "macos"))]
    Err(CommandError::new(
        "cleanup_application_bundle_unavailable",
        "This platform does not use a macOS application bundle.",
    ))
}

pub fn inspect_cleanup_path(display_path: &str) -> Result<CleanupPathState, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    let path = if display_path == "~" {
        home
    } else if let Some(relative) = display_path.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(display_path)
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CleanupPathState {
                path: display_path.to_owned(),
                exists: false,
                modified_at_ms: None,
            });
        }
        Err(_) => {
            return Ok(CleanupPathState {
                path: display_path.to_owned(),
                exists: false,
                modified_at_ms: None,
            });
        }
    };
    Ok(CleanupPathState {
        path: display_path.to_owned(),
        exists: true,
        modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
    })
}

pub fn load_cleanup_scan_cache(path: &Path) -> Result<Option<String>, CommandError> {
    let bytes = match private_storage::read_limited(path, MAX_CLEANUP_SCAN_CACHE_BYTES) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    Ok(String::from_utf8(bytes).ok())
}

pub fn save_cleanup_scan_cache(path: &Path, serialized: &str) -> Result<(), CommandError> {
    if u64::try_from(serialized.len()).unwrap_or(u64::MAX) > MAX_CLEANUP_SCAN_CACHE_BYTES {
        return Err(CommandError::new(
            "cleanup_scan_cache_too_large",
            "The cleanup scan cache is too large to retain safely.",
        ));
    }
    private_storage::write_atomic(path, serialized.as_bytes()).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely update the cleanup scan cache: {error}"
        ))
    })
}

pub fn save_cleanup_scan_snapshot_cache(
    path: &Path,
    snapshot: &CleanupScan,
) -> Result<(), CommandError> {
    save_cleanup_scan_snapshot_cache_at(path, snapshot, now_millis())
}

pub fn save_cleanup_scan_snapshot_cache_at(
    path: &Path,
    snapshot: &CleanupScan,
    saved_at_ms: u64,
) -> Result<(), CommandError> {
    let serialized = serde_json::to_string(&CleanupScanCachePayload {
        version: CLEANUP_SCAN_CACHE_VERSION,
        saved_at_ms,
        snapshot,
    })
    .map_err(|error| {
        CommandError::internal(format!("Could not encode the cleanup scan cache: {error}"))
    })?;
    save_cleanup_scan_cache(path, &serialized)
}

pub fn remove_cleanup_scan_cache(path: &Path) -> Result<(), CommandError> {
    private_storage::remove(path).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely clear the cleanup scan cache: {error}"
        ))
    })
}

fn validate_cleanup_targets(
    request: &CleanupDeleteLeaseRequest,
    home: &Path,
) -> Result<Vec<CleanupDeleteTarget>, CommandError> {
    if request.paths.is_empty() || request.paths.len() > MAX_CLEANUP_TARGETS {
        return Err(CommandError::new(
            "invalid_cleanup_selection",
            format!("Choose between 1 and {MAX_CLEANUP_TARGETS} cleanup items before continuing."),
        ));
    }
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not verify the home directory: {error}"),
        )
    })?;
    let delete_root = DeleteRoot::open(&canonical_home).map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not open a stable home directory handle: {error}"),
        )
    })?;
    let trash_roots = trash_paths(&canonical_home);
    let mut seen = HashSet::new();
    let mut targets = Vec::with_capacity(request.paths.len());
    for display in &request.paths {
        let path = expand_cleanup_path(display, &canonical_home)?;
        let relative_path = path
            .strip_prefix(home)
            .or_else(|_| path.strip_prefix(&canonical_home))
            .map_err(|_| {
                CommandError::new(
                    "cleanup_target_outside_home",
                    format!("CoreRobin only deletes items inside your home folder: {display}"),
                )
            })?;
        let canonical_path = canonical_home.join(relative_path);
        if cleanup_protection_for_path(&canonical_path, &canonical_home).is_some() {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "CoreRobin will not delete system-managed locations, sensitive user data, the home directory, or the system Trash folder itself.",
            ));
        }
        if request.mode == CleanupDeleteMode::Trash
            && trash_roots.iter().any(|trash_root| {
                canonical_path.starts_with(trash_root) || trash_root.starts_with(&canonical_path)
            })
        {
            return Err(CommandError::new(
                "cleanup_target_conflicts_with_trash",
                "Items that contain or are already inside the system Trash can only be deleted permanently.",
            ));
        }
        let bound = delete_root.bind(relative_path).map_err(|error| {
            let message = error.to_string();
            let code = if message.contains("volume") {
                "cleanup_cross_filesystem"
            } else if message.contains("symbolic") || message.contains("special") {
                "unsupported_cleanup_target"
            } else {
                "cleanup_target_unavailable"
            };
            CommandError::new(
                code,
                format!("CoreRobin could not safely bind {display}: {error}"),
            )
        })?;
        if !canonical_path.starts_with(&canonical_home) {
            return Err(CommandError::new(
                "cleanup_target_outside_home",
                format!("CoreRobin only deletes items inside your home folder: {display}"),
            ));
        }
        if !seen.insert(canonical_path.clone()) {
            return Err(CommandError::new(
                "duplicate_cleanup_target",
                format!("The cleanup selection contains the same item more than once: {display}"),
            ));
        }
        let inspection = bound.inspect().map_err(|message| {
            CommandError::new(
                "cleanup_target_unavailable",
                format!("CoreRobin could not refresh {display} before confirmation: {message}"),
            )
        })?;
        targets.push(CleanupDeleteTarget {
            display_path: display.clone(),
            canonical_path,
            modified_at_ms: bound.modified_at().and_then(system_time_millis),
            inspection,
            bound,
        });
    }
    for left in 0..targets.len() {
        for right in (left + 1)..targets.len() {
            let left_path = &targets[left].canonical_path;
            let right_path = &targets[right].canonical_path;
            if left_path.starts_with(right_path) || right_path.starts_with(left_path) {
                return Err(CommandError::new(
                    "overlapping_cleanup_targets",
                    "Choose either a folder or its contents, not both.",
                ));
            }
        }
    }
    Ok(targets)
}

fn cleanup_protection_for_path(path: &Path, home: &Path) -> Option<CleanupProtectionReason> {
    if !path.starts_with(home) {
        return Some(CleanupProtectionReason::SystemLocation);
    }
    if path == home {
        return Some(CleanupProtectionReason::HomeRoot);
    }

    let trash_roots = trash_paths(home);
    if trash_roots.iter().any(|trash_root| path == trash_root) {
        return Some(CleanupProtectionReason::TrashRoot);
    }
    if trash_roots
        .iter()
        .any(|trash_root| path.starts_with(trash_root))
    {
        return None;
    }

    let relative = path.strip_prefix(home).ok()?;
    is_sensitive_cleanup_relative_path(relative)
        .then_some(CleanupProtectionReason::SensitiveUserData)
}

fn is_sensitive_cleanup_relative_path(relative: &Path) -> bool {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                let Some(value) = value.to_str() else {
                    return true;
                };
                parts.push(value);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return true,
        }
    }
    let Some(first) = parts.first() else {
        return true;
    };

    const REGENERATABLE_ROOTS: &[&[&str]] = &[
        &[".cache"],
        &[".pnpm-store"],
        &[".cargo", "registry"],
        &[".cargo", "git"],
        &[".npm", "_cacache"],
        &[".yarn", "berry", "cache"],
        &[".gradle", "caches"],
        &[".m2", "repository"],
        &[".bun", "install", "cache"],
        &[".rustup", "downloads"],
        &[".rustup", "tmp"],
        &[".local", "share", "pnpm", "store"],
        &["Library", "Caches"],
        &["Library", "Developer", "Xcode", "DerivedData"],
        &["Library", "pnpm", "store"],
        &["AppData", "Local", "Temp"],
        &["AppData", "Local", "pnpm", "store"],
    ];
    if REGENERATABLE_ROOTS
        .iter()
        .any(|prefix| cleanup_components_start_with(&parts, prefix))
    {
        return false;
    }

    first.starts_with('.')
        || ["Library", "AppData", "Applications", "System"]
            .iter()
            .any(|candidate| cleanup_component_matches(first, candidate))
        || [
            "NTUSER.DAT",
            "NTUSER.DAT.LOG1",
            "NTUSER.DAT.LOG2",
            "ntuser.ini",
        ]
        .iter()
        .any(|candidate| cleanup_component_matches(first, candidate))
}

fn cleanup_components_start_with(parts: &[&str], prefix: &[&str]) -> bool {
    parts.len() >= prefix.len()
        && parts
            .iter()
            .zip(prefix)
            .all(|(part, candidate)| cleanup_component_matches(part, candidate))
}

fn cleanup_component_matches(value: &str, candidate: &str) -> bool {
    if cfg!(windows) {
        value.eq_ignore_ascii_case(candidate)
    } else {
        value == candidate
    }
}

fn expand_cleanup_path(display_path: &str, home: &Path) -> Result<PathBuf, CommandError> {
    if display_path.is_empty() {
        return Err(CommandError::new(
            "invalid_cleanup_path",
            "An empty cleanup path is not allowed.",
        ));
    }
    if display_path == "~" {
        return Ok(home.to_path_buf());
    }
    if let Some(relative) = display_path.strip_prefix("~/") {
        return Ok(home.join(relative));
    }
    let path = PathBuf::from(display_path);
    if !path.is_absolute() {
        return Err(CommandError::new(
            "invalid_cleanup_path",
            format!("CoreRobin could not resolve this cleanup path: {display_path}"),
        ));
    }
    Ok(path)
}

fn revalidate_cleanup_target(target: &CleanupDeleteTarget) -> Result<(), CommandError> {
    let modified_at_ms = target
        .bound
        .current_modified_at()
        .map_err(|error| {
        CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; CoreRobin deleted nothing. Review the selection again: {error}",
                target.display_path
            ),
        )
    })?
        .and_then(system_time_millis);
    if modified_at_ms != target.modified_at_ms {
        return Err(CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; CoreRobin deleted nothing. Review the selection again.",
                target.display_path
            ),
        ));
    }
    let inspection = target.bound.inspect().map_err(|message| {
        CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; CoreRobin deleted nothing. Review the refreshed selection again: {message}",
                target.display_path
            ),
        )
    })?;
    if inspection != target.inspection {
        return Err(CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; CoreRobin deleted nothing. Review the refreshed selection again.",
                target.display_path
            ),
        ));
    }
    Ok(())
}

fn cleanup_target_evidence(target: &CleanupDeleteTarget) -> CleanupDeleteTargetEvidence {
    CleanupDeleteTargetEvidence {
        path: target.display_path.clone(),
        logical_size_bytes: target.inspection.logical_size_bytes,
        allocated_size_bytes: target.inspection.allocated_size_bytes,
        item_count: target.inspection.item_count,
    }
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[derive(Debug)]
struct ScanStats {
    started: Instant,
    scanned_entry_count: usize,
    discovered_bytes: u64,
    unreadable_entry_count: usize,
    unreadable_paths: Vec<PathBuf>,
    last_reported_entry_count: usize,
}

#[derive(Default)]
struct LocationSummary {
    size_bytes: u64,
    item_count: usize,
    available: bool,
    nodes: Vec<CleanupNode>,
}

#[derive(Default)]
struct ChildAccumulator {
    candidates: Vec<CleanupNode>,
    restricted: Vec<CleanupNode>,
    total_logical_size_bytes: u64,
    total_allocated_size_bytes: u64,
    total_item_count: usize,
    omitted_logical_size_bytes: u64,
    omitted_allocated_size_bytes: u64,
    omitted_item_count: usize,
    omitted_restricted_count: usize,
    has_children: bool,
}

struct ScanContext<'a> {
    stats: &'a mut ScanStats,
    largest_files: &'a mut Vec<CleanupFile>,
    home: &'a Path,
    scan_root: &'a Path,
    boundary: ScanFilesystemBoundary,
    definitions: &'a [LocationDefinition],
    location_summaries: &'a mut [LocationSummary],
    application_sizes: &'a mut HashMap<PathBuf, u64>,
    cancelled: &'a AtomicBool,
    on_progress: &'a mut dyn FnMut(CleanupScanProgress),
}

#[derive(Clone, Copy, Debug)]
struct ScanFilesystemBoundary {
    #[cfg(unix)]
    device: u64,
}

impl ScanFilesystemBoundary {
    fn for_root(root: &Path) -> Result<Self, CommandError> {
        let metadata = fs::metadata(root).map_err(|error| {
            CommandError::new(
                "cleanup_scan_root_unavailable",
                format!("CoreRobin could not inspect the system disk root: {error}"),
            )
        })?;
        if !metadata.is_dir() {
            return Err(CommandError::new(
                "cleanup_scan_root_unavailable",
                "The system disk root is not a directory.",
            ));
        }
        Ok(Self {
            #[cfg(unix)]
            device: metadata.dev(),
        })
    }

    fn allows_directory(self, metadata: &Metadata) -> bool {
        #[cfg(unix)]
        {
            metadata.dev() == self.device
        }
        #[cfg(windows)]
        {
            return !is_windows_reparse_point(metadata);
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = metadata;
            true
        }
    }
}

impl ScanContext<'_> {
    fn safety_for_path(&self, path: &Path, fallback: CleanupSafety) -> CleanupSafety {
        matching_location_definition(self.definitions, path)
            .map_or(fallback, |(_, definition)| definition.safety)
    }

    fn record_file(&mut self, path: &Path, allocated_size_bytes: u64) {
        if let Some(application_bundle) = application_bundle_for_path(path, self.home) {
            let size = self
                .application_sizes
                .entry(application_bundle)
                .or_default();
            *size = size.saturating_add(allocated_size_bytes);
        }
        let Some((index, _)) = matching_location_definition(self.definitions, path) else {
            return;
        };
        if let Some(summary) = self.location_summaries.get_mut(index) {
            summary.size_bytes = summary.size_bytes.saturating_add(allocated_size_bytes);
            summary.item_count = summary.item_count.saturating_add(1);
        }
    }

    fn capture_location_root(&mut self, path: &Path, node: &CleanupNode) {
        for (index, definition) in self.definitions.iter().enumerate() {
            if !definition.paths.iter().any(|root| root == path) {
                continue;
            }
            if let Some(summary) = self.location_summaries.get_mut(index) {
                summary.available = true;
                summary.nodes.push(node.clone());
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn application_bundle_for_path(path: &Path, home: &Path) -> Option<PathBuf> {
    for application_root in [PathBuf::from("/Applications"), home.join("Applications")] {
        let Ok(relative) = path.strip_prefix(&application_root) else {
            continue;
        };
        let bundle_name = relative.components().next()?.as_os_str();
        let bundle = application_root.join(bundle_name);
        if bundle
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        {
            return Some(bundle);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn application_bundle_for_path(_path: &Path, _home: &Path) -> Option<PathBuf> {
    None
}

fn matching_location_definition<'a>(
    definitions: &'a [LocationDefinition],
    path: &Path,
) -> Option<(usize, &'a LocationDefinition)> {
    definitions
        .iter()
        .enumerate()
        .filter_map(|(index, definition)| {
            definition
                .paths
                .iter()
                .filter(|root| path == root.as_path() || path.starts_with(root))
                .map(|root| root.components().count())
                .max()
                .map(|depth| (depth, index, definition))
        })
        .max_by_key(|(depth, _, _)| *depth)
        .map(|(_, index, definition)| (index, definition))
}

#[cfg(test)]
fn scan_home(
    home: &Path,
    definitions: Vec<LocationDefinition>,
    include_application_inventory: bool,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    scan_filesystem(
        home,
        home,
        definitions,
        include_application_inventory,
        cancelled,
        on_progress,
    )
}

fn scan_filesystem(
    scan_root: &Path,
    home: &Path,
    definitions: Vec<LocationDefinition>,
    include_application_inventory: bool,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    let boundary = ScanFilesystemBoundary::for_root(scan_root)?;
    let mut stats = ScanStats::new();
    let mut largest_files = Vec::new();
    let mut application_sizes = HashMap::new();
    let mut location_summaries = definitions
        .iter()
        .map(|definition| LocationSummary {
            available: definition.paths.iter().any(|path| path.is_dir()),
            ..LocationSummary::default()
        })
        .collect::<Vec<_>>();
    stats.report_progress(scan_root, home, on_progress, true);

    let mut root = {
        let mut seen_files = HashSet::new();
        let mut context = ScanContext {
            stats: &mut stats,
            largest_files: &mut largest_files,
            home,
            scan_root,
            boundary,
            definitions: &definitions,
            location_summaries: &mut location_summaries,
            application_sizes: &mut application_sizes,
            cancelled,
            on_progress,
        };
        scan_path(
            scan_root,
            true,
            true,
            CleanupSafety::Review,
            &mut context,
            &mut seen_files,
            MAX_VISUAL_TREE_DEPTH,
        )?
    };
    let mut remaining = MAX_VISUAL_NODES_PER_SCAN;
    prune_cleanup_node(&mut root, &mut remaining);

    let locations = definitions
        .into_iter()
        .zip(location_summaries)
        .map(|(definition, mut summary)| {
            summary.nodes.sort_by(|left, right| {
                right
                    .allocated_size_bytes
                    .cmp(&left.allocated_size_bytes)
                    .then_with(|| left.name.cmp(&right.name))
            });
            prune_cleanup_nodes(&mut summary.nodes, MAX_VISUAL_NODES_PER_LOCATION);
            CleanupLocation {
                kind: definition.kind,
                paths: definition
                    .paths
                    .iter()
                    .map(|path| display_path(path, home))
                    .collect(),
                size_bytes: summary.size_bytes,
                item_count: summary.item_count,
                safety: definition.safety,
                available: summary.available,
                nodes: summary.nodes,
            }
        })
        .collect();

    largest_files.sort_by_key(|file| Reverse(file.size_bytes));
    largest_files.dedup_by(|left, right| left.path == right.path);
    largest_files.truncate(MAX_LARGE_FILES);

    let (installed_applications, application_inventory_available) = if include_application_inventory
    {
        scan_installed_applications(home, cancelled, &mut stats, on_progress, &application_sizes)?
    } else {
        (Vec::new(), false)
    };

    let unreadable_paths = stats
        .unreadable_paths
        .iter()
        .map(|path| display_path(path, home))
        .collect();

    stats.report_progress(scan_root, home, on_progress, true);

    Ok(CleanupScan {
        sampled_at_ms: now_millis(),
        duration_ms: stats.elapsed_ms(),
        root,
        locations,
        largest_files,
        installed_applications,
        application_inventory_available,
        scanned_entry_count: stats.scanned_entry_count,
        unreadable_entry_count: stats.unreadable_entry_count,
        unreadable_paths,
        deletion_available: true,
    })
}

#[cfg(target_os = "macos")]
fn scan_installed_applications(
    home: &Path,
    cancelled: &AtomicBool,
    stats: &mut ScanStats,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
    observed_sizes: &HashMap<PathBuf, u64>,
) -> Result<(Vec<CleanupApplication>, bool), CommandError> {
    ensure_scan_active(cancelled)?;
    let application_roots = [PathBuf::from("/Applications"), home.join("Applications")];
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for root in application_roots {
        stats.report_progress(&root, home, on_progress, true);
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries {
            ensure_scan_active(cancelled)?;
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let is_application = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !is_application || file_type.is_symlink() || !file_type.is_dir() {
                continue;
            }
            let canonical = path.canonicalize().unwrap_or(path);
            if seen.insert(canonical.clone()) {
                paths.push(canonical);
            }
        }
    }
    paths.sort();
    ensure_scan_active(cancelled)?;

    let mut inventory_available = true;
    let sizes = match application_sizes(&paths, observed_sizes, cancelled) {
        Ok(sizes) => sizes,
        Err(_) => {
            inventory_available = false;
            HashMap::new()
        }
    };
    ensure_scan_active(cancelled)?;
    let last_used = match application_last_used_times(&paths, cancelled) {
        Ok(last_used) => last_used,
        Err(_) => {
            inventory_available = false;
            vec![None; paths.len()]
        }
    };
    ensure_scan_active(cancelled)?;

    let applications = paths
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            let metadata = fs::metadata(&path).ok();
            CleanupApplication {
                name: path
                    .file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned()),
                path: path.to_string_lossy().into_owned(),
                size_bytes: sizes.get(&path).copied().unwrap_or(0),
                last_used_at_ms: last_used.get(index).copied().flatten(),
                modified_at_ms: metadata
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(system_time_millis),
            }
        })
        .collect();
    Ok((applications, inventory_available))
}

#[cfg(not(target_os = "macos"))]
fn scan_installed_applications(
    _home: &Path,
    cancelled: &AtomicBool,
    _stats: &mut ScanStats,
    _on_progress: &mut dyn FnMut(CleanupScanProgress),
    _observed_sizes: &HashMap<PathBuf, u64>,
) -> Result<(Vec<CleanupApplication>, bool), CommandError> {
    ensure_scan_active(cancelled)?;
    Ok((Vec::new(), false))
}

#[cfg(target_os = "macos")]
fn application_sizes(
    paths: &[PathBuf],
    observed_sizes: &HashMap<PathBuf, u64>,
    cancelled: &AtomicBool,
) -> Result<HashMap<PathBuf, u64>, ChildCommandFailure> {
    let mut sizes = paths
        .iter()
        .filter_map(|path| observed_sizes.get(path).map(|size| (path.clone(), *size)))
        .collect::<HashMap<_, _>>();
    let missing_paths = paths
        .iter()
        .filter(|path| !sizes.contains_key(*path))
        .collect::<Vec<_>>();
    if missing_paths.is_empty() {
        return Ok(sizes);
    }
    let mut command = Command::new("/usr/bin/du");
    command.arg("-sk").args(missing_paths);
    let output = run_bounded_child(&mut command, cancelled, APPLICATION_DU_DEADLINE)?;
    sizes.extend(parse_application_sizes(&String::from_utf8_lossy(&output)));
    Ok(sizes)
}

#[cfg(target_os = "macos")]
fn parse_application_sizes(output: &str) -> HashMap<PathBuf, u64> {
    output
        .lines()
        .filter_map(|line| {
            let (kilobytes, path) = line.split_once('\t')?;
            let bytes = kilobytes.trim().parse::<u64>().ok()?.saturating_mul(1_024);
            Some((PathBuf::from(path), bytes))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn application_last_used_times(
    paths: &[PathBuf],
    cancelled: &AtomicBool,
) -> Result<Vec<Option<u64>>, ChildCommandFailure> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut command = Command::new("/usr/bin/mdls");
    command.arg("-name").arg("kMDItemLastUsedDate").args(paths);
    let output = run_bounded_child(&mut command, cancelled, APPLICATION_MDLS_DEADLINE)?;
    let mut values = String::from_utf8_lossy(&output)
        .lines()
        .map(parse_mdls_timestamp)
        .collect::<Vec<_>>();
    if values.len() != paths.len() {
        return Err(ChildCommandFailure::UnexpectedOutput);
    }
    values.resize(paths.len(), None);
    values.truncate(paths.len());
    Ok(values)
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildCommandFailure {
    Cancelled,
    DeadlineExceeded,
    OutputLimitExceeded,
    SpawnFailed,
    WaitFailed,
    ReadFailed,
    UnsuccessfulExit,
    UnexpectedOutput,
}

#[cfg(target_os = "macos")]
fn run_bounded_child(
    command: &mut Command,
    cancelled: &AtomicBool,
    deadline: Duration,
) -> Result<Vec<u8>, ChildCommandFailure> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(ChildCommandFailure::Cancelled);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| ChildCommandFailure::SpawnFailed)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ChildCommandFailure::SpawnFailed)?;
    let output_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout
            .take((APPLICATION_CHILD_OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut output)
            .map(|_| output)
    });
    let started_at = Instant::now();
    let status = loop {
        if cancelled.load(Ordering::Relaxed) {
            terminate_child_process_group(&mut child);
            let _ = output_reader.join();
            return Err(ChildCommandFailure::Cancelled);
        }
        if started_at.elapsed() >= deadline {
            terminate_child_process_group(&mut child);
            let _ = output_reader.join();
            return Err(ChildCommandFailure::DeadlineExceeded);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(APPLICATION_CHILD_POLL_INTERVAL),
            Err(_) => {
                terminate_child_process_group(&mut child);
                let _ = output_reader.join();
                return Err(ChildCommandFailure::WaitFailed);
            }
        }
    };
    let output = output_reader
        .join()
        .map_err(|_| ChildCommandFailure::ReadFailed)?
        .map_err(|_| ChildCommandFailure::ReadFailed)?;
    if output.len() > APPLICATION_CHILD_OUTPUT_LIMIT {
        return Err(ChildCommandFailure::OutputLimitExceeded);
    }
    if !status.success() {
        return Err(ChildCommandFailure::UnsuccessfulExit);
    }
    Ok(output)
}

#[cfg(target_os = "macos")]
fn terminate_child_process_group(child: &mut Child) {
    let process_group = -(child.id() as libc::pid_t);
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(target_os = "macos")]
fn parse_mdls_timestamp(line: &str) -> Option<u64> {
    let value = line.split_once('=').map_or(line, |(_, value)| value).trim();
    if value == "(null)" {
        return None;
    }
    let mut parts = value.split_whitespace();
    let date = parts.next()?;
    let time = parts.next()?;
    let offset = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let mut date_parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let year = date_parts.next()??;
    let month = date_parts.next()??;
    let day = date_parts.next()??;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut time_parts = time.split(':').map(|part| part.parse::<i64>().ok());
    let hour = time_parts.next()??;
    let minute = time_parts.next()??;
    let second = time_parts.next()??;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let offset_sign = match offset.as_bytes().first().copied()? {
        b'+' => 1_i64,
        b'-' => -1_i64,
        _ => return None,
    };
    if offset.len() != 5 {
        return None;
    }
    let offset_hour = offset[1..3].parse::<i64>().ok()?;
    let offset_minute = offset[3..5].parse::<i64>().ok()?;
    if offset_hour > 23 || offset_minute > 59 {
        return None;
    }
    let local_seconds = days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)?;
    let utc_seconds =
        local_seconds.checked_sub(offset_sign * (offset_hour * 3_600 + offset_minute * 60))?;
    u64::try_from(utc_seconds).ok()?.checked_mul(1_000)
}

#[cfg(target_os = "macos")]
fn days_from_civil(mut year: i64, month: i64, day: i64) -> i64 {
    year -= i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn scan_path(
    root: &Path,
    collect_large_files: bool,
    count_discovered_bytes: bool,
    safety: CleanupSafety,
    context: &mut ScanContext<'_>,
    seen_files: &mut HashSet<FileIdentity>,
    max_depth: usize,
) -> Result<CleanupNode, CommandError> {
    scan_directory(
        root,
        collect_large_files,
        count_discovered_bytes,
        safety,
        context,
        seen_files,
        max_depth,
    )
}

#[cfg(unix)]
type FileIdentity = (u64, u64);
#[cfg(windows)]
type FileIdentity = (u32, u64);
#[cfg(not(any(unix, windows)))]
type FileIdentity = PathBuf;

fn scan_directory(
    directory: &Path,
    collect_large_files: bool,
    count_discovered_bytes: bool,
    safety: CleanupSafety,
    context: &mut ScanContext<'_>,
    seen_files: &mut HashSet<FileIdentity>,
    remaining_depth: usize,
) -> Result<CleanupNode, CommandError> {
    let directory_safety = context.safety_for_path(directory, safety);
    if is_cloud_backed_cleanup_root(directory, context.home) {
        ensure_scan_active(context.cancelled)?;
        context.stats.record_unreadable(directory);
        context
            .stats
            .report_progress(directory, context.home, context.on_progress, true);
        let node = restricted_cleanup_node(directory, directory_safety, context.home);
        context.capture_location_root(directory, &node);
        return Ok(node);
    }
    if remaining_depth == 0 {
        return scan_directory_summary(
            directory,
            collect_large_files,
            count_discovered_bytes,
            directory_safety,
            context,
            seen_files,
        );
    }
    ensure_scan_active(context.cancelled)?;
    context
        .stats
        .report_progress(directory, context.home, context.on_progress, false);
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            context.stats.record_unreadable(directory);
            let node = restricted_cleanup_node(directory, directory_safety, context.home);
            context.capture_location_root(directory, &node);
            return Ok(node);
        }
    };
    let mut children = ChildAccumulator::default();
    for entry in entries {
        ensure_scan_active(context.cancelled)?;
        context.stats.scanned_entry_count += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                context.stats.record_unreadable(directory);
                continue;
            }
        };
        let entry_path = entry.path();
        let entry_safety = context.safety_for_path(&entry_path, directory_safety);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                context.stats.record_unreadable(&entry_path);
                children.push(restricted_cleanup_node(
                    &entry_path,
                    entry_safety,
                    context.home,
                ));
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if is_excluded_scan_namespace(&entry_path, context.scan_root) {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    context.stats.record_unreadable(&entry_path);
                    children.push(restricted_cleanup_node(
                        &entry_path,
                        entry_safety,
                        context.home,
                    ));
                    continue;
                }
            };
            if !context.boundary.allows_directory(&metadata) {
                continue;
            }
            children.push(scan_directory(
                &entry_path,
                collect_large_files,
                count_discovered_bytes,
                directory_safety,
                context,
                seen_files,
                remaining_depth - 1,
            )?);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                context.stats.record_unreadable(&entry_path);
                children.push(restricted_cleanup_node(
                    &entry_path,
                    entry_safety,
                    context.home,
                ));
                continue;
            }
        };
        if !should_count_file(&entry_path, &metadata, seen_files) {
            continue;
        }
        let logical_size_bytes = metadata.len();
        let allocated_size_bytes = allocated_file_size(&entry_path, &metadata);
        context.record_file(&entry_path, allocated_size_bytes);
        if count_discovered_bytes {
            context.stats.discovered_bytes = context
                .stats
                .discovered_bytes
                .saturating_add(allocated_size_bytes);
        }
        if collect_large_files && allocated_size_bytes >= LARGE_FILE_THRESHOLD_BYTES {
            context.largest_files.push(CleanupFile {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry_path.to_string_lossy().into_owned(),
                size_bytes: allocated_size_bytes,
                modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
            });
        }
        let protection_reason = cleanup_protection_for_path(&entry_path, context.home);
        children.push(CleanupNode {
            id: display_path(&entry_path, context.home),
            name: cleanup_node_name(&entry_path),
            path: Some(display_path(&entry_path, context.home)),
            size_bytes: allocated_size_bytes,
            logical_size_bytes,
            allocated_size_bytes,
            item_count: 1,
            safety: entry_safety,
            kind: CleanupNodeKind::File,
            deletion_protected: protection_reason.is_some(),
            protection_reason,
            has_children: false,
            children: Vec::new(),
        });
        context
            .stats
            .report_progress(directory, context.home, context.on_progress, false);
    }

    let logical_size_bytes = children.total_logical_size_bytes;
    let allocated_size_bytes = children.total_allocated_size_bytes;
    let item_count = children.total_item_count;
    let has_children = children.has_children;
    let path = display_path(directory, context.home);
    let protection_reason = cleanup_protection_for_path(directory, context.home);
    let node = CleanupNode {
        id: path.clone(),
        name: cleanup_node_name(directory),
        path: Some(path),
        size_bytes: allocated_size_bytes,
        logical_size_bytes,
        allocated_size_bytes,
        item_count,
        safety: directory_safety,
        kind: CleanupNodeKind::Folder,
        deletion_protected: protection_reason.is_some(),
        protection_reason,
        has_children,
        children: children.finish(directory, context.home, directory_safety),
    };
    context.capture_location_root(directory, &node);
    Ok(node)
}

#[cfg(target_os = "macos")]
fn is_cloud_backed_cleanup_root(path: &Path, home: &Path) -> bool {
    [
        home.join("Library/Mobile Documents"),
        home.join("Library/CloudStorage"),
    ]
    .iter()
    .any(|root| path == root)
}

#[cfg(not(target_os = "macos"))]
fn is_cloud_backed_cleanup_root(_path: &Path, _home: &Path) -> bool {
    false
}

fn scan_directory_summary(
    root: &Path,
    collect_large_files: bool,
    count_discovered_bytes: bool,
    safety: CleanupSafety,
    context: &mut ScanContext<'_>,
    seen_files: &mut HashSet<FileIdentity>,
) -> Result<CleanupNode, CommandError> {
    let root_safety = context.safety_for_path(root, safety);
    let mut logical_size_bytes = 0_u64;
    let mut allocated_size_bytes = 0_u64;
    let mut item_count = 0_usize;
    let mut has_children = false;
    let mut stack = vec![root.to_path_buf()];
    let mut root_readable = false;

    while let Some(directory) = stack.pop() {
        ensure_scan_active(context.cancelled)?;
        context
            .stats
            .report_progress(&directory, context.home, context.on_progress, false);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => {
                if directory == root {
                    root_readable = true;
                }
                entries
            }
            Err(_) => {
                context.stats.record_unreadable(&directory);
                continue;
            }
        };
        for entry in entries {
            ensure_scan_active(context.cancelled)?;
            context.stats.scanned_entry_count += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    context.stats.record_unreadable(&directory);
                    continue;
                }
            };
            let entry_path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    context.stats.record_unreadable(&entry_path);
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if is_excluded_scan_namespace(&entry_path, context.scan_root) {
                    continue;
                }
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        context.stats.record_unreadable(&entry_path);
                        continue;
                    }
                };
                if !context.boundary.allows_directory(&metadata) {
                    continue;
                }
                has_children = true;
                stack.push(entry_path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            has_children = true;
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    context.stats.record_unreadable(&entry_path);
                    continue;
                }
            };
            if !should_count_file(&entry_path, &metadata, seen_files) {
                continue;
            }
            let file_logical_size = metadata.len();
            let file_allocated_size = allocated_file_size(&entry_path, &metadata);
            context.record_file(&entry_path, file_allocated_size);
            logical_size_bytes = logical_size_bytes.saturating_add(file_logical_size);
            allocated_size_bytes = allocated_size_bytes.saturating_add(file_allocated_size);
            item_count = item_count.saturating_add(1);
            if count_discovered_bytes {
                context.stats.discovered_bytes = context
                    .stats
                    .discovered_bytes
                    .saturating_add(file_allocated_size);
            }
            if collect_large_files && file_allocated_size >= LARGE_FILE_THRESHOLD_BYTES {
                context.largest_files.push(CleanupFile {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry_path.to_string_lossy().into_owned(),
                    size_bytes: file_allocated_size,
                    modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
                });
            }
            context
                .stats
                .report_progress(&directory, context.home, context.on_progress, false);
        }
    }

    if !root_readable {
        let node = restricted_cleanup_node(root, root_safety, context.home);
        context.capture_location_root(root, &node);
        return Ok(node);
    }
    let path = display_path(root, context.home);
    let protection_reason = cleanup_protection_for_path(root, context.home);
    let node = CleanupNode {
        id: path.clone(),
        name: cleanup_node_name(root),
        path: Some(path),
        size_bytes: allocated_size_bytes,
        logical_size_bytes,
        allocated_size_bytes,
        item_count,
        safety: root_safety,
        kind: CleanupNodeKind::Folder,
        deletion_protected: protection_reason.is_some(),
        protection_reason,
        has_children,
        children: Vec::new(),
    };
    context.capture_location_root(root, &node);
    Ok(node)
}

impl ScanStats {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            scanned_entry_count: 0,
            discovered_bytes: 0,
            unreadable_entry_count: 0,
            unreadable_paths: Vec::new(),
            last_reported_entry_count: 0,
        }
    }

    fn record_unreadable(&mut self, path: &Path) {
        self.unreadable_entry_count += 1;
        if self.unreadable_paths.len() < MAX_UNREADABLE_PATHS
            && !self
                .unreadable_paths
                .iter()
                .any(|candidate| candidate == path)
        {
            self.unreadable_paths.push(path.to_path_buf());
        }
    }

    fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn report_progress(
        &mut self,
        path: &Path,
        home: &Path,
        on_progress: &mut dyn FnMut(CleanupScanProgress),
        force: bool,
    ) {
        if !force
            && self
                .scanned_entry_count
                .saturating_sub(self.last_reported_entry_count)
                < PROGRESS_INTERVAL_ENTRIES
        {
            return;
        }
        self.last_reported_entry_count = self.scanned_entry_count;
        on_progress(CleanupScanProgress {
            scanned_entry_count: self.scanned_entry_count,
            discovered_bytes: self.discovered_bytes,
            current_path: display_path(path, home),
            elapsed_ms: self.elapsed_ms(),
        });
    }
}

fn ensure_scan_active(cancelled: &AtomicBool) -> Result<(), CommandError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(CommandError::new(
            "cleanup_scan_cancelled",
            "The cleanup scan was cancelled.",
        ))
    } else {
        Ok(())
    }
}

impl ChildAccumulator {
    fn push(&mut self, node: CleanupNode) {
        self.has_children = true;
        self.total_logical_size_bytes = self
            .total_logical_size_bytes
            .saturating_add(node.logical_size_bytes);
        self.total_allocated_size_bytes = self
            .total_allocated_size_bytes
            .saturating_add(node.allocated_size_bytes);
        self.total_item_count = self.total_item_count.saturating_add(node.item_count);

        if node.kind == CleanupNodeKind::Restricted {
            if self.restricted.len() < MAX_RESTRICTED_CHILDREN {
                self.restricted.push(node);
            } else {
                self.omitted_restricted_count = self
                    .omitted_restricted_count
                    .saturating_add(node.item_count.max(1));
            }
            return;
        }
        if self.candidates.len() < MAX_CHART_CHILDREN {
            self.candidates.push(node);
            return;
        }
        let smallest_index = self
            .candidates
            .iter()
            .enumerate()
            .min_by_key(|(_, candidate)| {
                (candidate.allocated_size_bytes, candidate.logical_size_bytes)
            })
            .map(|(index, _)| index)
            .unwrap_or(0);
        let smallest = &self.candidates[smallest_index];
        if (node.allocated_size_bytes, node.logical_size_bytes)
            > (smallest.allocated_size_bytes, smallest.logical_size_bytes)
        {
            let replaced = std::mem::replace(&mut self.candidates[smallest_index], node);
            self.omit(replaced);
        } else {
            self.omit(node);
        }
    }

    fn omit(&mut self, node: CleanupNode) {
        self.omitted_logical_size_bytes = self
            .omitted_logical_size_bytes
            .saturating_add(node.logical_size_bytes);
        self.omitted_allocated_size_bytes = self
            .omitted_allocated_size_bytes
            .saturating_add(node.allocated_size_bytes);
        self.omitted_item_count = self.omitted_item_count.saturating_add(node.item_count);
    }

    fn finish(mut self, parent: &Path, home: &Path, safety: CleanupSafety) -> Vec<CleanupNode> {
        self.candidates.sort_by(|left, right| {
            right
                .allocated_size_bytes
                .cmp(&left.allocated_size_bytes)
                .then_with(|| right.logical_size_bytes.cmp(&left.logical_size_bytes))
                .then_with(|| left.name.cmp(&right.name))
        });
        let mut visible = Vec::with_capacity(self.candidates.len() + self.restricted.len() + 2);
        for (index, node) in std::mem::take(&mut self.candidates).into_iter().enumerate() {
            let too_small = self.total_allocated_size_bytes > 0
                && u128::from(node.allocated_size_bytes)
                    .saturating_mul(MIN_CHART_FRACTION_DENOMINATOR)
                    < u128::from(self.total_allocated_size_bytes);
            if index >= MIN_ALWAYS_VISIBLE_CHILDREN && too_small {
                self.omit(node);
            } else {
                visible.push(node);
            }
        }
        let parent_path = display_path(parent, home);
        if self.omitted_allocated_size_bytes > 0
            || self.omitted_logical_size_bytes > 0
            || self.omitted_item_count > 0
        {
            visible.push(CleanupNode {
                id: format!("{parent_path}::aggregate"),
                name: "other".to_owned(),
                path: None,
                size_bytes: self.omitted_allocated_size_bytes,
                logical_size_bytes: self.omitted_logical_size_bytes,
                allocated_size_bytes: self.omitted_allocated_size_bytes,
                item_count: self.omitted_item_count,
                safety,
                kind: CleanupNodeKind::Aggregate,
                deletion_protected: true,
                protection_reason: Some(CleanupProtectionReason::Aggregate),
                has_children: false,
                children: Vec::new(),
            });
        }
        self.restricted
            .sort_by(|left, right| left.name.cmp(&right.name));
        visible.extend(self.restricted);
        if self.omitted_restricted_count > 0 {
            visible.push(CleanupNode {
                id: format!("{parent_path}::restricted"),
                name: "restricted".to_owned(),
                path: None,
                size_bytes: 0,
                logical_size_bytes: 0,
                allocated_size_bytes: 0,
                item_count: self.omitted_restricted_count,
                safety,
                kind: CleanupNodeKind::Restricted,
                deletion_protected: true,
                protection_reason: Some(CleanupProtectionReason::Restricted),
                has_children: false,
                children: Vec::new(),
            });
        }
        visible
    }
}

fn prune_cleanup_nodes(nodes: &mut Vec<CleanupNode>, max_nodes: usize) {
    if max_nodes == 0 {
        nodes.clear();
        return;
    }
    nodes.sort_by(|left, right| {
        right
            .allocated_size_bytes
            .cmp(&left.allocated_size_bytes)
            .then_with(|| left.name.cmp(&right.name))
    });
    if nodes.len() > max_nodes {
        nodes.truncate(max_nodes);
    }
    loop {
        let (node_count, max_depth) = cleanup_forest_metrics(nodes);
        if node_count <= max_nodes || max_depth <= 1 {
            break;
        }
        let target_parent_depth = max_depth - 1;
        let removed = nodes
            .iter_mut()
            .map(|node| collapse_cleanup_children_at_depth(node, 1, target_parent_depth))
            .sum::<usize>();
        if removed == 0 {
            break;
        }
    }
}

fn prune_cleanup_node(node: &mut CleanupNode, remaining: &mut usize) {
    if *remaining == 0 {
        node.children.clear();
        return;
    }
    loop {
        let (node_count, max_depth) = cleanup_node_metrics(node);
        if node_count <= *remaining || max_depth <= 1 {
            break;
        }
        if collapse_cleanup_children_at_depth(node, 1, max_depth - 1) == 0 {
            break;
        }
    }
    *remaining = remaining.saturating_sub(count_cleanup_nodes(node));
}

fn cleanup_forest_metrics(nodes: &[CleanupNode]) -> (usize, usize) {
    nodes.iter().fold((0, 0), |(count, depth), node| {
        let (node_count, node_depth) = cleanup_node_metrics(node);
        (count.saturating_add(node_count), depth.max(node_depth))
    })
}

fn cleanup_node_metrics(node: &CleanupNode) -> (usize, usize) {
    node.children.iter().fold((1, 1), |(count, depth), child| {
        let (child_count, child_depth) = cleanup_node_metrics(child);
        (
            count.saturating_add(child_count),
            depth.max(child_depth.saturating_add(1)),
        )
    })
}

fn count_cleanup_nodes(node: &CleanupNode) -> usize {
    cleanup_node_metrics(node).0
}

fn collapse_cleanup_children_at_depth(
    node: &mut CleanupNode,
    depth: usize,
    target_parent_depth: usize,
) -> usize {
    if depth == target_parent_depth {
        let removed = node.children.iter().map(count_cleanup_nodes).sum();
        if removed > 0 {
            node.children.clear();
            node.has_children = true;
        }
        return removed;
    }
    node.children
        .iter_mut()
        .map(|child| collapse_cleanup_children_at_depth(child, depth + 1, target_parent_depth))
        .sum()
}

fn restricted_cleanup_node(path: &Path, safety: CleanupSafety, home: &Path) -> CleanupNode {
    CleanupNode {
        id: format!("{}::restricted", display_path(path, home)),
        name: cleanup_node_name(path),
        path: Some(display_path(path, home)),
        size_bytes: 0,
        logical_size_bytes: 0,
        allocated_size_bytes: 0,
        item_count: 1,
        safety,
        kind: CleanupNodeKind::Restricted,
        deletion_protected: true,
        protection_reason: Some(CleanupProtectionReason::Restricted),
        has_children: false,
        children: Vec::new(),
    }
}

fn cleanup_node_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn should_count_file(
    _path: &Path,
    metadata: &Metadata,
    seen_files: &mut HashSet<FileIdentity>,
) -> bool {
    metadata.nlink() <= 1 || seen_files.insert((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn should_count_file(
    path: &Path,
    _metadata: &Metadata,
    seen_files: &mut HashSet<FileIdentity>,
) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return true;
    };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } != 0;
    if !succeeded || information.nNumberOfLinks <= 1 {
        return true;
    }
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    seen_files.insert((information.dwVolumeSerialNumber, file_index))
}

#[cfg(not(any(unix, windows)))]
fn should_count_file(
    path: &Path,
    _metadata: &Metadata,
    seen_files: &mut HashSet<FileIdentity>,
) -> bool {
    seen_files.insert(path.to_path_buf())
}

#[cfg(unix)]
fn allocated_file_size(_path: &Path, metadata: &Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(windows)]
fn allocated_file_size(path: &Path, metadata: &Metadata) -> u64 {
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut high = 0_u32;
    unsafe { SetLastError(0) };
    let low = unsafe { GetCompressedFileSizeW(path.as_ptr(), &mut high) };
    if low == u32::MAX && unsafe { GetLastError() } != 0 {
        return metadata.len();
    }
    (u64::from(high) << 32) | u64::from(low)
}

#[cfg(not(any(unix, windows)))]
fn allocated_file_size(_path: &Path, metadata: &Metadata) -> u64 {
    metadata.len()
}

fn home_directory() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn system_disk_root(home: &Path) -> Option<PathBuf> {
    home.ancestors()
        .filter(|ancestor| ancestor.is_absolute())
        .last()
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn is_excluded_scan_namespace(path: &Path, scan_root: &Path) -> bool {
    scan_root == Path::new("/") && path == Path::new("/System/Volumes")
}

#[cfg(not(target_os = "macos"))]
fn is_excluded_scan_namespace(_path: &Path, _scan_root: &Path) -> bool {
    false
}

fn display_path(path: &Path, home: &Path) -> String {
    path.strip_prefix(home)
        .map(|relative| {
            if relative.as_os_str().is_empty() {
                "~".to_owned()
            } else {
                format!("~/{}", relative.to_string_lossy())
            }
        })
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn system_time_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn now_millis() -> u64 {
    system_time_millis(SystemTime::now()).unwrap_or(0)
}

fn next_cleanup_lease_id() -> String {
    let sequence = NEXT_CLEANUP_LEASE_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    format!("cleanup-{nanos:032x}-{sequence:016x}")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Barrier;
    use std::sync::atomic::AtomicUsize;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn subtree_requests_are_last_request_wins_and_never_scan_concurrently() {
        let coordinator = Arc::new(CleanupWorkCoordinator::default());
        let path = PathBuf::from("/fixture/shared");
        let first_cancelled = coordinator
            .begin_subtree("first".to_owned(), path.clone())
            .unwrap();
        let first_started = Arc::new(Barrier::new(2));
        let active_workers = Arc::new(AtomicUsize::new(0));
        let maximum_workers = Arc::new(AtomicUsize::new(0));

        let first_worker = {
            let coordinator = Arc::clone(&coordinator);
            let cancelled = Arc::clone(&first_cancelled);
            let first_started = Arc::clone(&first_started);
            let active_workers = Arc::clone(&active_workers);
            let maximum_workers = Arc::clone(&maximum_workers);
            thread::spawn(move || {
                coordinator.run_exclusive(&cancelled, || {
                    let active = active_workers.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum_workers.fetch_max(active, Ordering::SeqCst);
                    first_started.wait();
                    while !cancelled.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(1));
                    }
                    active_workers.fetch_sub(1, Ordering::SeqCst);
                    ensure_scan_active(&cancelled)
                })
            })
        };
        first_started.wait();

        let second_cancelled = coordinator
            .begin_subtree("second".to_owned(), path)
            .unwrap();
        let second_worker = {
            let coordinator = Arc::clone(&coordinator);
            let cancelled = Arc::clone(&second_cancelled);
            let active_workers = Arc::clone(&active_workers);
            let maximum_workers = Arc::clone(&maximum_workers);
            thread::spawn(move || {
                coordinator.run_exclusive(&cancelled, || {
                    let active = active_workers.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum_workers.fetch_max(active, Ordering::SeqCst);
                    active_workers.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };

        assert_eq!(
            first_worker.join().unwrap().unwrap_err().code,
            "cleanup_scan_cancelled"
        );
        second_worker.join().unwrap().unwrap();
        assert_eq!(maximum_workers.load(Ordering::SeqCst), 1);
        coordinator.finish_subtree(&first_cancelled);
        coordinator.finish_subtree(&second_cancelled);
    }

    #[test]
    fn full_scan_cancels_subtree_and_blocks_new_subtree_requests() {
        let coordinator = CleanupWorkCoordinator::default();
        let subtree = coordinator
            .begin_subtree("subtree".to_owned(), PathBuf::from("/fixture"))
            .unwrap();
        let full_scan = coordinator.begin_full_scan().unwrap();

        assert!(subtree.load(Ordering::Relaxed));
        let error = coordinator
            .begin_subtree("later".to_owned(), PathBuf::from("/fixture/later"))
            .unwrap_err();
        assert_eq!(error.code, "cleanup_scan_in_progress");

        coordinator.finish_subtree(&subtree);
        coordinator.finish_full_scan(&full_scan);
    }

    #[test]
    fn subtree_cancellation_is_scoped_to_the_matching_request() {
        let coordinator = CleanupWorkCoordinator::default();
        let cancelled = coordinator
            .begin_subtree("current".to_owned(), PathBuf::from("/fixture"))
            .unwrap();

        assert!(!coordinator.cancel_subtree("stale").unwrap());
        assert!(!cancelled.load(Ordering::Relaxed));
        assert!(coordinator.cancel_subtree("current").unwrap());
        assert!(cancelled.load(Ordering::Relaxed));

        coordinator.finish_subtree(&cancelled);
    }

    fn cleanup_delete_request(
        home: &Path,
        paths: Vec<String>,
        scan_sampled_at_ms: u64,
    ) -> CleanupDeleteLeaseRequest {
        let canonical_home = home.canonicalize().unwrap();
        let root = DeleteRoot::open(&canonical_home).unwrap();
        let expected_targets = paths
            .iter()
            .map(|display| {
                let path = expand_cleanup_path(display, &canonical_home).unwrap();
                let inspection = path
                    .strip_prefix(home)
                    .or_else(|_| path.strip_prefix(&canonical_home))
                    .ok()
                    .and_then(|relative| root.bind(relative).ok())
                    .and_then(|bound| bound.inspect().ok());
                CleanupDeleteTargetEvidence {
                    path: display.clone(),
                    logical_size_bytes: inspection
                        .as_ref()
                        .map_or(0, |value| value.logical_size_bytes),
                    allocated_size_bytes: inspection
                        .as_ref()
                        .map_or(0, |value| value.allocated_size_bytes),
                    item_count: inspection.as_ref().map_or(0, |value| value.item_count),
                }
            })
            .collect();
        CleanupDeleteLeaseRequest {
            paths,
            scan_sampled_at_ms,
            expected_targets,
            mode: CleanupDeleteMode::Permanent,
        }
    }

    #[test]
    fn platform_cleanup_roots_do_not_double_count_the_same_path() {
        let root = test_root("unique-platform-roots");
        fs::create_dir_all(&root).unwrap();
        let mut seen = HashSet::new();

        for definition in platform_paths(&root) {
            for path in definition.paths {
                assert!(
                    seen.insert(path.clone()),
                    "duplicate cleanup root: {}",
                    path.display(),
                );
            }
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_scan_cache_round_trips_and_clears() {
        let root = test_root("scan-cache");
        let cache_path = root.join("nested/cleanup-scan-v3.json");

        assert_eq!(load_cleanup_scan_cache(&cache_path).unwrap(), None);
        save_cleanup_scan_cache(&cache_path, r#"{"version":5}"#).unwrap();
        assert_eq!(
            load_cleanup_scan_cache(&cache_path).unwrap(),
            Some(r#"{"version":5}"#.to_owned()),
        );

        let scan = scan_for_test(&root, Vec::new());
        save_cleanup_scan_snapshot_cache_at(&cache_path, &scan, 1_234).unwrap();
        let serialized = load_cleanup_scan_cache(&cache_path).unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            payload["version"].as_u64(),
            Some(u64::from(CLEANUP_SCAN_CACHE_VERSION)),
        );
        assert_eq!(
            payload["snapshot"]["sampledAtMs"].as_u64(),
            Some(scan.sampled_at_ms),
        );
        assert_eq!(payload["savedAtMs"].as_u64(), Some(1_234));

        remove_cleanup_scan_cache(&cache_path).unwrap();
        assert_eq!(load_cleanup_scan_cache(&cache_path).unwrap(), None);

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_spotlight_last_used_dates_without_timezone_drift() {
        assert_eq!(
            parse_mdls_timestamp("kMDItemLastUsedDate = 1970-01-01 00:00:00 +0000"),
            Some(0),
        );
        assert_eq!(
            parse_mdls_timestamp("kMDItemLastUsedDate = 1970-01-01 08:00:00 +0800"),
            Some(0),
        );
        assert_eq!(parse_mdls_timestamp("kMDItemLastUsedDate = (null)"), None,);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_application_sizes_with_spaces_in_paths() {
        let sizes = parse_application_sizes(
            "1024\t/Applications/Example App.app\n2\t/Applications/Tiny.app\n",
        );
        assert_eq!(
            sizes.get(Path::new("/Applications/Example App.app")),
            Some(&(1_024 * 1_024)),
        );
        assert_eq!(sizes.get(Path::new("/Applications/Tiny.app")), Some(&2_048));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reuses_application_sizes_collected_by_the_exact_scan() {
        let path = PathBuf::from("/Applications/Example.app");
        let observed = HashMap::from([(path.clone(), 42_000)]);

        let sizes = application_sizes(
            std::slice::from_ref(&path),
            &observed,
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(sizes.get(&path), Some(&42_000));
        assert_eq!(
            application_bundle_for_path(
                Path::new("/Applications/Example.app/Contents/MacOS/example"),
                Path::new("/Users/example"),
            ),
            Some(path),
        );
        assert_eq!(
            application_bundle_for_path(
                Path::new("/Users/example/Applications/Home.app/Contents/home"),
                Path::new("/Users/example"),
            ),
            Some(PathBuf::from("/Users/example/Applications/Home.app")),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn child_watchdog_terminates_a_stuck_process_group() {
        let cancelled = AtomicBool::new(false);
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("trap '' TERM; sleep 30");
        let started_at = Instant::now();

        let error =
            run_bounded_child(&mut command, &cancelled, Duration::from_millis(75)).unwrap_err();

        assert_eq!(error, ChildCommandFailure::DeadlineExceeded);
        assert!(started_at.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn child_watchdog_observes_scan_cancellation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let worker = thread::spawn(move || {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg("sleep 30");
            run_bounded_child(&mut command, &worker_cancelled, Duration::from_secs(10))
        });
        thread::sleep(Duration::from_millis(75));
        let cancellation_started_at = Instant::now();
        cancelled.store(true, Ordering::Relaxed);

        assert_eq!(
            worker.join().unwrap().unwrap_err(),
            ChildCommandFailure::Cancelled
        );
        assert!(cancellation_started_at.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn child_watchdog_refuses_output_over_the_limit() {
        let cancelled = AtomicBool::new(false);
        let mut command = Command::new("/usr/bin/yes");

        let error =
            run_bounded_child(&mut command, &cancelled, Duration::from_secs(2)).unwrap_err();

        assert!(matches!(
            error,
            ChildCommandFailure::OutputLimitExceeded | ChildCommandFailure::UnsuccessfulExit
        ));
    }

    #[test]
    fn scans_categories_and_keeps_large_files_as_review_only_evidence() {
        let root = test_root("scan");
        let downloads = root.join("Downloads");
        let trash = root.join("Trash");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&trash).unwrap();
        fs::write(
            downloads.join("large.zip"),
            vec![0_u8; usize::try_from(LARGE_FILE_THRESHOLD_BYTES + 1).unwrap()],
        )
        .unwrap();
        fs::write(trash.join("old.txt"), b"old").unwrap();

        let scan = scan_for_test(
            &root,
            vec![
                LocationDefinition {
                    kind: CleanupLocationKind::Downloads,
                    paths: vec![downloads],
                    safety: CleanupSafety::Review,
                },
                LocationDefinition {
                    kind: CleanupLocationKind::Trash,
                    paths: vec![trash],
                    safety: CleanupSafety::Reclaimable,
                },
            ],
        );

        assert_eq!(scan.locations.len(), 2);
        assert_eq!(scan.locations[0].item_count, 1);
        assert_eq!(scan.locations[0].safety, CleanupSafety::Review);
        assert!(scan.locations[1].size_bytes >= 3);
        assert_eq!(scan.locations[0].nodes.len(), 1);
        assert_eq!(scan.locations[0].nodes[0].children.len(), 1);
        assert_eq!(scan.locations[1].nodes[0].logical_size_bytes, 3);
        assert_eq!(
            scan.locations[1].nodes[0].size_bytes,
            scan.locations[1].nodes[0].allocated_size_bytes,
        );
        assert_eq!(
            scan.locations[0].nodes[0].children[0].kind,
            CleanupNodeKind::File,
        );
        assert!(
            scan.largest_files
                .iter()
                .any(|file| file.name == "large.zip")
        );
        assert!(scan.deletion_available);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_a_recursive_directory_tree_with_allocated_sizes() {
        let root = test_root("recursive-tree");
        let downloads = root.join("Downloads");
        let nested = downloads.join("projects/core-robin/target");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("artifact.bin"), vec![7_u8; 8_192]).unwrap();

        let scan = scan_for_test(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
        );

        let downloads = &scan.locations[0].nodes[0];
        let projects = &downloads.children[0];
        let core_robin = &projects.children[0];
        let target = &core_robin.children[0];
        let artifact = &target.children[0];
        assert_eq!(projects.kind, CleanupNodeKind::Folder);
        assert_eq!(artifact.kind, CleanupNodeKind::File);
        assert_eq!(artifact.logical_size_bytes, 8_192);
        assert_eq!(
            downloads.allocated_size_bytes,
            artifact.allocated_size_bytes
        );
        assert_eq!(downloads.item_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_the_real_home_path_tree_separate_from_usage_categories() {
        let root = test_root("path-tree");
        let downloads = root.join("Downloads");
        let pictures = root.join("Pictures");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&pictures).unwrap();
        fs::write(downloads.join("installer.dmg"), vec![1_u8; 4_096]).unwrap();
        fs::write(pictures.join("portrait.raw"), vec![2_u8; 8_192]).unwrap();

        let scan = scan_for_test(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
        );

        assert_eq!(scan.root.path.as_deref(), Some("~"));
        assert_eq!(scan.root.item_count, 2);
        assert!(
            scan.root
                .children
                .iter()
                .any(|node| node.name == "Downloads")
        );
        assert!(
            scan.root
                .children
                .iter()
                .any(|node| node.name == "Pictures")
        );
        assert_eq!(scan.locations[0].item_count, 1);
        assert_eq!(scan.locations[0].nodes[0].name, "Downloads");
        assert!(
            scan.locations[0]
                .nodes
                .iter()
                .all(|node| node.name != "Pictures")
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scans_the_system_disk_root_while_preserving_home_display_paths() {
        let disk_root = test_root("system-disk");
        let home = disk_root.join("Users/demo");
        let downloads = home.join("Downloads");
        let shared_library = disk_root.join("Library/Application Support");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&shared_library).unwrap();
        fs::write(downloads.join("personal.bin"), vec![1_u8; 256]).unwrap();
        fs::write(shared_library.join("system-cache.bin"), vec![2_u8; 1_024]).unwrap();

        let scan = scan_filesystem(
            &disk_root,
            &home,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
            false,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();

        assert_eq!(
            scan.root.path.as_deref(),
            Some(disk_root.to_string_lossy().as_ref())
        );
        assert_eq!(
            scan.root.protection_reason,
            Some(CleanupProtectionReason::SystemLocation)
        );
        let library = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Library")
            .unwrap();
        assert!(library.deletion_protected);
        assert_eq!(
            library.protection_reason,
            Some(CleanupProtectionReason::SystemLocation)
        );
        let users = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Users")
            .unwrap();
        assert_eq!(users.children[0].path.as_deref(), Some("~"));
        assert_eq!(
            users.children[0].protection_reason,
            Some(CleanupProtectionReason::HomeRoot)
        );
        assert!(!scan.locations[0].nodes[0].deletion_protected);
        assert!(
            scan.largest_files
                .iter()
                .any(|file| file.name == "system-cache.bin")
        );
        assert_eq!(scan.locations[0].item_count, 1);

        fs::remove_dir_all(disk_root).unwrap();
    }

    #[test]
    fn expands_a_system_disk_subtree_outside_the_home_folder() {
        let disk_root = test_root("system-subtree");
        let home = disk_root.join("Users/demo");
        let shared = disk_root.join("Library/Shared");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("asset.bin"), vec![3_u8; 1_024]).unwrap();

        let node = scan_cleanup_subtree_at(
            CleanupSubtreeRequest {
                request_id: "system-subtree".to_owned(),
                path: shared.to_string_lossy().into_owned(),
                safety: CleanupSafety::Reclaimable,
            },
            &home,
            &disk_root,
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(node.name, "Shared");
        assert_eq!(node.safety, CleanupSafety::Review);
        assert_eq!(node.item_count, 1);
        assert_eq!(node.children[0].name, "asset.bin");

        fs::remove_dir_all(disk_root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn skips_cloud_backed_file_provider_roots_during_local_space_scan() {
        let root = test_root("cloud-backed-root");
        let mobile_documents = root.join("Library/Mobile Documents");
        let cloud_storage = root.join("Library/CloudStorage");
        fs::create_dir_all(mobile_documents.join("example/Documents/note.nbn")).unwrap();
        fs::create_dir_all(cloud_storage.join("Example Drive/Documents")).unwrap();
        fs::write(
            mobile_documents.join("example/Documents/note.nbn/content.bin"),
            vec![1_u8; 8_192],
        )
        .unwrap();
        fs::write(
            cloud_storage.join("Example Drive/Documents/cloud.bin"),
            vec![2_u8; 8_192],
        )
        .unwrap();

        let scan = scan_for_test(&root, Vec::new());
        let library = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Library")
            .unwrap();

        assert!(library.children.iter().any(|node| {
            node.name == "Mobile Documents" && node.kind == CleanupNodeKind::Restricted
        }));
        assert!(library.children.iter().any(|node| {
            node.name == "CloudStorage" && node.kind == CleanupNodeKind::Restricted
        }));
        assert!(
            scan.unreadable_paths
                .iter()
                .any(|path| path == "~/Library/Mobile Documents")
        );
        assert!(
            scan.unreadable_paths
                .iter()
                .any(|path| path == "~/Library/CloudStorage")
        );
        assert!(scan.largest_files.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn consolidates_visual_children_without_stopping_the_scan() {
        let root = test_root("aggregate");
        let downloads = root.join("Downloads");
        fs::create_dir_all(&downloads).unwrap();
        for index in 0..(MAX_CHART_CHILDREN + 12) {
            fs::write(downloads.join(format!("file-{index:03}.bin")), b"x").unwrap();
        }

        let scan = scan_for_test(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
        );

        let scanned_root = &scan.locations[0].nodes[0];
        assert_eq!(scanned_root.item_count, MAX_CHART_CHILDREN + 12);
        assert!(scanned_root.children.len() <= MAX_CHART_CHILDREN + 1);
        assert!(
            scanned_root
                .children
                .iter()
                .any(|node| node.kind == CleanupNodeKind::Aggregate),
        );
        assert_eq!(
            scanned_root
                .children
                .iter()
                .map(|node| node.allocated_size_bytes)
                .sum::<u64>(),
            scanned_root.allocated_size_bytes,
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caps_visual_depth_without_losing_deep_file_totals() {
        let root = test_root("bounded-depth");
        let downloads = root.join("Downloads");
        let mut nested = downloads.clone();
        for depth in 0..(MAX_VISUAL_TREE_DEPTH + 3) {
            nested = nested.join(format!("level-{depth}"));
        }
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("artifact.bin"), vec![7_u8; 8_192]).unwrap();

        let scan = scan_for_test(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
        );

        let scanned_root = &scan.locations[0].nodes[0];
        assert_eq!(scanned_root.item_count, 1);
        let mut boundary = scanned_root;
        for _ in 0..MAX_VISUAL_TREE_DEPTH.saturating_sub(1) {
            boundary = &boundary.children[0];
        }
        assert!(boundary.has_children);
        assert!(boundary.children.is_empty());
        assert_eq!(boundary.item_count, 1);
        assert_eq!(
            boundary.allocated_size_bytes,
            scanned_root.allocated_size_bytes
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prunes_visual_nodes_to_budget_without_changing_parent_totals() {
        fn folder(id: &str, children: Vec<CleanupNode>) -> CleanupNode {
            CleanupNode {
                id: id.to_owned(),
                name: id.to_owned(),
                path: Some(id.to_owned()),
                size_bytes: 100,
                logical_size_bytes: 100,
                allocated_size_bytes: 100,
                item_count: 10,
                safety: CleanupSafety::Review,
                kind: CleanupNodeKind::Folder,
                deletion_protected: false,
                protection_reason: None,
                has_children: !children.is_empty(),
                children,
            }
        }

        let branch = |prefix: &str| {
            folder(
                prefix,
                vec![
                    folder(
                        &format!("{prefix}/a"),
                        vec![folder(&format!("{prefix}/a/1"), vec![])],
                    ),
                    folder(
                        &format!("{prefix}/b"),
                        vec![folder(&format!("{prefix}/b/1"), vec![])],
                    ),
                ],
            )
        };
        let mut nodes = vec![folder(
            "root",
            vec![branch("root/left"), branch("root/right")],
        )];
        let original_size = nodes[0].allocated_size_bytes;
        let original_items = nodes[0].item_count;

        prune_cleanup_nodes(&mut nodes, 4);

        assert!(cleanup_forest_metrics(&nodes).0 <= 4);
        assert_eq!(nodes[0].allocated_size_bytes, original_size);
        assert_eq!(nodes[0].item_count, original_items);
        assert!(
            nodes[0]
                .children
                .iter()
                .any(|child| child.has_children && child.children.is_empty())
        );
    }

    #[cfg(unix)]
    #[test]
    fn counts_hard_linked_file_storage_once_per_scan_root() {
        let root = test_root("hard-link");
        let downloads = root.join("Downloads");
        fs::create_dir_all(&downloads).unwrap();
        let original = downloads.join("original.bin");
        fs::write(&original, vec![9_u8; 4_096]).unwrap();
        fs::hard_link(&original, downloads.join("alias.bin")).unwrap();

        let scan = scan_for_test(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
        );

        let scanned_root = &scan.locations[0].nodes[0];
        assert_eq!(scanned_root.item_count, 1);
        assert_eq!(scanned_root.logical_size_bytes, 4_096);
        assert_eq!(scanned_root.children.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn counts_hard_linked_storage_once_across_cleanup_categories() {
        let root = test_root("cross-category-hard-link");
        let downloads = root.join("Downloads");
        let trash = root.join("Trash");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&trash).unwrap();
        let original = downloads.join("original.bin");
        fs::write(&original, vec![9_u8; 4_096]).unwrap();
        fs::hard_link(&original, trash.join("alias.bin")).unwrap();

        let scan = scan_for_test(
            &root,
            vec![
                LocationDefinition {
                    kind: CleanupLocationKind::Downloads,
                    paths: vec![downloads],
                    safety: CleanupSafety::Review,
                },
                LocationDefinition {
                    kind: CleanupLocationKind::Trash,
                    paths: vec![trash],
                    safety: CleanupSafety::Reclaimable,
                },
            ],
        );

        assert_eq!(
            scan.locations
                .iter()
                .map(|location| location.item_count)
                .sum::<usize>(),
            1,
        );
        assert_eq!(
            scan.locations
                .iter()
                .map(|location| location.size_bytes)
                .sum::<u64>(),
            scan.locations
                .iter()
                .map(|location| location.size_bytes)
                .max()
                .unwrap_or(0),
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_confirmation_is_single_use_and_bound_to_the_selected_path() {
        let root = test_root("trash-lease");
        let target = root.join("Downloads/archive.zip");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        let display = target.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();

        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(&root, vec![display.clone()], 0),
                &root,
            )
            .unwrap();

        assert_eq!(lease.paths, vec![display.clone()]);
        assert_eq!(lease.changed_paths, vec![display.clone()]);
        assert!(!lease.executable);
        let unavailable = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                Ok(0)
            })
            .unwrap_err();
        assert_eq!(unavailable.code, "cleanup_confirmation_unavailable");

        let lease = controller
            .create_lease_for_home(
                CleanupDeleteLeaseRequest {
                    paths: vec![display.clone()],
                    scan_sampled_at_ms: lease.refreshed_at_ms,
                    expected_targets: lease.refreshed_targets,
                    mode: CleanupDeleteMode::Permanent,
                },
                &root,
            )
            .unwrap();
        assert!(lease.executable);
        assert!(lease.changed_paths.is_empty());
        let mut deleted = Vec::new();
        let result = controller
            .execute_with(
                CleanupDeleteExecutionRequest {
                    lease_id: lease.id.clone(),
                },
                |path| {
                    deleted.push(path.to_path_buf());
                    Ok(7)
                },
            )
            .unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert_eq!(result.deleted[0].path, display);
        assert_eq!(result.deleted[0].deleted_bytes, 7);
        assert_eq!(result.deleted_bytes, 7);
        assert!(result.failed.is_empty());
        assert_eq!(deleted, vec![target.canonicalize().unwrap()]);

        let error = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                Ok(0)
            })
            .unwrap_err();
        assert_eq!(error.code, "cleanup_confirmation_unavailable");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn cleanup_delete_protects_roots_but_allows_trash_contents() {
        let root = test_root("trash-protected");
        let folder = root.join("Downloads");
        let child = folder.join("file.txt");
        let trash = trash_paths(&root)
            .into_iter()
            .next()
            .expect("Unix platforms expose a cleanup Trash root");
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(&trash).unwrap();
        fs::write(&child, b"file").unwrap();
        fs::write(trash.join("old.txt"), b"old").unwrap();
        let mut controller = CleanupDeleteController::default();

        let home_error = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![root.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap_err();
        assert_eq!(home_error.code, "protected_cleanup_path");

        let trash_error = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![trash.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap_err();
        assert_eq!(trash_error.code, "protected_cleanup_path");

        let trash_item = trash.join("old.txt").to_string_lossy().into_owned();
        let trash_item_lease = controller
            .create_lease_for_home(
                cleanup_delete_request(&root, vec![trash_item.clone()], now_millis()),
                &root,
            )
            .unwrap();
        assert_eq!(trash_item_lease.paths, vec![trash_item]);
        controller.release_lease(&trash_item_lease.id);

        let overlap_error = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![
                        folder.to_string_lossy().into_owned(),
                        child.to_string_lossy().into_owned(),
                    ],
                    now_millis(),
                ),
                &root,
            )
            .unwrap_err();
        assert_eq!(overlap_error.code, "overlapping_cleanup_targets");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_protects_sensitive_user_data_but_allows_known_caches() {
        let root = test_root("sensitive-user-data");
        let ssh_key = root.join(".ssh/id_ed25519");
        let preferences = root.join("Library/Preferences/com.example.settings.plist");
        let app_cache = root.join("Library/Caches/example/cache.bin");
        let cargo_cache = root.join(".cargo/registry/cache.bin");
        for file in [&ssh_key, &preferences, &app_cache, &cargo_cache] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"fixture").unwrap();
        }
        let mut controller = CleanupDeleteController::default();

        for protected in [&ssh_key, &preferences] {
            let error = controller
                .create_lease_for_home(
                    cleanup_delete_request(
                        &root,
                        vec![protected.to_string_lossy().into_owned()],
                        now_millis(),
                    ),
                    &root,
                )
                .unwrap_err();
            assert_eq!(error.code, "protected_cleanup_path");
        }

        for cache in [&app_cache, &cargo_cache] {
            let display = cache.to_string_lossy().into_owned();
            let lease = controller
                .create_lease_for_home(
                    cleanup_delete_request(&root, vec![display.clone()], now_millis()),
                    &root,
                )
                .unwrap();
            assert_eq!(lease.paths, vec![display]);
            controller.release_lease(&lease.id);
        }

        assert_eq!(
            cleanup_protection_for_path(Path::new("/System/Library"), &root),
            Some(CleanupProtectionReason::SystemLocation)
        );
        assert_eq!(
            cleanup_protection_for_path(&root.join(".ssh"), &root),
            Some(CleanupProtectionReason::SensitiveUserData)
        );
        assert_eq!(cleanup_protection_for_path(&app_cache, &root), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_permanently_removes_files_and_directories() {
        let root = test_root("permanent-delete");
        let file = root.join("Downloads/archive.zip");
        let directory = root.join("Library/Caches/example");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(&file, b"archive").unwrap();
        fs::write(directory.join("cache.bin"), b"cache").unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![
                        file.to_string_lossy().into_owned(),
                        directory.to_string_lossy().into_owned(),
                    ],
                    now_millis(),
                ),
                &root,
            )
            .unwrap();

        let result = controller
            .execute(CleanupDeleteExecutionRequest { lease_id: lease.id })
            .unwrap();

        assert_eq!(result.deleted.len(), 2);
        assert!(result.deleted_bytes > 0);
        assert!(result.failed.is_empty());
        assert!(!file.exists());
        assert!(!directory.exists());
        assert!(root.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn cleanup_move_to_trash_preserves_collisions_and_moves_directories() {
        let root = test_root("move-to-trash");
        let file = root.join("Downloads/archive.zip");
        let directory = root.join("Library/Caches/example");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(&file, b"new archive").unwrap();
        fs::write(directory.join("cache.bin"), b"cache").unwrap();
        let trash = trash_paths(&root).into_iter().next().unwrap();
        fs::create_dir_all(&trash).unwrap();
        fs::write(trash.join("archive.zip"), b"existing archive").unwrap();
        let mut request = cleanup_delete_request(
            &root,
            vec![
                file.to_string_lossy().into_owned(),
                directory.to_string_lossy().into_owned(),
            ],
            now_millis(),
        );
        request.mode = CleanupDeleteMode::Trash;
        let mut controller = CleanupDeleteController::default();
        let lease = controller.create_lease_for_home(request, &root).unwrap();
        let mut progress_events = Vec::new();

        let result = controller
            .execute_cancellable(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                &AtomicBool::new(false),
                &mut |progress| progress_events.push(progress),
            )
            .unwrap();

        assert_eq!(lease.mode, CleanupDeleteMode::Trash);
        assert_eq!(result.deleted.len(), 2);
        assert!(result.failed.is_empty());
        assert!(!file.exists());
        assert!(!directory.exists());
        assert_eq!(
            fs::read(trash.join("archive.zip")).unwrap(),
            b"existing archive"
        );
        assert_eq!(
            fs::read(trash.join("archive (1).zip")).unwrap(),
            b"new archive"
        );
        assert_eq!(fs::read(trash.join("example/cache.bin")).unwrap(), b"cache");
        assert!(progress_events.iter().any(|progress| {
            progress.phase == CleanupDeleteProgressPhase::MovingToTrash
                && progress.completed_target_count == 2
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn cleanup_move_to_trash_rejects_a_replaced_trash_directory() {
        use std::os::unix::fs::symlink;

        let root = test_root("move-to-replaced-trash");
        let target = root.join("Downloads/archive.zip");
        let redirected = root.join("redirected-trash");
        let trash = trash_paths(&root).into_iter().next().unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::create_dir_all(&redirected).unwrap();
        fs::create_dir_all(trash.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        symlink(&redirected, &trash).unwrap();
        let mut request = cleanup_delete_request(
            &root,
            vec![target.to_string_lossy().into_owned()],
            now_millis(),
        );
        request.mode = CleanupDeleteMode::Trash;
        let mut controller = CleanupDeleteController::default();

        let error = controller
            .create_lease_for_home(request, &root)
            .unwrap_err();

        assert_eq!(error.code, "cleanup_trash_unavailable");
        assert!(target.exists());
        assert!(fs::read_dir(&redirected).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_can_stop_during_a_large_directory() {
        let root = test_root("cancel-permanent-delete");
        let target = root.join("Library/Caches/example");
        fs::create_dir_all(&target).unwrap();
        for index in 0..180 {
            fs::write(target.join(format!("cache-{index}.bin")), b"cache").unwrap();
        }
        let display_path = target.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(&root, vec![display_path.clone()], now_millis()),
                &root,
            )
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let mut progress_events = Vec::new();

        let result = controller
            .execute_cancellable(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                &cancelled,
                &mut |progress| {
                    if progress.phase == CleanupDeleteProgressPhase::Deleting
                        && progress.processed_entry_count > 0
                    {
                        cancelled.store(true, Ordering::Relaxed);
                    }
                    progress_events.push(progress);
                },
            )
            .unwrap();

        assert!(result.cancelled);
        assert_eq!(
            result.interrupted_path.as_deref(),
            Some(display_path.as_str())
        );
        assert!(result.deleted.is_empty());
        assert!(target.exists());
        assert!(fs::read_dir(&target).unwrap().count() < 180);
        assert!(progress_events.iter().any(|progress| {
            progress.phase == CleanupDeleteProgressPhase::Deleting
                && progress.total_entry_count == 0
                && progress.processed_entry_count > 0
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_cancelled_before_execution_changes_nothing() {
        let root = test_root("cancel-before-delete");
        let target = root.join("Downloads/archive.zip");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![target.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap();
        let cancelled = AtomicBool::new(true);

        let result = controller
            .execute_cancellable(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                &cancelled,
                &mut |_| {},
            )
            .unwrap();

        assert!(result.cancelled);
        assert!(result.interrupted_path.is_none());
        assert!(result.deleted.is_empty());
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_coordinator_cancels_only_the_active_operation() {
        let coordinator = CleanupDeleteCoordinator::default();
        assert!(!coordinator.cancel().unwrap());
        let cancelled = coordinator.begin().unwrap();
        assert!(coordinator.cancel().unwrap());
        assert!(cancelled.load(Ordering::Relaxed));
        coordinator.finish(&cancelled);
        assert!(!coordinator.cancel().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_delete_fails_closed_on_nested_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = test_root("delete-nested-symlink");
        let target = root.join("Library/Caches/example");
        let outside = root.join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(target.join("cache.bin"), b"cache").unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        symlink(&outside, target.join("outside-link")).unwrap();
        let mut controller = CleanupDeleteController::default();
        let error = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![target.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap_err();

        assert_eq!(error.code, "cleanup_target_unavailable");
        assert!(error.message.contains("symbolic link"));
        assert!(target.exists());
        assert!(outside.join("keep.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_delete_handles_read_only_files_inside_a_selected_directory() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_root("delete-read-only-file");
        let target = root.join("Library/Caches/example");
        let read_only_file = target.join("cache.bin");
        fs::create_dir_all(&target).unwrap();
        fs::write(&read_only_file, b"cache").unwrap();
        fs::set_permissions(&read_only_file, fs::Permissions::from_mode(0o444)).unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![target.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap();

        let result = controller
            .execute(CleanupDeleteExecutionRequest { lease_id: lease.id })
            .unwrap();

        assert_eq!(result.deleted.len(), 1);
        assert!(result.failed.is_empty());
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_revalidates_targets_after_confirmation() {
        let root = test_root("trash-revalidate");
        let target = root.join("Downloads");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("before.txt"), b"before").unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![target.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap();

        std::thread::sleep(Duration::from_millis(5));
        fs::write(target.join("after.txt"), b"after").unwrap();
        let mut attempted = false;
        let error = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                attempted = true;
                Ok(0)
            })
            .unwrap_err();

        assert_eq!(error.code, "cleanup_target_changed");
        assert!(!attempted);
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_rejects_a_deep_change_after_confirmation() {
        let root = test_root("deep-revalidate");
        let target = root.join("Downloads");
        let deep = target.join("one/two/three");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("before.txt"), b"before").unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![target.to_string_lossy().into_owned()],
                    now_millis(),
                ),
                &root,
            )
            .unwrap();
        assert!(lease.executable);

        fs::write(deep.join("after.txt"), b"after").unwrap();
        let mut attempted = false;
        let error = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                attempted = true;
                Ok(0)
            })
            .unwrap_err();

        assert_eq!(error.code, "cleanup_target_changed");
        assert!(!attempted);
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_refresh_blocks_a_deep_change_before_lease_issuance() {
        let root = test_root("deep-refresh");
        let target = root.join("Downloads");
        let deep = target.join("one/two/three");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("before.txt"), b"before").unwrap();
        let request = cleanup_delete_request(
            &root,
            vec![target.to_string_lossy().into_owned()],
            now_millis(),
        );
        fs::write(deep.join("after.txt"), b"after").unwrap();
        let mut controller = CleanupDeleteController::default();

        let lease = controller.create_lease_for_home(request, &root).unwrap();

        assert!(!lease.executable);
        assert_eq!(lease.changed_paths, lease.paths);
        assert_eq!(lease.refreshed_targets[0].item_count, 2);
        let error = controller
            .execute(CleanupDeleteExecutionRequest { lease_id: lease.id })
            .unwrap_err();
        assert_eq!(error.code, "cleanup_confirmation_unavailable");
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_reports_partial_platform_failures() {
        let root = test_root("trash-partial");
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![
                        first.to_string_lossy().into_owned(),
                        second.to_string_lossy().into_owned(),
                    ],
                    now_millis(),
                ),
                &root,
            )
            .unwrap();

        let result = controller
            .execute_with(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                |path| {
                    if path.ends_with("second.txt") {
                        Err("simulated platform refusal".to_owned())
                    } else {
                        Ok(5)
                    }
                },
            )
            .unwrap();

        assert_eq!(result.deleted.len(), 1);
        assert_eq!(result.deleted_bytes, 5);
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].path.ends_with("second.txt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_symbolic_links_instead_of_following_them() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink");
        let downloads = root.join("Downloads");
        let outside = root.join("outside");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), vec![0_u8; 128]).unwrap();
        symlink(&outside, downloads.join("linked")).unwrap();

        let scan = scan_for_test(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
        );

        assert_eq!(scan.locations[0].item_count, 0);
        assert_eq!(scan.locations[0].size_bytes, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_uncategorized_hidden_user_directories() {
        let root = test_root("hidden");
        let hidden_data = root.join(".local-state");
        let categorized_cache = root.join(".cache");
        fs::create_dir_all(&hidden_data).unwrap();
        fs::create_dir_all(&categorized_cache).unwrap();

        let paths = hidden_user_paths(&root);

        assert!(paths.contains(&hidden_data));
        assert!(!paths.contains(&categorized_cache));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_stops_before_scanning() {
        let root = test_root("cancel");
        let downloads = root.join("Downloads");
        fs::create_dir_all(&downloads).unwrap();
        fs::write(downloads.join("file"), b"data").unwrap();
        let cancelled = AtomicBool::new(true);

        let error = scan_home(
            &root,
            vec![LocationDefinition {
                kind: CleanupLocationKind::Downloads,
                paths: vec![downloads],
                safety: CleanupSafety::Review,
            }],
            false,
            &cancelled,
            &mut |_| {},
        )
        .unwrap_err();

        assert_eq!(error.code, "cleanup_scan_cancelled");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inspects_only_the_requested_cleanup_path() {
        let root = test_root("path-state");
        fs::create_dir_all(&root).unwrap();

        let present = inspect_cleanup_path(root.to_string_lossy().as_ref()).unwrap();
        assert!(present.exists);
        assert!(present.modified_at_ms.is_some());

        fs::remove_dir_all(&root).unwrap();
        let missing = inspect_cleanup_path(root.to_string_lossy().as_ref()).unwrap();
        assert!(!missing.exists);
        assert!(missing.modified_at_ms.is_none());
    }

    #[test]
    fn finds_the_application_bundle_containing_an_executable() {
        let executable = Path::new("/Applications/CoreRobin.app/Contents/MacOS/core-robin");
        assert_eq!(
            application_bundle_from_executable(executable),
            Some(PathBuf::from("/Applications/CoreRobin.app"))
        );
        assert_eq!(
            application_bundle_from_executable(Path::new("/tmp/core-robin")),
            None
        );
    }

    fn scan_for_test(root: &Path, definitions: Vec<LocationDefinition>) -> CleanupScan {
        scan_home(
            root,
            definitions,
            false,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap()
    }

    fn test_root(suffix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("core-robin-cleanup-{suffix}-{nonce}"))
    }
}
