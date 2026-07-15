use std::cmp::Reverse;
use std::collections::HashSet;
use std::env;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::process::Command;

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
    CleanupDeleteLeaseRequest, CleanupDeleteProgress, CleanupDeleteProgressPhase,
    CleanupDeleteResult, CleanupDeleteSuccess, CleanupFile, CleanupFullDiskAccessStatus,
    CleanupLocation, CleanupLocationKind, CleanupNode, CleanupNodeKind, CleanupPathState,
    CleanupSafety, CleanupScan, CleanupScanAccess, CleanupScanProgress, CleanupSubtreeRequest,
};

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
const CLEANUP_SCAN_CACHE_VERSION: u8 = 5;
static NEXT_CLEANUP_LEASE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupScanCachePayload<'a> {
    version: u8,
    saved_at_ms: u64,
    snapshot: &'a CleanupScan,
}

#[derive(Debug, Default)]
pub struct CleanupScanCoordinator {
    active: Mutex<Option<Arc<AtomicBool>>>,
}

impl CleanupScanCoordinator {
    pub fn begin(&self) -> Result<Arc<AtomicBool>, CommandError> {
        let mut active = self.active.lock().map_err(|_| {
            CommandError::internal("The cleanup scan coordinator lock was poisoned.")
        })?;
        if active.is_some() {
            return Err(CommandError::new(
                "cleanup_scan_in_progress",
                "A cleanup scan is already in progress.",
            ));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancelled));
        Ok(cancelled)
    }

    pub fn cancel(&self) -> Result<bool, CommandError> {
        let active = self.active.lock().map_err(|_| {
            CommandError::internal("The cleanup scan coordinator lock was poisoned.")
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
                "A permanent deletion is already in progress.",
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
}

#[derive(Debug)]
struct CleanupDeleteLeaseEntry {
    id: String,
    expires_at: Instant,
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
                "StatusOrbit could not locate the current user's home directory.",
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
        let targets = self.take_validated_targets(request)?;
        let total_target_count = targets.len();
        let mut inspections = Vec::with_capacity(total_target_count);
        let mut preparation_count = 0_usize;
        for target in &targets {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(cancelled_delete_result(Vec::new(), 0, Vec::new(), None));
            }
            on_progress(CleanupDeleteProgress {
                phase: CleanupDeleteProgressPhase::Preparing,
                processed_entry_count: preparation_count,
                total_entry_count: 0,
                completed_target_count: 0,
                total_target_count,
                current_path: target.display_path.clone(),
                deleted_bytes: 0,
            });
            let metadata = fs::symlink_metadata(&target.canonical_path).map_err(|error| {
                CommandError::new(
                    "cleanup_target_changed",
                    format!("{} changed before deletion: {error}", target.display_path),
                )
            })?;
            let Some(inspection) = inspect_cleanup_target(
                &target.canonical_path,
                &metadata,
                cancelled,
                &mut preparation_count,
            )
            .map_err(|message| CommandError::new("cleanup_target_unavailable", message))?
            else {
                return Ok(cancelled_delete_result(Vec::new(), 0, Vec::new(), None));
            };
            inspections.push(inspection);
        }

        let total_entry_count = inspections
            .iter()
            .map(|inspection| inspection.entry_count)
            .sum();
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
                phase: CleanupDeleteProgressPhase::Deleting,
                processed_entry_count,
                total_entry_count,
                completed_target_count: target_index,
                total_target_count,
                current_path: current_path.clone(),
                deleted_bytes,
            });
            let mut target_deleted_bytes = 0_u64;
            let result = delete_cleanup_target_cancellable(
                &target.canonical_path,
                cancelled,
                &mut |entry_deleted_bytes| {
                    processed_entry_count = processed_entry_count.saturating_add(1);
                    target_deleted_bytes = target_deleted_bytes.saturating_add(entry_deleted_bytes);
                    deleted_bytes = deleted_bytes.saturating_add(entry_deleted_bytes);
                    if processed_entry_count == total_entry_count
                        || processed_entry_count.saturating_sub(last_emitted_entry_count) >= 128
                        || last_emitted_at.elapsed() >= Duration::from_millis(100)
                    {
                        on_progress(CleanupDeleteProgress {
                            phase: CleanupDeleteProgressPhase::Deleting,
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
                },
            );
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
                phase: CleanupDeleteProgressPhase::Deleting,
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
        let changed_paths = targets
            .iter()
            .filter(|target| {
                target
                    .modified_at_ms
                    .is_some_and(|modified| modified > request.scan_sampled_at_ms)
            })
            .map(|target| target.display_path.clone())
            .collect::<Vec<_>>();
        let id = next_cleanup_lease_id();
        let expires_at = now + CLEANUP_LEASE_TTL;
        self.leases.push(CleanupDeleteLeaseEntry {
            id: id.clone(),
            expires_at,
            targets: targets.clone(),
        });
        Ok(CleanupDeleteLease {
            id,
            paths: targets
                .iter()
                .map(|target| target.display_path.clone())
                .collect(),
            changed_paths,
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
        let targets = self.take_validated_targets(request)?;
        let mut deleted = Vec::new();
        let mut deleted_bytes = 0_u64;
        let mut failed = Vec::new();
        for target in targets {
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
    ) -> Result<Vec<CleanupDeleteTarget>, CommandError> {
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
        Ok(lease.targets)
    }
}

#[derive(Clone, Copy, Debug)]
struct CleanupDeleteInspection {
    entry_count: usize,
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
            "StatusOrbit could not locate the current user's home directory.",
        )
    })?;
    let scan_root = system_disk_root(&home).ok_or_else(|| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            "StatusOrbit could not locate the system disk root.",
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

pub fn scan_cleanup_subtree(request: CleanupSubtreeRequest) -> Result<CleanupNode, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "StatusOrbit could not locate the current user's home directory.",
        )
    })?;
    let scan_root = system_disk_root(&home).ok_or_else(|| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            "StatusOrbit could not locate the system disk root.",
        )
    })?;
    scan_cleanup_subtree_at(request, &home, &scan_root)
}

fn scan_cleanup_subtree_at(
    request: CleanupSubtreeRequest,
    home: &Path,
    scan_root: &Path,
) -> Result<CleanupNode, CommandError> {
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("StatusOrbit could not verify the home directory: {error}"),
        )
    })?;
    let canonical_scan_root = scan_root.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("StatusOrbit could not verify the system disk root: {error}"),
        )
    })?;
    let boundary = ScanFilesystemBoundary::for_root(&canonical_scan_root)?;
    let requested_path = expand_cleanup_path(&request.path, &canonical_home)?;
    let metadata = fs::symlink_metadata(&requested_path).map_err(|error| {
        CommandError::new(
            "cleanup_subtree_unavailable",
            format!("StatusOrbit could not inspect {}: {error}", request.path),
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
            format!("StatusOrbit could not verify {}: {error}", request.path),
        )
    })?;
    if !path.starts_with(&canonical_scan_root) {
        return Err(CommandError::new(
            "cleanup_subtree_outside_disk",
            "StatusOrbit only expands folders on the system disk.",
        ));
    }
    if !boundary.allows_directory(&metadata) {
        return Err(CommandError::new(
            "cleanup_subtree_outside_disk",
            "StatusOrbit does not expand another disk or mounted filesystem from this map.",
        ));
    }

    let cancelled = AtomicBool::new(false);
    let mut stats = ScanStats::new();
    let mut largest_files = Vec::new();
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
        cancelled: &cancelled,
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
        return CleanupScanAccess {
            full_disk_access,
            full_disk_access_recommended: true,
            application_bundle_available: application_bundle.is_some(),
            application_bundle_path: application_bundle
                .map(|path| path.to_string_lossy().into_owned()),
        };
    }

    #[cfg(not(target_os = "macos"))]
    CleanupScanAccess {
        full_disk_access: CleanupFullDiskAccessStatus::NotRequired,
        full_disk_access_recommended: false,
        application_bundle_available: false,
        application_bundle_path: None,
    }
}

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
                    "StatusOrbit could not open Full Disk Access settings: {error}"
                ))
            })?;
        if status.success() {
            return Ok(());
        }
        return Err(CommandError::internal(
            "macOS did not open Full Disk Access settings.",
        ));
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
                "StatusOrbit must be launched from its application bundle before it can be added to Full Disk Access.",
            )
        })?;
        let status = Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&application_bundle)
            .status()
            .map_err(|error| {
                CommandError::internal(format!(
                    "StatusOrbit could not reveal its application bundle: {error}"
                ))
            })?;
        if status.success() {
            return Ok(());
        }
        return Err(CommandError::internal(
            "macOS did not reveal the StatusOrbit application bundle.",
        ));
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
            "StatusOrbit could not locate the current user's home directory.",
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
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CommandError::internal(format!(
                "Could not inspect the cleanup scan cache: {error}"
            )));
        }
    };
    if metadata.len() > MAX_CLEANUP_SCAN_CACHE_BYTES {
        remove_cleanup_scan_cache(path)?;
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|error| {
        CommandError::internal(format!("Could not read the cleanup scan cache: {error}"))
    })
}

pub fn save_cleanup_scan_cache(path: &Path, serialized: &str) -> Result<(), CommandError> {
    if u64::try_from(serialized.len()).unwrap_or(u64::MAX) > MAX_CLEANUP_SCAN_CACHE_BYTES {
        return Err(CommandError::new(
            "cleanup_scan_cache_too_large",
            "The cleanup scan cache is too large to retain safely.",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        CommandError::internal("The cleanup scan cache path has no parent directory.")
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        CommandError::internal(format!(
            "Could not create the cleanup scan cache folder: {error}"
        ))
    })?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, serialized).map_err(|error| {
        CommandError::internal(format!("Could not write the cleanup scan cache: {error}"))
    })?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            CommandError::internal(format!("Could not replace the cleanup scan cache: {error}"))
        })?;
    }
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        CommandError::internal(format!(
            "Could not finalize the cleanup scan cache: {error}"
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
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::internal(format!(
            "Could not clear the cleanup scan cache: {error}"
        ))),
    }
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
            format!("StatusOrbit could not verify the home directory: {error}"),
        )
    })?;
    #[cfg(unix)]
    let home_device = fs::metadata(&canonical_home)
        .map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("StatusOrbit could not inspect the home filesystem: {error}"),
            )
        })?
        .dev();
    let trash_roots = trash_paths(&canonical_home);
    let mut seen = HashSet::new();
    let mut targets = Vec::with_capacity(request.paths.len());
    for display in &request.paths {
        let path = expand_cleanup_path(display, &canonical_home)?;
        if path == canonical_home || trash_roots.contains(&path) {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "StatusOrbit will not delete the home directory or the system Trash folder itself.",
            ));
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            CommandError::new(
                "cleanup_target_unavailable",
                format!("StatusOrbit could not inspect {display}: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err(CommandError::new(
                "unsupported_cleanup_target",
                format!("StatusOrbit will not delete links or special files: {display}"),
            ));
        }
        #[cfg(unix)]
        if metadata.is_dir() && metadata.dev() != home_device {
            return Err(CommandError::new(
                "cleanup_cross_filesystem",
                format!("StatusOrbit will not recursively delete a mounted filesystem: {display}"),
            ));
        }
        #[cfg(windows)]
        if metadata.is_dir() && is_windows_reparse_point(&metadata) {
            return Err(CommandError::new(
                "cleanup_cross_filesystem",
                format!("StatusOrbit will not recursively delete a reparse point: {display}"),
            ));
        }
        let canonical_path = path.canonicalize().map_err(|error| {
            CommandError::new(
                "cleanup_target_unavailable",
                format!("StatusOrbit could not verify {display}: {error}"),
            )
        })?;
        if canonical_path == canonical_home || trash_roots.contains(&canonical_path) {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "StatusOrbit will not delete the home directory or the system Trash folder itself.",
            ));
        }
        if !canonical_path.starts_with(&canonical_home) {
            return Err(CommandError::new(
                "cleanup_target_outside_home",
                format!("StatusOrbit only deletes items inside your home folder: {display}"),
            ));
        }
        if !seen.insert(canonical_path.clone()) {
            return Err(CommandError::new(
                "duplicate_cleanup_target",
                format!("The cleanup selection contains the same item more than once: {display}"),
            ));
        }
        targets.push(CleanupDeleteTarget {
            display_path: display.clone(),
            canonical_path,
            modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
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
            format!("StatusOrbit could not resolve this cleanup path: {display_path}"),
        ));
    }
    Ok(path)
}

fn revalidate_cleanup_target(target: &CleanupDeleteTarget) -> Result<(), CommandError> {
    let metadata = fs::symlink_metadata(&target.canonical_path).map_err(|error| {
        CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; StatusOrbit deleted nothing. Review the selection again: {error}",
                target.display_path
            ),
        )
    })?;
    if metadata.file_type().is_symlink()
        || target.canonical_path.canonicalize().ok().as_ref() != Some(&target.canonical_path)
        || metadata.modified().ok().and_then(system_time_millis) != target.modified_at_ms
    {
        return Err(CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; StatusOrbit deleted nothing. Review the selection again.",
                target.display_path
            ),
        ));
    }
    Ok(())
}

fn inspect_cleanup_target(
    root: &Path,
    root_metadata: &Metadata,
    cancelled: &AtomicBool,
    processed_entry_count: &mut usize,
) -> Result<Option<CleanupDeleteInspection>, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if root_metadata.file_type().is_symlink() {
        return Err("StatusOrbit will not delete symbolic links.".to_owned());
    }
    if root_metadata.is_file() {
        *processed_entry_count = processed_entry_count.saturating_add(1);
        return Ok(Some(CleanupDeleteInspection { entry_count: 1 }));
    }
    if !root_metadata.is_dir() {
        return Err("StatusOrbit will not delete special files.".to_owned());
    }

    #[cfg(unix)]
    let root_device = root_metadata.dev();
    #[cfg(not(unix))]
    let _ = root_metadata;
    let mut entry_count = 1_usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let entries = fs::read_dir(&directory).map_err(|error| {
            format!(
                "StatusOrbit could not verify {} before deletion: {error}",
                directory.display()
            )
        })?;
        for entry in entries {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(None);
            }
            let entry = entry.map_err(|error| {
                format!(
                    "StatusOrbit could not read {} before deletion: {error}",
                    directory.display()
                )
            })?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                format!(
                    "StatusOrbit could not verify {} before deletion: {error}",
                    path.display()
                )
            })?;
            entry_count = entry_count.saturating_add(1);
            *processed_entry_count = processed_entry_count.saturating_add(1);
            if metadata.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            if is_windows_reparse_point(&metadata) {
                return Err(format!(
                    "StatusOrbit refused to delete {} because it contains a Windows reparse point.",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                #[cfg(unix)]
                if cleanup_filesystem_changed(root_device, metadata.dev()) {
                    return Err(format!(
                        "StatusOrbit refused to delete {} because it crosses into another mounted filesystem.",
                        path.display()
                    ));
                }
                stack.push(path);
            } else if !metadata.is_file() {
                return Err(format!(
                    "StatusOrbit refused to delete {} because it is a special file.",
                    path.display()
                ));
            }
        }
    }
    *processed_entry_count = processed_entry_count.saturating_add(1);
    Ok(Some(CleanupDeleteInspection { entry_count }))
}

enum CleanupDeleteWorkItem {
    Visit(PathBuf),
    RemoveDirectory(PathBuf),
}

fn delete_cleanup_target_cancellable(
    root: &Path,
    cancelled: &AtomicBool,
    on_entry_deleted: &mut dyn FnMut(u64),
) -> Result<bool, String> {
    let root_metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if root_metadata.file_type().is_symlink() {
        return Err("StatusOrbit will not delete symbolic links.".to_owned());
    }
    #[cfg(unix)]
    let root_device = root_metadata.dev();
    #[cfg(not(unix))]
    let _ = &root_metadata;

    let mut seen_files = HashSet::new();
    let mut stack = vec![CleanupDeleteWorkItem::Visit(root.to_path_buf())];
    while let Some(work_item) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        match work_item {
            CleanupDeleteWorkItem::Visit(path) => {
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    format!(
                        "StatusOrbit could not verify {} during deletion: {error}",
                        path.display()
                    )
                })?;
                if metadata.file_type().is_symlink() || metadata.is_file() {
                    let deleted_bytes = if metadata.is_file()
                        && should_count_file(&path, &metadata, &mut seen_files)
                    {
                        allocated_file_size(&path, &metadata)
                    } else {
                        0
                    };
                    fs::remove_file(&path).map_err(|error| {
                        format!("StatusOrbit could not delete {}: {error}", path.display())
                    })?;
                    on_entry_deleted(deleted_bytes);
                } else if metadata.is_dir() {
                    #[cfg(windows)]
                    if is_windows_reparse_point(&metadata) {
                        return Err(format!(
                            "StatusOrbit refused to delete {} because it is a Windows reparse point.",
                            path.display()
                        ));
                    }
                    #[cfg(unix)]
                    if cleanup_filesystem_changed(root_device, metadata.dev()) {
                        return Err(format!(
                            "StatusOrbit refused to delete {} because it crosses into another mounted filesystem.",
                            path.display()
                        ));
                    }
                    let entries = fs::read_dir(&path).map_err(|error| {
                        format!(
                            "StatusOrbit could not read {} during deletion: {error}",
                            path.display()
                        )
                    })?;
                    let mut children = Vec::new();
                    for entry in entries {
                        if cancelled.load(Ordering::Relaxed) {
                            return Ok(false);
                        }
                        children.push(
                            entry
                                .map_err(|error| {
                                    format!(
                                        "StatusOrbit could not read {} during deletion: {error}",
                                        path.display()
                                    )
                                })?
                                .path(),
                        );
                    }
                    stack.push(CleanupDeleteWorkItem::RemoveDirectory(path));
                    stack.extend(children.into_iter().rev().map(CleanupDeleteWorkItem::Visit));
                } else {
                    return Err(format!(
                        "StatusOrbit refused to delete {} because it is a special file.",
                        path.display()
                    ));
                }
            }
            CleanupDeleteWorkItem::RemoveDirectory(path) => {
                fs::remove_dir(&path).map_err(|error| {
                    format!("StatusOrbit could not delete {}: {error}", path.display())
                })?;
                on_entry_deleted(0);
            }
        }
    }
    Ok(true)
}

#[cfg(unix)]
fn cleanup_filesystem_changed(root_device: u64, candidate_device: u64) -> bool {
    root_device != candidate_device
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[derive(Clone, Debug)]
struct LocationDefinition {
    kind: CleanupLocationKind,
    paths: Vec<PathBuf>,
    safety: CleanupSafety,
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
                format!("StatusOrbit could not inspect the system disk root: {error}"),
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
            return metadata.dev() == self.device;
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
        scan_installed_applications(home, cancelled, &mut stats, on_progress)?
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

    let sizes = application_sizes(&paths);
    ensure_scan_active(cancelled)?;
    let last_used = application_last_used_times(&paths);
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
    Ok((applications, true))
}

#[cfg(not(target_os = "macos"))]
fn scan_installed_applications(
    _home: &Path,
    cancelled: &AtomicBool,
    _stats: &mut ScanStats,
    _on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<(Vec<CleanupApplication>, bool), CommandError> {
    ensure_scan_active(cancelled)?;
    Ok((Vec::new(), false))
}

#[cfg(target_os = "macos")]
fn application_sizes(paths: &[PathBuf]) -> HashMap<PathBuf, u64> {
    if paths.is_empty() {
        return HashMap::new();
    }
    let Ok(output) = Command::new("/usr/bin/du").arg("-sk").args(paths).output() else {
        return HashMap::new();
    };
    parse_application_sizes(&String::from_utf8_lossy(&output.stdout))
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
fn application_last_used_times(paths: &[PathBuf]) -> Vec<Option<u64>> {
    if paths.is_empty() {
        return Vec::new();
    }
    let Ok(output) = Command::new("/usr/bin/mdls")
        .arg("-name")
        .arg("kMDItemLastUsedDate")
        .args(paths)
        .output()
    else {
        return vec![None; paths.len()];
    };
    let mut values = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(parse_mdls_timestamp)
        .collect::<Vec<_>>();
    if values.len() != paths.len() {
        return vec![None; paths.len()];
    }
    values.resize(paths.len(), None);
    values.truncate(paths.len());
    values
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

fn platform_paths(home: &Path) -> Vec<LocationDefinition> {
    vec![
        LocationDefinition {
            kind: CleanupLocationKind::Downloads,
            paths: vec![home.join("Downloads")],
            safety: CleanupSafety::Review,
        },
        LocationDefinition {
            kind: CleanupLocationKind::Trash,
            paths: trash_paths(home),
            safety: CleanupSafety::Reclaimable,
        },
        LocationDefinition {
            kind: CleanupLocationKind::AppCache,
            paths: app_cache_paths(home),
            safety: CleanupSafety::Reclaimable,
        },
        LocationDefinition {
            kind: CleanupLocationKind::DeveloperCache,
            paths: developer_cache_paths(home),
            safety: CleanupSafety::Reclaimable,
        },
        LocationDefinition {
            kind: CleanupLocationKind::HiddenData,
            paths: hidden_user_paths(home),
            safety: CleanupSafety::Review,
        },
    ]
}

#[cfg(target_os = "macos")]
fn trash_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".Trash")]
}

#[cfg(target_os = "linux")]
fn trash_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".local/share/Trash/files")]
}

#[cfg(windows)]
fn trash_paths(_home: &Path) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn app_cache_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join("Library/Caches")]
}

#[cfg(target_os = "linux")]
fn app_cache_paths(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".cache")]
}

#[cfg(windows)]
fn app_cache_paths(_home: &Path) -> Vec<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| vec![path.join("Temp")])
        .unwrap_or_default()
}

fn developer_cache_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        home.join(".cargo/registry"),
        home.join(".cargo/git"),
        home.join(".npm/_cacache"),
        home.join(".pnpm-store"),
        home.join(".yarn/berry/cache"),
        home.join(".gradle/caches"),
        home.join(".m2/repository"),
        home.join(".bun/install/cache"),
        home.join(".rustup/downloads"),
        home.join(".rustup/tmp"),
    ];
    #[cfg(not(target_os = "linux"))]
    paths.push(home.join(".cache"));
    #[cfg(target_os = "macos")]
    {
        paths.push(home.join("Library/Developer/Xcode/DerivedData"));
        paths.push(home.join("Library/pnpm/store"));
    }
    #[cfg(target_os = "linux")]
    {
        paths.push(home.join(".local/share/pnpm/store"));
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local_app_data).join("pnpm/store"));
        }
    }
    paths
}

fn hidden_user_paths(home: &Path) -> Vec<PathBuf> {
    const CATEGORIZED_DIRECTORIES: &[&str] = &[
        ".Trash",
        ".bun",
        ".cache",
        ".cargo",
        ".gradle",
        ".local",
        ".m2",
        ".npm",
        ".pnpm-store",
        ".rustup",
        ".yarn",
    ];

    let Ok(entries) = fs::read_dir(home) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            if !name.starts_with('.') || CATEGORIZED_DIRECTORIES.contains(&name) {
                return None;
            }
            let file_type = entry.file_type().ok()?;
            (file_type.is_dir() && !file_type.is_symlink()).then(|| entry.path())
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
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
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[cfg(unix)]
    #[test]
    fn cleanup_mount_guard_detects_a_device_boundary() {
        assert!(!cleanup_filesystem_changed(7, 7));
        assert!(cleanup_filesystem_changed(7, 8));
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
        let nested = downloads.join("projects/status-orbit/target");
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
        let status_orbit = &projects.children[0];
        let target = &status_orbit.children[0];
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
        assert!(scan.root.children.iter().any(|node| node.name == "Library"));
        let users = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Users")
            .unwrap();
        assert_eq!(users.children[0].path.as_deref(), Some("~"));
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
                path: shared.to_string_lossy().into_owned(),
                safety: CleanupSafety::Reclaimable,
            },
            &home,
            &disk_root,
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
                CleanupDeleteLeaseRequest {
                    paths: vec![display.clone()],
                    scan_sampled_at_ms: 0,
                },
                &root,
            )
            .unwrap();

        assert_eq!(lease.paths, vec![display.clone()]);
        assert_eq!(lease.changed_paths, vec![display.clone()]);
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
                CleanupDeleteLeaseRequest {
                    paths: vec![root.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(home_error.code, "protected_cleanup_path");

        let trash_error = controller
            .create_lease_for_home(
                CleanupDeleteLeaseRequest {
                    paths: vec![trash.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(trash_error.code, "protected_cleanup_path");

        let trash_item = trash.join("old.txt").to_string_lossy().into_owned();
        let trash_item_lease = controller
            .create_lease_for_home(
                CleanupDeleteLeaseRequest {
                    paths: vec![trash_item.clone()],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap();
        assert_eq!(trash_item_lease.paths, vec![trash_item]);
        controller.release_lease(&trash_item_lease.id);

        let overlap_error = controller
            .create_lease_for_home(
                CleanupDeleteLeaseRequest {
                    paths: vec![
                        folder.to_string_lossy().into_owned(),
                        child.to_string_lossy().into_owned(),
                    ],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(overlap_error.code, "overlapping_cleanup_targets");
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
                CleanupDeleteLeaseRequest {
                    paths: vec![
                        file.to_string_lossy().into_owned(),
                        directory.to_string_lossy().into_owned(),
                    ],
                    scan_sampled_at_ms: now_millis(),
                },
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
                CleanupDeleteLeaseRequest {
                    paths: vec![display_path.clone()],
                    scan_sampled_at_ms: now_millis(),
                },
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
                        && progress.processed_entry_count >= 128
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
                && progress.total_entry_count == 181
                && progress.processed_entry_count >= 128
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
                CleanupDeleteLeaseRequest {
                    paths: vec![target.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
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
    fn cleanup_delete_does_not_follow_nested_symbolic_links() {
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
        let lease = controller
            .create_lease_for_home(
                CleanupDeleteLeaseRequest {
                    paths: vec![target.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap();

        let result = controller
            .execute(CleanupDeleteExecutionRequest { lease_id: lease.id })
            .unwrap();

        assert_eq!(result.deleted.len(), 1);
        assert!(!target.exists());
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
                CleanupDeleteLeaseRequest {
                    paths: vec![target.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
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
                CleanupDeleteLeaseRequest {
                    paths: vec![target.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
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
                CleanupDeleteLeaseRequest {
                    paths: vec![
                        first.to_string_lossy().into_owned(),
                        second.to_string_lossy().into_owned(),
                    ],
                    scan_sampled_at_ms: now_millis(),
                },
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
        let executable = Path::new("/Applications/StatusOrbit.app/Contents/MacOS/status-orbit");
        assert_eq!(
            application_bundle_from_executable(executable),
            Some(PathBuf::from("/Applications/StatusOrbit.app"))
        );
        assert_eq!(
            application_bundle_from_executable(Path::new("/tmp/status-orbit")),
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
        env::temp_dir().join(format!("status-orbit-cleanup-{suffix}-{nonce}"))
    }
}
