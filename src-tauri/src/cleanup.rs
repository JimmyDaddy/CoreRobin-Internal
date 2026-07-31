use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::env;
#[cfg(all(target_os = "macos", not(test)))]
use std::ffi::CString;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
#[cfg(all(target_os = "macos", not(test)))]
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use serde::Deserialize;
use serde::Serialize;

#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(all(target_os = "macos", not(test)))]
use std::os::unix::ffi::OsStrExt;
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

#[cfg(target_os = "macos")]
use crate::application_metadata::bundle_display_name;
use crate::error::CommandError;
#[cfg(target_os = "macos")]
use crate::models::{ApplicationArtifactKind, ApplicationUninstallArtifact, InstalledApplication};
use crate::models::{
    ApplicationInventorySnapshot, ApplicationUninstallPlan, CleanupApplication,
    CleanupDeleteExecutionRequest, CleanupDeleteFailure, CleanupDeleteLease,
    CleanupDeleteLeaseModeRequest, CleanupDeleteLeaseRequest, CleanupDeleteMode,
    CleanupDeleteProgress, CleanupDeleteProgressPhase, CleanupDeleteResult, CleanupDeleteSuccess,
    CleanupDeleteTargetEvidence, CleanupFile, CleanupFullDiskAccessStatus, CleanupLocation,
    CleanupNode, CleanupNodeKind, CleanupPathState, CleanupProtectionReason, CleanupSafety,
    CleanupScan, CleanupScanAccess, CleanupScanProfile, CleanupScanProgress, CleanupScanRequest,
    CleanupScanTargetKind,
};
use crate::private_storage;
#[cfg(all(target_os = "macos", not(test)))]
use crate::safe_fs::BoundTargetKind;
use crate::safe_fs::{BoundDeleteTarget, DeleteRoot, TreeInspection};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::ProtocolObject;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};
#[cfg(all(target_os = "macos", not(test)))]
use objc2_foundation::{NSFileManager, NSURL};

mod index;
mod paths;
mod protection;

pub(crate) use index::{
    apply_indexed_deletions, build_indexed_scan, cleanup_index_summary, load_indexed_children,
    load_indexed_directory, load_indexed_scan, load_latest_indexed_scan, refresh_indexed_directory,
    remove_cleanup_index, resolve_indexed_delete_request,
};
use paths::{LocationDefinition, platform_paths, trash_paths};
use protection::{
    cleanup_protection_for_path, cleanup_protection_for_selected_scan_path,
    temporary_cleanup_boundary_for_path,
};

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
// 0.5 degree of a full circle. Smaller siblings are still fully scanned, but
// are consolidated so the WebView receives a useful hierarchy instead of
// hundreds of thousands of unclickable slivers.
const MIN_CHART_FRACTION_DENOMINATOR: u128 = 720;
const PROGRESS_INTERVAL_ENTRIES: usize = 512;
const MAX_CLEANUP_TARGETS: usize = 32;
const MAX_CLEANUP_LEASES: usize = 8;
#[cfg(target_os = "macos")]
const MAX_APPLICATION_INVENTORY_CACHE_BYTES: u64 = 8 * 1_024 * 1_024;
#[cfg(target_os = "macos")]
const APPLICATION_INVENTORY_CACHE_VERSION: u8 = 2;
#[cfg(target_os = "macos")]
const APPLICATION_INVENTORY_CACHE_STALE_AFTER_MS: u64 = 24 * 60 * 60 * 1_000;
#[cfg(target_os = "macos")]
const APPLICATION_INVENTORY_CACHE_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
#[cfg(target_os = "macos")]
const APPLICATION_CHILD_OUTPUT_LIMIT: usize = 4 * 1_024 * 1_024;
#[cfg(target_os = "macos")]
const APPLICATION_DU_DEADLINE: Duration = Duration::from_secs(30);
#[cfg(target_os = "macos")]
const APPLICATION_MDLS_DEADLINE: Duration = Duration::from_secs(15);
#[cfg(target_os = "macos")]
const APPLICATION_CHILD_POLL_INTERVAL: Duration = Duration::from_millis(25);
static NEXT_CLEANUP_LEASE_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ApplicationInventoryFingerprintEntry {
    path: String,
    bundle_modified_at_ms: Option<u64>,
    info_plist_modified_at_ms: Option<u64>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationInventoryCachePayload {
    version: u8,
    language: String,
    saved_at_ms: u64,
    fingerprint: Vec<ApplicationInventoryFingerprintEntry>,
    snapshot: ApplicationInventorySnapshot,
}

#[cfg(target_os = "macos")]
struct CleanupScanActivity {
    process_info: Retained<NSProcessInfo>,
    activity: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

#[cfg(target_os = "macos")]
impl CleanupScanActivity {
    fn begin() -> Self {
        let process_info = NSProcessInfo::processInfo();
        let reason = NSString::from_str("CoreRobin space cleanup scan");
        let activity = process_info.beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &reason,
        );
        Self {
            process_info,
            activity,
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for CleanupScanActivity {
    fn drop(&mut self) {
        // SAFETY: `activity` is the exact retained token returned by this
        // `NSProcessInfo` instance and is ended once when the guard is dropped.
        unsafe {
            self.process_info.endActivity(&self.activity);
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
    evidence: CleanupDeleteTargetEvidence,
    inspection: Option<TreeInspection>,
    inspection_policy: CleanupTargetInspectionPolicy,
    bound: BoundDeleteTarget,
}

#[derive(Debug)]
struct CleanupTargetValidation {
    targets: Vec<CleanupDeleteTarget>,
    missing_paths: Vec<String>,
    unavailable_failures: Vec<CleanupDeleteFailure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupTargetInspectionPolicy {
    CleanupBasket,
    #[cfg(target_os = "macos")]
    Strict,
    #[cfg(target_os = "macos")]
    ApplicationBundle,
}

impl CleanupTargetInspectionPolicy {
    fn inspect(self, target: &BoundDeleteTarget) -> Result<TreeInspection, String> {
        match self {
            Self::CleanupBasket => target.inspect_allowing_internal_symlinks(),
            #[cfg(target_os = "macos")]
            Self::Strict => target.inspect(),
            #[cfg(target_os = "macos")]
            Self::ApplicationBundle => target.inspect_allowing_internal_symlinks(),
        }
    }

    fn delete_cancellable(
        self,
        target: BoundDeleteTarget,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
    ) -> Result<bool, String> {
        match self {
            Self::CleanupBasket => {
                target.delete_cancellable_allowing_internal_symlinks(cancelled, on_entry_deleted)
            }
            #[cfg(target_os = "macos")]
            Self::Strict => target.delete_cancellable(cancelled, on_entry_deleted),
            #[cfg(target_os = "macos")]
            Self::ApplicationBundle => {
                target.delete_cancellable_allowing_internal_symlinks(cancelled, on_entry_deleted)
            }
        }
    }
}

#[derive(Debug)]
struct CleanupDeleteLeaseEntry {
    id: String,
    refreshed_at_ms: u64,
    mode: CleanupDeleteMode,
    trash_destination: Option<CleanupTrashDestination>,
    paths: Vec<String>,
    missing_paths: Vec<String>,
    unavailable_failures: Vec<CleanupDeleteFailure>,
    targets: Vec<CleanupDeleteTarget>,
}

#[derive(Debug)]
struct CleanupDeleteExecution {
    mode: CleanupDeleteMode,
    trash_destination: Option<CleanupTrashDestination>,
    deleted: Vec<CleanupDeleteSuccess>,
    failed: Vec<CleanupDeleteFailure>,
    targets: Vec<CleanupDeleteTarget>,
    selected_logical_bytes: u64,
    selected_allocated_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupTargetRevalidation {
    Present,
    Missing,
}

#[derive(Debug)]
enum CleanupTrashDestination {
    #[cfg(all(target_os = "macos", not(test)))]
    System(MacOSTrashStaging),
    #[cfg(any(not(target_os = "macos"), test))]
    Directory(DeleteRoot),
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct MacOSTrashStaging {
    root: DeleteRoot,
    path: PathBuf,
    parent: DeleteRoot,
    directory_name: String,
}

#[cfg(target_os = "macos")]
impl Drop for MacOSTrashStaging {
    fn drop(&mut self) {
        let _ = self
            .parent
            .remove_empty_subdirectory(self.directory_name.as_ref());
    }
}

impl CleanupDeleteController {
    pub fn lease_measurement_path(&self, lease_id: &str) -> Option<PathBuf> {
        self.leases
            .iter()
            .find(|lease| lease.id == lease_id)
            .and_then(|lease| lease.targets.first())
            .and_then(|target| target.canonical_path.parent())
            .map(Path::to_path_buf)
    }

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

    pub fn set_lease_mode(
        &mut self,
        request: CleanupDeleteLeaseModeRequest,
    ) -> Result<CleanupDeleteLease, CommandError> {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })?;
        self.set_lease_mode_for_home(request, &home)
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
        let selected_logical_bytes = execution.selected_logical_bytes;
        let selected_allocated_bytes = execution.selected_allocated_bytes;
        let trash_destination = execution.trash_destination;
        let targets = execution.targets;
        let already_completed_target_count = execution
            .deleted
            .len()
            .saturating_add(execution.failed.len());
        let total_target_count = targets.len().saturating_add(already_completed_target_count);
        // Deletion deliberately uses indeterminate progress. A complete pre-scan
        // doubles metadata I/O and widens the race window between validation and
        // removal without making the operation atomic.
        let total_entry_count = 0;
        let mut deleted = execution.deleted;
        let mut deleted_bytes = 0_u64;
        let mut failed = execution.failed;
        let mut processed_entry_count = 0_usize;
        let mut last_emitted_entry_count = 0_usize;
        let mut last_emitted_at = Instant::now();

        for (target_index, target) in targets.into_iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(cancelled_delete_result(
                    deleted,
                    selected_logical_bytes,
                    selected_allocated_bytes,
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
                completed_target_count: already_completed_target_count.saturating_add(target_index),
                total_target_count,
                current_path: current_path.clone(),
                deleted_bytes,
            });
            let mut target_deleted_bytes = 0_u64;
            let result = if mode == CleanupDeleteMode::Trash {
                let trash_destination = trash_destination.as_ref().ok_or_else(|| {
                    CommandError::internal("The cleanup Trash destination was not retained.")
                })?;
                move_cleanup_target_to_trash(&target, trash_destination).map(|bytes| {
                    target_deleted_bytes = bytes;
                    deleted_bytes = deleted_bytes.saturating_add(bytes);
                    processed_entry_count = processed_entry_count.saturating_add(1);
                    true
                })
            } else {
                target.inspection_policy.delete_cancellable(
                    target.bound,
                    cancelled,
                    &mut |entry_deleted_bytes| {
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
                                completed_target_count: already_completed_target_count
                                    .saturating_add(target_index),
                                total_target_count,
                                current_path: current_path.clone(),
                                deleted_bytes,
                            });
                            last_emitted_entry_count = processed_entry_count;
                            last_emitted_at = Instant::now();
                        }
                    },
                )
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
                        selected_logical_bytes,
                        selected_allocated_bytes,
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
                completed_target_count: already_completed_target_count
                    .saturating_add(target_index)
                    .saturating_add(1),
                total_target_count,
                current_path,
                deleted_bytes,
            });
        }
        Ok(CleanupDeleteResult {
            deleted,
            selected_logical_bytes,
            selected_allocated_bytes,
            deleted_bytes,
            available_bytes_before: None,
            available_bytes_after: None,
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
        if request.expected_targets.len() != request.paths.len() {
            return Err(CommandError::new(
                "invalid_cleanup_selection",
                "Every cleanup path must include the size and item count currently shown for confirmation.",
            ));
        }
        let validation = validate_cleanup_targets(&request, home)?;
        let targets = validation.targets;
        let missing_paths = validation.missing_paths;
        let unavailable_failures = validation.unavailable_failures;
        let trash_destination = if request.mode == CleanupDeleteMode::Trash && !targets.is_empty() {
            Some(prepare_cleanup_trash_destination(home)?)
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
        let refreshed_at_ms = now_millis();
        let executable = changed_paths.is_empty();
        if executable {
            if self.leases.len() >= MAX_CLEANUP_LEASES {
                self.leases.remove(0);
            }
            self.leases.push(CleanupDeleteLeaseEntry {
                id: id.clone(),
                refreshed_at_ms,
                mode: request.mode,
                trash_destination,
                paths: request.paths.clone(),
                missing_paths: missing_paths.clone(),
                unavailable_failures: unavailable_failures.clone(),
                targets: targets.clone(),
            });
        }
        Ok(CleanupDeleteLease {
            id,
            mode: request.mode,
            paths: request.paths,
            missing_paths,
            unavailable_paths: unavailable_failures
                .iter()
                .map(|failure| failure.path.clone())
                .collect(),
            changed_paths,
            refreshed_targets,
            executable,
            refreshed_at_ms,
        })
    }

    fn set_lease_mode_for_home(
        &mut self,
        request: CleanupDeleteLeaseModeRequest,
        home: &Path,
    ) -> Result<CleanupDeleteLease, CommandError> {
        let position = self
            .leases
            .iter()
            .position(|lease| lease.id == request.lease_id)
            .ok_or_else(|| {
                CommandError::new(
                    "cleanup_confirmation_unavailable",
                    "This cleanup confirmation was already used, cancelled, or closed.",
                )
            })?;
        if self.leases[position].mode == request.mode {
            return Ok(cleanup_delete_lease_snapshot(&self.leases[position]));
        }

        let trash_destination = if request.mode == CleanupDeleteMode::Trash
            && !self.leases[position].targets.is_empty()
        {
            let canonical_home = home.canonicalize().map_err(|error| {
                CommandError::new(
                    "home_directory_unavailable",
                    format!("CoreRobin could not verify the home directory: {error}"),
                )
            })?;
            let trash_roots = trash_paths(&canonical_home);
            if self.leases[position].targets.iter().any(|target| {
                trash_roots.iter().any(|trash_root| {
                    target.canonical_path.starts_with(trash_root)
                        || trash_root.starts_with(&target.canonical_path)
                })
            }) {
                return Err(CommandError::new(
                    "cleanup_target_conflicts_with_trash",
                    "Items that contain or are already inside the system Trash can only be deleted permanently.",
                ));
            }
            Some(prepare_cleanup_trash_destination(&canonical_home)?)
        } else {
            None
        };

        let lease = &mut self.leases[position];
        lease.mode = request.mode;
        lease.trash_destination = trash_destination;
        Ok(cleanup_delete_lease_snapshot(lease))
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
        let selected_logical_bytes = execution.selected_logical_bytes;
        let selected_allocated_bytes = execution.selected_allocated_bytes;
        let mut deleted = execution.deleted;
        let mut deleted_bytes = 0_u64;
        let mut failed = execution.failed;
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
            selected_logical_bytes,
            selected_allocated_bytes,
            deleted_bytes,
            available_bytes_before: None,
            available_bytes_after: None,
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
                    "This cleanup confirmation was already used, cancelled, or closed.",
                )
            })?;
        // Consume first so every execution attempt is single-use, including failures.
        let lease = self.leases.remove(position);
        let mut targets = Vec::with_capacity(lease.targets.len());
        let mut deleted = lease
            .missing_paths
            .into_iter()
            .map(|path| CleanupDeleteSuccess {
                path,
                deleted_bytes: 0,
            })
            .collect::<Vec<_>>();
        let mut failed = lease.unavailable_failures;
        for target in lease.targets {
            match revalidate_cleanup_target(&target) {
                Ok(CleanupTargetRevalidation::Present) => targets.push(target),
                Ok(CleanupTargetRevalidation::Missing) => deleted.push(CleanupDeleteSuccess {
                    path: target.display_path,
                    deleted_bytes: 0,
                }),
                Err(error) => failed.push(CleanupDeleteFailure {
                    path: target.display_path,
                    message: error.message,
                }),
            }
        }
        let selected_logical_bytes = targets
            .iter()
            .map(|target| target.evidence.logical_size_bytes)
            .fold(0_u64, u64::saturating_add);
        let selected_allocated_bytes = targets
            .iter()
            .map(|target| target.evidence.allocated_size_bytes)
            .fold(0_u64, u64::saturating_add);
        Ok(CleanupDeleteExecution {
            mode: lease.mode,
            trash_destination: lease.trash_destination,
            deleted,
            failed,
            targets,
            selected_logical_bytes,
            selected_allocated_bytes,
        })
    }
}

fn cleanup_delete_lease_snapshot(lease: &CleanupDeleteLeaseEntry) -> CleanupDeleteLease {
    CleanupDeleteLease {
        id: lease.id.clone(),
        mode: lease.mode,
        paths: lease.paths.clone(),
        missing_paths: lease.missing_paths.clone(),
        unavailable_paths: lease
            .unavailable_failures
            .iter()
            .map(|failure| failure.path.clone())
            .collect(),
        changed_paths: Vec::new(),
        refreshed_targets: lease.targets.iter().map(cleanup_target_evidence).collect(),
        executable: true,
        refreshed_at_ms: lease.refreshed_at_ms,
    }
}

fn cleanup_progress_phase(mode: CleanupDeleteMode) -> CleanupDeleteProgressPhase {
    match mode {
        CleanupDeleteMode::Trash => CleanupDeleteProgressPhase::MovingToTrash,
        CleanupDeleteMode::Permanent => CleanupDeleteProgressPhase::Deleting,
    }
}

fn prepare_cleanup_trash_destination(home: &Path) -> Result<CleanupTrashDestination, CommandError> {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        prepare_macos_trash_staging(home).map(CleanupTrashDestination::System)
    }

    #[cfg(any(not(target_os = "macos"), test))]
    prepare_cleanup_trash_root(home).map(CleanupTrashDestination::Directory)
}

#[cfg(all(target_os = "macos", not(test)))]
fn prepare_macos_trash_staging(home: &Path) -> Result<MacOSTrashStaging, CommandError> {
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_trash_unavailable",
            format!("CoreRobin could not verify the home directory before staging Trash: {error}"),
        )
    })?;
    let home_root = DeleteRoot::open(&canonical_home).map_err(|error| {
        CommandError::new(
            "cleanup_trash_unavailable",
            format!("CoreRobin could not retain a stable home directory handle: {error}"),
        )
    })?;
    let relative_parent = Path::new("Library/Application Support/CoreRobin/Pending Trash");
    let parent = home_root
        .open_subdirectory(relative_parent, true, true)
        .map_err(|error| {
            CommandError::new(
                "cleanup_trash_unavailable",
                format!("CoreRobin could not prepare its private Trash staging area: {error}"),
            )
        })?;

    for _ in 0..32 {
        let directory_name = macos_trash_staging_directory_name()?;
        match parent.create_private_subdirectory(directory_name.as_ref()) {
            Ok(root) => {
                let path = canonical_home.join(relative_parent).join(&directory_name);
                return Ok(MacOSTrashStaging {
                    root,
                    path,
                    parent,
                    directory_name,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CommandError::new(
                    "cleanup_trash_unavailable",
                    format!("CoreRobin could not create a private Trash staging area: {error}"),
                ));
            }
        }
    }
    Err(CommandError::new(
        "cleanup_trash_unavailable",
        "CoreRobin could not reserve a private Trash staging area.",
    ))
}

#[cfg(all(target_os = "macos", not(test)))]
fn macos_trash_staging_directory_name() -> Result<String, CommandError> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| {
        CommandError::internal(format!(
            "CoreRobin could not generate a private Trash staging name: {error}"
        ))
    })?;
    let token = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("lease-{token}"))
}

#[cfg(any(not(target_os = "macos"), test))]
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
    destination: &CleanupTrashDestination,
) -> Result<u64, String> {
    match destination {
        #[cfg(all(target_os = "macos", not(test)))]
        CleanupTrashDestination::System(staging) => {
            move_cleanup_target_to_macos_trash(target, staging)
        }
        #[cfg(any(not(target_os = "macos"), test))]
        CleanupTrashDestination::Directory(trash_root) => {
            move_cleanup_target_to_trash_directory(target, trash_root)
        }
    }
}

#[cfg(all(target_os = "macos", not(test)))]
fn move_cleanup_target_to_macos_trash(
    target: &CleanupDeleteTarget,
    staging: &MacOSTrashStaging,
) -> Result<u64, String> {
    if !target.bound.shares_volume_with(&staging.root) {
        move_path_to_macos_trash(target, &target.canonical_path)?;
        target.bound.verify_original_absent().map_err(|error| {
            format!(
                "CoreRobin could not verify that {} left its original volume: {error}",
                target.display_path
            )
        })?;
        return Ok(target.evidence.allocated_size_bytes);
    }
    move_cleanup_target_via_macos_staging(target, staging, |staged_path| {
        move_path_to_macos_trash(target, staged_path)
    })
}

#[cfg(target_os = "macos")]
fn move_cleanup_target_via_macos_staging(
    target: &CleanupDeleteTarget,
    staging: &MacOSTrashStaging,
    handoff: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<u64, String> {
    let original_name = target.canonical_path.file_name().ok_or_else(|| {
        format!(
            "CoreRobin could not derive a staging name for {}.",
            target.display_path
        )
    })?;
    target
        .bound
        .move_to_directory_noreplace(&staging.root, original_name)
        .map_err(|error| {
            format!(
                "CoreRobin could not safely stage {} before moving it to Trash: {error}",
                target.display_path
            )
        })?;

    let staged_path = staging.path.join(original_name);
    let move_result = target
        .bound
        .verify_in_directory(&staging.root, original_name)
        .map_err(|error| {
            format!(
                "CoreRobin stopped because {} changed before it could be moved to Trash: {error}",
                target.display_path
            )
        })
        .and_then(|()| handoff(&staged_path));
    if let Err(message) = move_result {
        return match target
            .bound
            .restore_from_directory_noreplace(&staging.root, original_name)
        {
            Ok(()) => Err(format!("{message} The original item was restored.")),
            Err(rollback_error) => Err(format!(
                "{message} CoreRobin could not restore the item automatically; it remains at {}: {rollback_error}",
                staged_path.display()
            )),
        };
    }
    target
        .bound
        .verify_absent_from_directory(&staging.root, original_name)
        .map_err(|error| {
            format!(
                "CoreRobin could not verify that {} reached Trash: {error}",
                target.display_path
            )
        })?;
    Ok(target.evidence.allocated_size_bytes)
}

#[cfg(all(target_os = "macos", not(test)))]
fn move_path_to_macos_trash(
    target: &CleanupDeleteTarget,
    staged_path: &Path,
) -> Result<(), String> {
    let path = CString::new(staged_path.as_os_str().as_bytes()).map_err(|_| {
        format!(
            "CoreRobin could not represent {} as a macOS file URL.",
            target.display_path
        )
    })?;
    let path_pointer = NonNull::new(path.as_ptr().cast_mut()).ok_or_else(|| {
        format!(
            "CoreRobin could not represent {} as a macOS file URL.",
            target.display_path
        )
    })?;
    let path_url = unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            path_pointer,
            target.bound.kind() == BoundTargetKind::Directory,
            None,
        )
    };
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&path_url, None)
        .map_err(|error| {
            format!(
                "macOS could not move {} to Trash ({} {}): {}",
                target.display_path,
                error.domain(),
                error.code(),
                error.localizedDescription()
            )
        })
}

#[cfg(any(not(target_os = "macos"), test))]
fn move_cleanup_target_to_trash_directory(
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
            Ok(()) => return Ok(target.evidence.allocated_size_bytes),
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

#[cfg(any(not(target_os = "macos"), test))]
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
    selected_logical_bytes: u64,
    selected_allocated_bytes: u64,
    deleted_bytes: u64,
    failed: Vec<CleanupDeleteFailure>,
    interrupted_path: Option<String>,
) -> CleanupDeleteResult {
    CleanupDeleteResult {
        deleted,
        selected_logical_bytes,
        selected_allocated_bytes,
        deleted_bytes,
        available_bytes_before: None,
        available_bytes_after: None,
        failed,
        cancelled: true,
        interrupted_path,
    }
}

pub fn available_bytes_for_path(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut statistics = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `path` is NUL terminated and `statistics` points to writable,
        // correctly sized storage initialized by a successful `statvfs` call.
        if unsafe { libc::statvfs(path.as_ptr(), statistics.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: the successful call above initialized the structure.
        let statistics = unsafe { statistics.assume_init() };
        #[cfg(target_os = "macos")]
        let available_blocks = u64::from(statistics.f_bavail);
        #[cfg(not(target_os = "macos"))]
        let available_blocks = statistics.f_bavail;
        Some(available_blocks.saturating_mul(statistics.f_frsize))
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

        let mut path = path.as_os_str().encode_wide().collect::<Vec<_>>();
        path.push(0);
        let mut available = 0_u64;
        // SAFETY: the path is NUL terminated and `available` is a valid output
        // pointer for the duration of this call.
        let succeeded = unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        return (succeeded != 0).then_some(available);
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

fn resolve_cleanup_scan_target(
    request: &CleanupScanRequest,
) -> Result<(PathBuf, PathBuf, CleanupScanTargetKind), CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    let system_root = system_disk_root(&home).ok_or_else(|| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            "CoreRobin could not locate the system disk root.",
        )
    })?;
    let (scan_root, target_kind) = match request.target_kind {
        CleanupScanTargetKind::SystemDisk => {
            (system_root.clone(), CleanupScanTargetKind::SystemDisk)
        }
        target_kind @ (CleanupScanTargetKind::Volume | CleanupScanTargetKind::Folder) => {
            let raw_path = request.target_path.as_deref().ok_or_else(|| {
                CommandError::new(
                    "cleanup_scan_target_missing",
                    "The selected scan target did not include a path.",
                )
            })?;
            let candidate = Path::new(raw_path);
            if !candidate.is_absolute() {
                return Err(CommandError::new(
                    "cleanup_scan_target_invalid",
                    "The selected scan target must be an absolute directory path.",
                ));
            }
            let canonical = candidate.canonicalize().map_err(|error| {
                CommandError::new(
                    "cleanup_scan_target_unavailable",
                    format!("CoreRobin could not open the selected scan target: {error}"),
                )
            })?;
            if !canonical.is_dir() {
                return Err(CommandError::new(
                    "cleanup_scan_target_invalid",
                    "The selected scan target is not a directory.",
                ));
            }
            (canonical, target_kind)
        }
    };
    Ok((home, scan_root, target_kind))
}

#[derive(Clone, Debug)]
#[cfg(test)]
#[allow(dead_code)]
pub struct CleanupScanSegmentPlan {
    pub request: CleanupScanRequest,
    pub home: PathBuf,
    pub scan_root: PathBuf,
    pub target_kind: CleanupScanTargetKind,
    pub segment_paths: Vec<PathBuf>,
}

#[cfg(test)]
#[allow(dead_code)]
pub fn cleanup_scan_segment_plan(
    request: CleanupScanRequest,
    cancelled: &AtomicBool,
) -> Result<CleanupScanSegmentPlan, CommandError> {
    let (home, scan_root, target_kind) = resolve_cleanup_scan_target(&request)?;
    let boundary = ScanFilesystemBoundary::for_root(&scan_root)?;
    let entries = fs::read_dir(&scan_root).map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not read the selected scan root: {error}"),
        )
    })?;
    let mut segment_paths = Vec::new();
    for entry in entries {
        ensure_scan_active(cancelled)?;
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        if is_excluded_scan_namespace(&path, &scan_root) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if boundary.allows_directory(&metadata) {
            segment_paths.push(path);
        }
    }
    segment_paths.sort();
    Ok(CleanupScanSegmentPlan {
        request,
        home,
        scan_root,
        target_kind,
        segment_paths,
    })
}

#[cfg(test)]
pub fn scan_cleanup_segment(
    plan: &CleanupScanSegmentPlan,
    segment_path: &Path,
    excluded_paths: &[PathBuf],
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    #[cfg(target_os = "macos")]
    let _activity = CleanupScanActivity::begin();
    let system_scan = plan.target_kind == CleanupScanTargetKind::SystemDisk;
    let mut scan = scan_filesystem(
        ScanFilesystemOptions {
            scan_root: segment_path,
            home: &plan.home,
            protection_root: &plan.scan_root,
            definitions: if system_scan {
                platform_paths(&plan.home)
            } else {
                Vec::new()
            },
            selected_cleanup_root: !system_scan,
            include_application_inventory: false,
            excluded_paths,
        },
        cancelled,
        on_progress,
    )?;
    scan.target_kind = plan.target_kind;
    scan.target_path = segment_path.to_string_lossy().into_owned();
    Ok(scan)
}

#[cfg(test)]
#[allow(dead_code)]
pub fn assemble_cleanup_scan_segments(
    plan: &CleanupScanSegmentPlan,
    mut segments: Vec<CleanupScan>,
    cancelled: &AtomicBool,
    _on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    ensure_scan_active(cancelled)?;
    segments.sort_by(|left, right| left.target_path.cmp(&right.target_path));
    let direct = scan_cleanup_root_files(plan, cancelled)?;
    let mut children = segments
        .iter()
        .map(|scan| scan.root.clone())
        .chain(direct.nodes)
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        right
            .allocated_size_bytes
            .cmp(&left.allocated_size_bytes)
            .then_with(|| left.name.cmp(&right.name))
    });
    let logical_size_bytes = children.iter().fold(0_u64, |total, node| {
        total.saturating_add(node.logical_size_bytes)
    });
    let allocated_size_bytes = children.iter().fold(0_u64, |total, node| {
        total.saturating_add(node.allocated_size_bytes)
    });
    let item_count = children
        .iter()
        .fold(0_usize, |total, node| total.saturating_add(node.item_count));
    let root_path = display_path(&plan.scan_root, &plan.home);
    let protection_reason = cleanup_protection_for_scan_path(
        &plan.scan_root,
        &plan.home,
        &plan.scan_root,
        plan.target_kind != CleanupScanTargetKind::SystemDisk,
    );
    let mut root = CleanupNode {
        id: root_path.clone(),
        name: cleanup_node_name(&plan.scan_root),
        path: Some(root_path),
        size_bytes: allocated_size_bytes,
        logical_size_bytes,
        allocated_size_bytes,
        item_count,
        safety: CleanupSafety::Review,
        kind: CleanupNodeKind::Folder,
        deletion_protected: protection_reason.is_some(),
        protection_reason,
        has_children: !children.is_empty(),
        children,
    };
    let mut remaining = MAX_VISUAL_NODES_PER_SCAN;
    prune_cleanup_node(&mut root, &mut remaining);

    let definitions = if plan.target_kind == CleanupScanTargetKind::SystemDisk {
        platform_paths(&plan.home)
    } else {
        Vec::new()
    };
    let mut locations = definitions
        .iter()
        .map(|definition| CleanupLocation {
            kind: definition.kind,
            paths: definition
                .paths
                .iter()
                .map(|path| display_path(path, &plan.home))
                .collect(),
            size_bytes: 0,
            item_count: 0,
            safety: definition.safety,
            available: definition.paths.iter().any(|path| path.is_dir()),
            nodes: Vec::new(),
        })
        .collect::<Vec<_>>();
    for segment in &segments {
        for source in &segment.locations {
            let Some(target) = locations
                .iter_mut()
                .find(|location| location.kind == source.kind)
            else {
                continue;
            };
            target.size_bytes = target.size_bytes.saturating_add(source.size_bytes);
            target.item_count = target.item_count.saturating_add(source.item_count);
            target.available |= source.available;
            target.nodes.extend(source.nodes.clone());
        }
    }
    for location in &mut locations {
        prune_cleanup_nodes(&mut location.nodes, MAX_VISUAL_NODES_PER_LOCATION);
    }

    let mut largest_files = segments
        .iter()
        .flat_map(|segment| segment.largest_files.iter().cloned())
        .chain(direct.largest_files)
        .collect::<Vec<_>>();
    largest_files.sort_by_key(|file| Reverse(file.size_bytes));
    largest_files.dedup_by(|left, right| left.path == right.path);
    largest_files.truncate(MAX_LARGE_FILES);

    let mut unreadable_paths = segments
        .iter()
        .flat_map(|segment| segment.unreadable_paths.iter().cloned())
        .chain(direct.unreadable_paths)
        .collect::<Vec<_>>();
    unreadable_paths.sort();
    unreadable_paths.dedup();
    unreadable_paths.truncate(MAX_UNREADABLE_PATHS);

    let scanned_entry_count = segments
        .iter()
        .fold(direct.scanned_entry_count, |total, segment| {
            total.saturating_add(segment.scanned_entry_count)
        });
    let unreadable_entry_count = segments
        .iter()
        .fold(direct.unreadable_entry_count, |total, segment| {
            total.saturating_add(segment.unreadable_entry_count)
        });
    let duration_ms = segments.iter().fold(0_u64, |total, segment| {
        total.saturating_add(segment.duration_ms)
    });
    Ok(CleanupScan {
        scan_id: String::new(),
        profile: CleanupScanProfile::Complete,
        scope_paths: Vec::new(),
        indexed: false,
        index_byte_size: 0,
        sampled_at_ms: now_millis(),
        duration_ms,
        root,
        locations,
        largest_files,
        installed_applications: Vec::new(),
        application_inventory_available: false,
        scanned_entry_count,
        unreadable_entry_count,
        unreadable_paths,
        deletion_available: true,
        target_kind: plan.target_kind,
        target_path: plan.scan_root.to_string_lossy().into_owned(),
    })
}

#[derive(Default)]
#[cfg(test)]
#[allow(dead_code)]
struct CleanupRootFiles {
    nodes: Vec<CleanupNode>,
    largest_files: Vec<CleanupFile>,
    scanned_entry_count: usize,
    unreadable_entry_count: usize,
    unreadable_paths: Vec<String>,
}

#[cfg(test)]
#[allow(dead_code)]
fn scan_cleanup_root_files(
    plan: &CleanupScanSegmentPlan,
    cancelled: &AtomicBool,
) -> Result<CleanupRootFiles, CommandError> {
    let entries = fs::read_dir(&plan.scan_root).map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not read the selected scan root: {error}"),
        )
    })?;
    let definitions = if plan.target_kind == CleanupScanTargetKind::SystemDisk {
        platform_paths(&plan.home)
    } else {
        Vec::new()
    };
    let mut result = CleanupRootFiles::default();
    for entry in entries {
        ensure_scan_active(cancelled)?;
        result.scanned_entry_count = result.scanned_entry_count.saturating_add(1);
        let Ok(entry) = entry else {
            result.unreadable_entry_count = result.unreadable_entry_count.saturating_add(1);
            continue;
        };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            result.unreadable_entry_count = result.unreadable_entry_count.saturating_add(1);
            result
                .unreadable_paths
                .push(display_path(&path, &plan.home));
            continue;
        };
        if file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            result.unreadable_entry_count = result.unreadable_entry_count.saturating_add(1);
            result
                .unreadable_paths
                .push(display_path(&path, &plan.home));
            continue;
        };
        let logical_size_bytes = metadata.len();
        let allocated_size_bytes = allocated_file_size(&path, &metadata);
        let safety = matching_location_definition(&definitions, &path)
            .map_or(CleanupSafety::Review, |(_, definition)| definition.safety);
        let protection_reason = cleanup_protection_for_scan_path(
            &path,
            &plan.home,
            &plan.scan_root,
            plan.target_kind != CleanupScanTargetKind::SystemDisk,
        );
        let display = display_path(&path, &plan.home);
        if allocated_size_bytes >= LARGE_FILE_THRESHOLD_BYTES {
            result.largest_files.push(CleanupFile {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: allocated_size_bytes,
                modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
            });
        }
        result.nodes.push(CleanupNode {
            id: display.clone(),
            name: cleanup_node_name(&path),
            path: Some(display),
            size_bytes: allocated_size_bytes,
            logical_size_bytes,
            allocated_size_bytes,
            item_count: 1,
            safety,
            kind: CleanupNodeKind::File,
            deletion_protected: protection_reason.is_some(),
            protection_reason,
            has_children: false,
            children: Vec::new(),
        });
    }
    result.unreadable_paths.truncate(MAX_UNREADABLE_PATHS);
    Ok(result)
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
        ScanFilesystemOptions {
            scan_root: &canonical_root,
            home: &canonical_root,
            protection_root: &canonical_root,
            definitions: Vec::new(),
            selected_cleanup_root: false,
            include_application_inventory: false,
            excluded_paths: &[],
        },
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

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
struct ValidatedApplicationBundle {
    path: PathBuf,
    root: PathBuf,
    relative_path: PathBuf,
    name: String,
    bundle_id: Option<String>,
    modified_at_ms: Option<u64>,
}

#[cfg(target_os = "macos")]
impl ValidatedApplicationBundle {
    fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

#[cfg(target_os = "macos")]
fn validate_application_bundle(
    application_path: &str,
    home: &Path,
    preferred_language: Option<&str>,
) -> Result<ValidatedApplicationBundle, CommandError> {
    let requested = PathBuf::from(application_path);
    let requested_parent = requested.parent().ok_or_else(|| {
        CommandError::new(
            "application_bundle_invalid",
            "The selected application does not have a valid parent directory.",
        )
    })?;
    let system_root = Path::new("/Applications");
    let user_root = home.join("Applications");
    let canonical_system_root = system_root.canonicalize().ok();
    let canonical_user_root = user_root.canonicalize().ok();
    let selected_root = if requested_parent == system_root
        || canonical_system_root.as_deref() == Some(requested_parent)
    {
        system_root.to_path_buf()
    } else if requested_parent == user_root
        || canonical_user_root.as_deref() == Some(requested_parent)
    {
        user_root
    } else {
        return Err(CommandError::new(
            "application_bundle_not_allowed",
            "CoreRobin only uninstalls top-level applications from /Applications or your Applications folder.",
        ));
    };
    let metadata = fs::symlink_metadata(&requested).map_err(|error| {
        CommandError::new(
            "application_bundle_unavailable",
            format!("CoreRobin could not inspect the selected application: {error}"),
        )
    })?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || !requested
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    {
        return Err(CommandError::new(
            "application_bundle_invalid",
            "The selected item is not a no-follow macOS application bundle.",
        ));
    }
    let canonical_root = selected_root.canonicalize().map_err(|error| {
        CommandError::new(
            "application_bundle_unavailable",
            format!("CoreRobin could not verify the Applications folder: {error}"),
        )
    })?;
    let canonical_path = requested.canonicalize().map_err(|error| {
        CommandError::new(
            "application_bundle_unavailable",
            format!("CoreRobin could not verify the selected application: {error}"),
        )
    })?;
    if canonical_path.parent() != Some(canonical_root.as_path()) {
        return Err(CommandError::new(
            "application_bundle_not_allowed",
            "The selected application is not a direct child of an approved Applications folder.",
        ));
    }
    if current_application_bundle()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|current| current == canonical_path)
    {
        return Err(CommandError::new(
            "current_application_protected",
            "CoreRobin cannot uninstall itself while it is running.",
        ));
    }

    let info_path = canonical_path.join("Contents/Info.plist");
    let executable_root = canonical_path.join("Contents/MacOS");
    let info_metadata = fs::symlink_metadata(&info_path).map_err(|_| {
        CommandError::new(
            "application_bundle_invalid",
            "The selected application is missing Contents/Info.plist.",
        )
    })?;
    let executable_metadata = fs::symlink_metadata(&executable_root).map_err(|_| {
        CommandError::new(
            "application_bundle_invalid",
            "The selected application is missing Contents/MacOS.",
        )
    })?;
    if !info_metadata.is_file()
        || info_metadata.file_type().is_symlink()
        || !executable_metadata.is_dir()
        || executable_metadata.file_type().is_symlink()
    {
        return Err(CommandError::new(
            "application_bundle_invalid",
            "The selected application has an unsupported bundle structure.",
        ));
    }
    let plist = plist::Value::from_file(&info_path).map_err(|_| {
        CommandError::new(
            "application_bundle_invalid",
            "CoreRobin could not read the selected application's Info.plist.",
        )
    })?;
    let dictionary = plist.as_dictionary().ok_or_else(|| {
        CommandError::new(
            "application_bundle_invalid",
            "The selected application's Info.plist is not a dictionary.",
        )
    })?;
    let bundle_id = dictionary
        .get("CFBundleIdentifier")
        .and_then(plist::Value::as_string)
        .filter(|value| is_safe_bundle_identifier(value))
        .map(str::to_owned);
    let name = bundle_display_name(&canonical_path, dictionary, preferred_language);
    let relative_path = canonical_path
        .strip_prefix(&canonical_root)
        .expect("validated application is inside its root")
        .to_path_buf();
    Ok(ValidatedApplicationBundle {
        path: canonical_path,
        root: canonical_root,
        relative_path,
        name,
        bundle_id,
        modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
    })
}

#[cfg(target_os = "macos")]
fn is_safe_bundle_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.contains('.')
        && value
            .split('.')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

#[cfg(target_os = "macos")]
fn open_application_delete_root(path: &Path) -> Result<DeleteRoot, CommandError> {
    let system_root = Path::new("/Applications");
    if path == system_root || system_root.canonicalize().ok().as_deref() == Some(path) {
        DeleteRoot::open_trusted_system_root(path)
    } else {
        DeleteRoot::open(path)
    }
    .map_err(|error| {
        CommandError::new(
            "application_bundle_unavailable",
            format!("CoreRobin could not retain a stable Applications folder handle: {error}"),
        )
    })
}

#[cfg(target_os = "macos")]
fn application_uninstall_candidates(
    home: &Path,
    bundle: &ValidatedApplicationBundle,
) -> Vec<(ApplicationArtifactKind, PathBuf, bool)> {
    let library = home.join("Library");
    let mut candidates = vec![(
        ApplicationArtifactKind::Application,
        bundle.path.clone(),
        true,
    )];
    let Some(bundle_id) = bundle.bundle_id.as_deref() else {
        return candidates;
    };
    candidates.extend([
        (
            ApplicationArtifactKind::ApplicationSupport,
            library.join("Application Support").join(bundle_id),
            false,
        ),
        (
            ApplicationArtifactKind::Cache,
            library.join("Caches").join(bundle_id),
            false,
        ),
        (
            ApplicationArtifactKind::Preferences,
            library
                .join("Preferences")
                .join(format!("{bundle_id}.plist")),
            false,
        ),
        (
            ApplicationArtifactKind::SavedState,
            library
                .join("Saved Application State")
                .join(format!("{bundle_id}.savedState")),
            false,
        ),
        (
            ApplicationArtifactKind::Container,
            library.join("Containers").join(bundle_id),
            false,
        ),
        (
            ApplicationArtifactKind::WebData,
            library.join("WebKit").join(bundle_id),
            false,
        ),
        (
            ApplicationArtifactKind::HttpStorage,
            library.join("HTTPStorages").join(bundle_id),
            false,
        ),
        (
            ApplicationArtifactKind::HttpStorage,
            library
                .join("HTTPStorages")
                .join(format!("{bundle_id}.binarycookies")),
            false,
        ),
        (
            ApplicationArtifactKind::Cookies,
            library
                .join("Cookies")
                .join(format!("{bundle_id}.binarycookies")),
            false,
        ),
        (
            ApplicationArtifactKind::Logs,
            library.join("Logs").join(bundle_id),
            false,
        ),
        (
            ApplicationArtifactKind::LaunchAgent,
            library
                .join("LaunchAgents")
                .join(format!("{bundle_id}.plist")),
            false,
        ),
    ]);
    candidates
}

pub fn load_or_scan_application_inventory(
    cache_path: &Path,
    preferred_language: Option<&str>,
    force_refresh: bool,
) -> Result<ApplicationInventorySnapshot, CommandError> {
    #[cfg(target_os = "macos")]
    {
        let language = application_inventory_cache_language(preferred_language);
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })?;
        let canonical_home = home.canonicalize().map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("CoreRobin could not verify the home directory: {error}"),
            )
        })?;
        let fingerprint_before = application_inventory_fingerprint(&canonical_home).ok();
        if !force_refresh
            && let Some(fingerprint) = fingerprint_before.as_ref()
            && let Some(snapshot) =
                load_application_inventory_cache(cache_path, &language, fingerprint, now_millis())?
        {
            return Ok(snapshot);
        }

        let snapshot = scan_application_inventory(preferred_language)?;
        let fingerprint_after = application_inventory_fingerprint(&canonical_home).ok();
        if fingerprint_before.is_some()
            && fingerprint_before == fingerprint_after
            && let Some(fingerprint) = fingerprint_after.as_ref()
        {
            let _ = save_application_inventory_cache_at(
                cache_path,
                &language,
                fingerprint,
                &snapshot,
                now_millis(),
            );
        }
        Ok(snapshot)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = cache_path;
        crate::native_uninstall::load_or_scan_native_application_inventory(
            preferred_language,
            force_refresh,
        )
    }
}

#[cfg(target_os = "macos")]
fn application_inventory_cache_language(preferred_language: Option<&str>) -> String {
    preferred_language
        .map(str::trim)
        .filter(|language| !language.is_empty() && language.len() <= 64)
        .unwrap_or("default")
        .replace('_', "-")
        .to_ascii_lowercase()
}

#[cfg(target_os = "macos")]
fn load_application_inventory_cache(
    path: &Path,
    language: &str,
    fingerprint: &[ApplicationInventoryFingerprintEntry],
    now_ms: u64,
) -> Result<Option<ApplicationInventorySnapshot>, CommandError> {
    let bytes = match private_storage::read_limited(path, MAX_APPLICATION_INVENTORY_CACHE_BYTES) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let Ok(payload) = serde_json::from_slice::<ApplicationInventoryCachePayload>(&bytes) else {
        return Ok(None);
    };
    let age_ms = now_ms.saturating_sub(payload.saved_at_ms);
    if payload.version != APPLICATION_INVENTORY_CACHE_VERSION
        || payload.language != language
        || age_ms > APPLICATION_INVENTORY_CACHE_RETENTION_MS
        || !payload.snapshot.platform_supported
    {
        return Ok(None);
    }
    let mut snapshot = payload.snapshot;
    snapshot.cached = true;
    snapshot.refresh_recommended =
        age_ms > APPLICATION_INVENTORY_CACHE_STALE_AFTER_MS || payload.fingerprint != fingerprint;
    Ok(Some(snapshot))
}

#[cfg(target_os = "macos")]
fn save_application_inventory_cache_at(
    path: &Path,
    language: &str,
    fingerprint: &[ApplicationInventoryFingerprintEntry],
    snapshot: &ApplicationInventorySnapshot,
    saved_at_ms: u64,
) -> Result<(), CommandError> {
    let mut snapshot = snapshot.clone();
    snapshot.cached = false;
    snapshot.refresh_recommended = false;
    let bytes = serde_json::to_vec(&ApplicationInventoryCachePayload {
        version: APPLICATION_INVENTORY_CACHE_VERSION,
        language: language.to_owned(),
        saved_at_ms,
        fingerprint: fingerprint.to_vec(),
        snapshot,
    })
    .map_err(|error| {
        CommandError::internal(format!(
            "Could not encode the application inventory cache: {error}"
        ))
    })?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_APPLICATION_INVENTORY_CACHE_BYTES {
        return Err(CommandError::new(
            "application_inventory_cache_too_large",
            "The application inventory cache is too large to retain safely.",
        ));
    }
    private_storage::write_atomic(path, &bytes).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely update the application inventory cache: {error}"
        ))
    })
}

#[cfg(target_os = "macos")]
fn application_inventory_fingerprint(
    home: &Path,
) -> std::io::Result<Vec<ApplicationInventoryFingerprintEntry>> {
    let mut fingerprint = Vec::new();
    for root in [PathBuf::from("/Applications"), home.join("Applications")] {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
                || !entry.file_type()?.is_dir()
            {
                continue;
            }
            let bundle_modified_at_ms = entry
                .metadata()?
                .modified()
                .ok()
                .and_then(system_time_millis);
            let info_plist_modified_at_ms = fs::metadata(path.join("Contents/Info.plist"))
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(system_time_millis);
            fingerprint.push(ApplicationInventoryFingerprintEntry {
                path: path.to_string_lossy().into_owned(),
                bundle_modified_at_ms,
                info_plist_modified_at_ms,
            });
        }
    }
    fingerprint.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(fingerprint)
}

#[cfg(target_os = "macos")]
pub fn scan_application_inventory(
    preferred_language: Option<&str>,
) -> Result<ApplicationInventorySnapshot, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "CoreRobin could not locate the current user's home directory.",
        )
    })?;
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not verify the home directory: {error}"),
        )
    })?;
    let cancelled = AtomicBool::new(false);
    let mut stats = ScanStats::new();
    let mut ignore_progress = |_progress: CleanupScanProgress| {};
    let (scanned, _) = scan_installed_applications(
        &canonical_home,
        &cancelled,
        &mut stats,
        &mut ignore_progress,
        &HashMap::new(),
    )?;
    let mut applications = scanned
        .into_iter()
        .map(|application| {
            match validate_application_bundle(
                &application.path,
                &canonical_home,
                preferred_language,
            ) {
                Ok(bundle) => {
                    let path = bundle.path_string();
                    InstalledApplication {
                        name: bundle.name,
                        path,
                        bundle_id: bundle.bundle_id,
                        size_bytes: application.size_bytes,
                        last_used_at_ms: application.last_used_at_ms,
                        modified_at_ms: bundle.modified_at_ms,
                        uninstallable: true,
                        unavailable_reason: None,
                        installation_source:
                            crate::models::ApplicationInstallationSource::MacosBundle,
                        native_uninstall_identifier: None,
                        native_uninstall_requires_elevation: false,
                        icon_path: None,
                    }
                }
                Err(error) => InstalledApplication {
                    name: application.name,
                    path: application.path,
                    bundle_id: None,
                    size_bytes: application.size_bytes,
                    last_used_at_ms: application.last_used_at_ms,
                    modified_at_ms: application.modified_at_ms,
                    uninstallable: false,
                    unavailable_reason: Some(error.code),
                    installation_source: crate::models::ApplicationInstallationSource::MacosBundle,
                    native_uninstall_identifier: None,
                    native_uninstall_requires_elevation: false,
                    icon_path: None,
                },
            }
        })
        .collect::<Vec<_>>();
    applications.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(ApplicationInventorySnapshot {
        sampled_at_ms: now_millis(),
        platform_supported: true,
        cached: false,
        refresh_recommended: false,
        applications,
    })
}

pub fn prepare_application_uninstall(
    application_path: &str,
    preferred_language: Option<&str>,
) -> Result<ApplicationUninstallPlan, CommandError> {
    #[cfg(target_os = "macos")]
    {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })?;
        let canonical_home = home.canonicalize().map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("CoreRobin could not verify the home directory: {error}"),
            )
        })?;
        let bundle =
            validate_application_bundle(application_path, &canonical_home, preferred_language)?;
        let home_root = DeleteRoot::open(&canonical_home).map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("CoreRobin could not retain a stable home directory handle: {error}"),
            )
        })?;
        let application_root = open_application_delete_root(&bundle.root)?;
        let mut artifacts = Vec::new();
        let mut skipped_paths = Vec::new();
        for (kind, path, required) in application_uninstall_candidates(&canonical_home, &bundle) {
            let display = path.to_string_lossy().into_owned();
            let bound = if required {
                application_root.bind(&bundle.relative_path)
            } else {
                let Ok(relative) = path.strip_prefix(&canonical_home) else {
                    skipped_paths.push(display);
                    continue;
                };
                home_root.bind(relative)
            };
            let bound = match bound {
                Ok(bound) => bound,
                Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) if !required => {
                    skipped_paths.push(display);
                    continue;
                }
                Err(error) => {
                    return Err(CommandError::new(
                        "application_bundle_unavailable",
                        format!(
                            "CoreRobin could not safely inspect the application bundle: {error}"
                        ),
                    ));
                }
            };
            let inspection_policy = if required {
                CleanupTargetInspectionPolicy::ApplicationBundle
            } else {
                CleanupTargetInspectionPolicy::Strict
            };
            let inspection = match inspection_policy.inspect(&bound) {
                Ok(inspection) => inspection,
                Err(_) if !required => {
                    skipped_paths.push(display);
                    continue;
                }
                Err(message) => {
                    return Err(CommandError::new(
                        "application_bundle_unavailable",
                        format!("CoreRobin could not inspect the application bundle: {message}"),
                    ));
                }
            };
            artifacts.push(ApplicationUninstallArtifact {
                kind,
                path: display,
                logical_size_bytes: inspection.logical_size_bytes,
                allocated_size_bytes: inspection.allocated_size_bytes,
                item_count: inspection.item_count,
                required,
            });
        }
        let application_size = artifacts
            .iter()
            .find(|artifact| artifact.required)
            .map_or(0, |artifact| artifact.allocated_size_bytes);
        let application_path = bundle.path_string();
        Ok(ApplicationUninstallPlan {
            sampled_at_ms: now_millis(),
            application: InstalledApplication {
                name: bundle.name,
                path: application_path,
                bundle_id: bundle.bundle_id,
                size_bytes: application_size,
                last_used_at_ms: None,
                modified_at_ms: bundle.modified_at_ms,
                uninstallable: true,
                unavailable_reason: None,
                installation_source: crate::models::ApplicationInstallationSource::MacosBundle,
                native_uninstall_identifier: None,
                native_uninstall_requires_elevation: false,
                icon_path: None,
            },
            artifacts,
            skipped_paths,
            native_uninstall: None,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        crate::native_uninstall::prepare_native_application_uninstall(
            application_path,
            preferred_language,
        )
    }
}

#[cfg(target_os = "macos")]
fn validate_trashed_application_bundle(
    application_path: &str,
    home: &Path,
    preferred_language: Option<&str>,
) -> Result<ValidatedApplicationBundle, CommandError> {
    let trash_root = home.join(".Trash");
    let canonical_root = trash_root.canonicalize().map_err(|error| {
        CommandError::new(
            "trash_unavailable",
            format!("CoreRobin could not inspect the current user's Trash: {error}"),
        )
    })?;
    let requested = PathBuf::from(application_path);
    let metadata = fs::symlink_metadata(&requested).map_err(|error| {
        CommandError::new(
            "application_bundle_unavailable",
            format!("CoreRobin could not inspect the trashed application: {error}"),
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CommandError::new(
            "application_bundle_invalid",
            "The selected Trash item is not a no-follow application bundle.",
        ));
    }
    let canonical_path = requested.canonicalize().map_err(|error| {
        CommandError::new(
            "application_bundle_unavailable",
            format!("CoreRobin could not verify the trashed application: {error}"),
        )
    })?;
    if canonical_path.parent() != Some(canonical_root.as_path())
        || !canonical_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
    {
        return Err(CommandError::new(
            "application_bundle_not_allowed",
            "Only top-level application bundles in the current user's Trash can be inspected.",
        ));
    }
    let info_path = canonical_path.join("Contents/Info.plist");
    let plist = plist::Value::from_file(&info_path).map_err(|_| {
        CommandError::new(
            "application_bundle_invalid",
            "CoreRobin could not read the trashed application's Info.plist.",
        )
    })?;
    let dictionary = plist.as_dictionary().ok_or_else(|| {
        CommandError::new(
            "application_bundle_invalid",
            "The trashed application's Info.plist is not a dictionary.",
        )
    })?;
    let bundle_id = dictionary
        .get("CFBundleIdentifier")
        .and_then(plist::Value::as_string)
        .filter(|value| is_safe_bundle_identifier(value))
        .map(str::to_owned);
    let name = bundle_display_name(&canonical_path, dictionary, preferred_language);
    let relative_path = canonical_path
        .strip_prefix(&canonical_root)
        .expect("validated Trash application is inside its root")
        .to_path_buf();
    Ok(ValidatedApplicationBundle {
        path: canonical_path,
        root: canonical_root,
        relative_path,
        name,
        bundle_id,
        modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
    })
}

pub fn scan_trashed_applications(
    preferred_language: Option<&str>,
) -> Result<Vec<crate::models::TrashedApplication>, CommandError> {
    #[cfg(target_os = "macos")]
    {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })?;
        let trash = home.join(".Trash");
        let entries = match fs::read_dir(&trash) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Vec::new());
            }
            Err(error) => {
                return Err(CommandError::new(
                    "trash_unavailable",
                    format!("CoreRobin could not read the current user's Trash: {error}"),
                ));
            }
        };
        let mut applications = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
            })
            .filter_map(|entry| {
                let path = entry.path();
                let bundle = validate_trashed_application_bundle(
                    &path.to_string_lossy(),
                    &home,
                    preferred_language,
                )
                .ok()?;
                Some(crate::models::TrashedApplication {
                    name: bundle.name.clone(),
                    path: bundle.path_string(),
                    bundle_id: bundle.bundle_id,
                    modified_at_ms: bundle.modified_at_ms,
                })
            })
            .collect::<Vec<_>>();
        applications.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(applications)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = preferred_language;
        Ok(Vec::new())
    }
}

pub fn prepare_trashed_application_residual_plan(
    application_path: &str,
    preferred_language: Option<&str>,
) -> Result<ApplicationUninstallPlan, CommandError> {
    #[cfg(target_os = "macos")]
    {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "CoreRobin could not locate the current user's home directory.",
            )
        })?;
        let canonical_home = home.canonicalize().map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("CoreRobin could not verify the home directory: {error}"),
            )
        })?;
        let bundle = validate_trashed_application_bundle(
            application_path,
            &canonical_home,
            preferred_language,
        )?;
        let home_root = DeleteRoot::open(&canonical_home).map_err(|error| {
            CommandError::new(
                "home_directory_unavailable",
                format!("CoreRobin could not retain a stable home directory handle: {error}"),
            )
        })?;
        let mut artifacts = Vec::new();
        let mut skipped_paths = Vec::new();
        for (kind, path, required) in application_uninstall_candidates(&canonical_home, &bundle) {
            if required {
                continue;
            }
            let display = path.to_string_lossy().into_owned();
            let Ok(relative) = path.strip_prefix(&canonical_home) else {
                skipped_paths.push(display);
                continue;
            };
            let bound = match home_root.bind(relative) {
                Ok(bound) => bound,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    skipped_paths.push(display);
                    continue;
                }
            };
            let inspection = match CleanupTargetInspectionPolicy::Strict.inspect(&bound) {
                Ok(inspection) => inspection,
                Err(_) => {
                    skipped_paths.push(display);
                    continue;
                }
            };
            artifacts.push(ApplicationUninstallArtifact {
                kind,
                path: display,
                logical_size_bytes: inspection.logical_size_bytes,
                allocated_size_bytes: inspection.allocated_size_bytes,
                item_count: inspection.item_count,
                required: false,
            });
        }
        Ok(ApplicationUninstallPlan {
            sampled_at_ms: now_millis(),
            application: InstalledApplication {
                name: bundle.name.clone(),
                path: bundle.path_string(),
                bundle_id: bundle.bundle_id,
                size_bytes: 0,
                last_used_at_ms: None,
                modified_at_ms: bundle.modified_at_ms,
                uninstallable: true,
                unavailable_reason: None,
                installation_source: crate::models::ApplicationInstallationSource::MacosBundle,
                native_uninstall_identifier: None,
                native_uninstall_requires_elevation: false,
                icon_path: None,
            },
            artifacts,
            skipped_paths,
            native_uninstall: None,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (application_path, preferred_language);
        Err(CommandError::new(
            "trash_watcher_unsupported",
            "Application Trash observation is available on macOS only.",
        ))
    }
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
) -> Result<CleanupTargetValidation, CommandError> {
    if request.paths.is_empty() || request.paths.len() > MAX_CLEANUP_TARGETS {
        return Err(CommandError::new(
            "invalid_cleanup_selection",
            format!("Choose between 1 and {MAX_CLEANUP_TARGETS} cleanup items before continuing."),
        ));
    }
    if let Some(scope) = request.application_uninstall.as_ref() {
        return validate_application_uninstall_targets(request, scope, home).map(|targets| {
            CleanupTargetValidation {
                targets,
                missing_paths: Vec::new(),
                unavailable_failures: Vec::new(),
            }
        });
    }
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not verify the home directory: {error}"),
        )
    })?;
    let home_delete_root = DeleteRoot::open(&canonical_home).map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not open a stable home directory handle: {error}"),
        )
    })?;
    let mut delete_roots = HashMap::from([(canonical_home.clone(), home_delete_root)]);
    let selected_scan_root = match (request.scan_target_kind, request.scan_root.as_deref()) {
        (CleanupScanTargetKind::SystemDisk, _) | (_, None) => None,
        (_, Some(path)) => validate_selected_cleanup_root(path, &canonical_home)?,
    };
    let trash_roots = trash_paths(&canonical_home);
    let mut seen = HashSet::new();
    let mut selected_paths = Vec::with_capacity(request.paths.len());
    let mut targets = Vec::with_capacity(request.paths.len());
    let mut missing_paths = Vec::new();
    let mut unavailable_failures = Vec::new();
    for display in &request.paths {
        let path = expand_cleanup_path(display, &canonical_home)?;
        let home_relative = path
            .strip_prefix(home)
            .or_else(|_| path.strip_prefix(&canonical_home))
            .ok()
            .map(Path::to_path_buf);
        let (boundary_root, relative_path, trusted_system_root) = if let Some(relative) =
            home_relative
        {
            (canonical_home.clone(), relative, false)
        } else if let Some(root) = selected_scan_root.as_ref()
            && let Ok(relative) = path.strip_prefix(root)
            && !relative.as_os_str().is_empty()
        {
            (root.clone(), relative.to_path_buf(), true)
        } else if let Some((boundary, relative)) = temporary_cleanup_boundary_for_path(&path) {
            (
                boundary.canonical_root.clone(),
                relative,
                boundary.trusted_system_root,
            )
        } else {
            return Err(CommandError::new(
                "cleanup_target_outside_home",
                format!(
                    "CoreRobin only deletes items inside your home folder or approved temporary locations: {display}"
                ),
            ));
        };
        let canonical_path = boundary_root.join(&relative_path);
        let protection_reason = selected_scan_root.as_ref().map_or_else(
            || cleanup_protection_for_path(&canonical_path, &canonical_home),
            |root| {
                cleanup_protection_for_selected_scan_path(&canonical_path, &canonical_home, root)
            },
        );
        if protection_reason.is_some() {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "CoreRobin will not delete operating-system locations, credential stores, protected data-library roots, temporary-directory roots, the home directory, or the system Trash folder itself.",
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
        if !seen.insert(canonical_path.clone()) {
            return Err(CommandError::new(
                "duplicate_cleanup_target",
                format!("The cleanup selection contains the same item more than once: {display}"),
            ));
        }
        selected_paths.push(canonical_path.clone());
        if !delete_roots.contains_key(&boundary_root) {
            let root = if trusted_system_root {
                DeleteRoot::open_trusted_system_root(&boundary_root)
            } else {
                DeleteRoot::open(&boundary_root)
            }
            .map_err(|error| {
                CommandError::new(
                    "cleanup_target_unavailable",
                    format!(
                        "CoreRobin could not open the approved cleanup location {}: {error}",
                        boundary_root.display()
                    ),
                )
            })?;
            delete_roots.insert(boundary_root.clone(), root);
        }
        let delete_root = delete_roots
            .get(&boundary_root)
            .expect("cleanup boundary root was opened");
        let bound = match delete_root.bind(&relative_path) {
            Ok(bound) => bound,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_paths.push(display.clone());
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                unavailable_failures.push(CleanupDeleteFailure {
                    path: display.clone(),
                    message: format!(
                        "CoreRobin could not safely access this item and left it unchanged: {error}"
                    ),
                });
                continue;
            }
            Err(error) => {
                let message = error.to_string();
                let code = if message.contains("volume") {
                    "cleanup_cross_filesystem"
                } else if message.contains("symbolic") || message.contains("special") {
                    "unsupported_cleanup_target"
                } else {
                    "cleanup_target_unavailable"
                };
                return Err(CommandError::new(
                    code,
                    format!("CoreRobin could not safely bind {display}: {error}"),
                ));
            }
        };
        let evidence = request
            .expected_targets
            .iter()
            .find(|expected| expected.path == *display)
            .cloned()
            .ok_or_else(|| {
                CommandError::new(
                    "invalid_cleanup_selection",
                    format!("The cleanup selection is missing scan evidence for {display}."),
                )
            })?;
        targets.push(CleanupDeleteTarget {
            display_path: display.clone(),
            canonical_path,
            modified_at_ms: None,
            evidence,
            inspection: None,
            inspection_policy: CleanupTargetInspectionPolicy::CleanupBasket,
            bound,
        });
    }
    for left in 0..selected_paths.len() {
        for right in (left + 1)..selected_paths.len() {
            let left_path = &selected_paths[left];
            let right_path = &selected_paths[right];
            if left_path.starts_with(right_path) || right_path.starts_with(left_path) {
                return Err(CommandError::new(
                    "overlapping_cleanup_targets",
                    "Choose either a folder or its contents, not both.",
                ));
            }
        }
    }
    Ok(CleanupTargetValidation {
        targets,
        missing_paths,
        unavailable_failures,
    })
}

fn validate_selected_cleanup_root(
    requested: &str,
    canonical_home: &Path,
) -> Result<Option<PathBuf>, CommandError> {
    let requested = Path::new(requested);
    if !requested.is_absolute() {
        return Err(CommandError::new(
            "cleanup_scan_root_invalid",
            "A selected cleanup boundary must be an absolute directory path.",
        ));
    }
    let metadata = fs::symlink_metadata(requested).map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not verify the selected scan root: {error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CommandError::new(
            "cleanup_scan_root_invalid",
            "A selected cleanup boundary must be a real directory.",
        ));
    }
    let root = requested.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not open the selected scan root: {error}"),
        )
    })?;
    let system_root = system_disk_root(canonical_home).and_then(|path| path.canonicalize().ok());
    if root.starts_with(canonical_home)
        || system_root.as_ref().is_some_and(|system| root == *system)
    {
        return Ok(None);
    }
    Ok(Some(root))
}

#[cfg(target_os = "macos")]
fn validate_application_uninstall_targets(
    request: &CleanupDeleteLeaseRequest,
    scope: &crate::models::ApplicationUninstallScope,
    home: &Path,
) -> Result<Vec<CleanupDeleteTarget>, CommandError> {
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not verify the home directory: {error}"),
        )
    })?;
    let bundle = validate_application_bundle(&scope.application_path, &canonical_home, None)?;
    if bundle.bundle_id != scope.bundle_id {
        return Err(CommandError::new(
            "application_identity_changed",
            "The selected application's identity changed. Refresh the application list before continuing.",
        ));
    }
    if !request
        .paths
        .iter()
        .any(|path| path == &bundle.path_string())
    {
        return Err(CommandError::new(
            "application_bundle_required",
            "The application bundle must remain selected for an uninstall operation.",
        ));
    }

    let allowed = application_uninstall_candidates(&canonical_home, &bundle)
        .into_iter()
        .map(|(_, path, _)| path)
        .collect::<HashSet<_>>();
    let home_root = DeleteRoot::open(&canonical_home).map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("CoreRobin could not retain a stable home directory handle: {error}"),
        )
    })?;
    let mut application_root = None;
    let mut seen = HashSet::new();
    let mut targets = Vec::with_capacity(request.paths.len());

    for display in &request.paths {
        let path = PathBuf::from(display);
        if !allowed.contains(&path) {
            return Err(CommandError::new(
                "application_artifact_not_allowed",
                format!(
                    "CoreRobin could not prove that this item belongs to the selected application: {display}"
                ),
            ));
        }
        if !seen.insert(path.clone()) {
            return Err(CommandError::new(
                "duplicate_cleanup_target",
                format!("The uninstall selection contains the same item more than once: {display}"),
            ));
        }

        let bound = if path == bundle.path {
            if application_root.is_none() {
                application_root = Some(open_application_delete_root(&bundle.root)?);
            }
            application_root
                .as_ref()
                .expect("application root was initialized")
                .bind(&bundle.relative_path)
        } else {
            let relative = path.strip_prefix(&canonical_home).map_err(|_| {
                CommandError::new(
                    "application_artifact_not_allowed",
                    format!(
                        "Application support data must stay inside your home folder: {display}"
                    ),
                )
            })?;
            home_root.bind(relative)
        }
        .map_err(|error| {
            CommandError::new(
                "application_artifact_unavailable",
                format!("CoreRobin could not safely bind {display}: {error}"),
            )
        })?;
        let inspection_policy = if path == bundle.path {
            CleanupTargetInspectionPolicy::ApplicationBundle
        } else {
            CleanupTargetInspectionPolicy::Strict
        };
        let inspection = inspection_policy.inspect(&bound).map_err(|message| {
            CommandError::new(
                "application_artifact_unavailable",
                format!("CoreRobin could not refresh {display} before confirmation: {message}"),
            )
        })?;
        let evidence = CleanupDeleteTargetEvidence {
            path: display.clone(),
            logical_size_bytes: inspection.logical_size_bytes,
            allocated_size_bytes: inspection.allocated_size_bytes,
            item_count: inspection.item_count,
        };
        targets.push(CleanupDeleteTarget {
            display_path: display.clone(),
            canonical_path: path,
            modified_at_ms: bound.modified_at().and_then(system_time_millis),
            evidence,
            inspection: Some(inspection),
            inspection_policy,
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

#[cfg(not(target_os = "macos"))]
fn validate_application_uninstall_targets(
    _request: &CleanupDeleteLeaseRequest,
    _scope: &crate::models::ApplicationUninstallScope,
    _home: &Path,
) -> Result<Vec<CleanupDeleteTarget>, CommandError> {
    Err(CommandError::new(
        "application_uninstall_unsupported",
        "Complete application uninstall is currently available on macOS only.",
    ))
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

fn revalidate_cleanup_target(
    target: &CleanupDeleteTarget,
) -> Result<CleanupTargetRevalidation, CommandError> {
    let modified_at_ms = match target.bound.current_modified_at() {
        Ok(modified_at) => modified_at.and_then(system_time_millis),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CleanupTargetRevalidation::Missing);
        }
        Err(error) => {
            return Err(CommandError::new(
                "cleanup_target_changed",
                format!(
                    "{} changed after confirmation and was left unchanged: {error}",
                    target.display_path
                ),
            ));
        }
    };
    if target.inspection_policy == CleanupTargetInspectionPolicy::CleanupBasket {
        return Ok(CleanupTargetRevalidation::Present);
    }
    if modified_at_ms != target.modified_at_ms {
        return Err(CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation and was left unchanged.",
                target.display_path
            ),
        ));
    }
    let inspection = target
        .inspection_policy
        .inspect(&target.bound)
        .map_err(|message| {
            CommandError::new(
                "cleanup_target_changed",
                format!(
                    "{} changed after confirmation and was left unchanged: {message}",
                    target.display_path
                ),
            )
        })?;
    let confirmed_inspection = target.inspection.as_ref().ok_or_else(|| {
        CommandError::internal(format!(
            "CoreRobin lost the confirmation evidence for {}.",
            target.display_path
        ))
    })?;
    if &inspection != confirmed_inspection {
        return Err(CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation and was left unchanged.",
                target.display_path
            ),
        ));
    }
    Ok(CleanupTargetRevalidation::Present)
}

fn cleanup_target_evidence(target: &CleanupDeleteTarget) -> CleanupDeleteTargetEvidence {
    target.evidence.clone()
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
    max_candidates: usize,
    consolidate_small_candidates: bool,
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

#[derive(Clone, Copy)]
struct CleanupNodeLayout {
    remaining_depth: usize,
    max_children: usize,
    consolidate_small_children: bool,
}

impl CleanupNodeLayout {
    fn standard(remaining_depth: usize) -> Self {
        Self {
            remaining_depth,
            max_children: MAX_CHART_CHILDREN,
            consolidate_small_children: true,
        }
    }
}

struct ScanContext<'a> {
    stats: &'a mut ScanStats,
    largest_files: &'a mut Vec<CleanupFile>,
    home: &'a Path,
    scan_root: &'a Path,
    protection_root: &'a Path,
    selected_cleanup_root: bool,
    boundary: ScanFilesystemBoundary,
    definitions: &'a [LocationDefinition],
    location_summaries: &'a mut [LocationSummary],
    application_sizes: &'a mut HashMap<PathBuf, u64>,
    excluded_paths: &'a [PathBuf],
    cancelled: &'a AtomicBool,
    on_progress: &'a mut dyn FnMut(CleanupScanProgress),
}

impl ScanContext<'_> {
    fn protection_for_path(&self, path: &Path) -> Option<CleanupProtectionReason> {
        cleanup_protection_for_scan_path(
            path,
            self.home,
            self.protection_root,
            self.selected_cleanup_root,
        )
    }
}

fn cleanup_protection_for_scan_path(
    path: &Path,
    home: &Path,
    scan_root: &Path,
    selected_cleanup_root: bool,
) -> Option<CleanupProtectionReason> {
    if selected_cleanup_root && path.starts_with(scan_root) {
        cleanup_protection_for_selected_scan_path(path, home, scan_root)
    } else {
        cleanup_protection_for_path(path, home)
    }
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
        ScanFilesystemOptions {
            scan_root: home,
            home,
            protection_root: home,
            definitions,
            selected_cleanup_root: false,
            include_application_inventory,
            excluded_paths: &[],
        },
        cancelled,
        on_progress,
    )
}

struct ScanFilesystemOptions<'a> {
    scan_root: &'a Path,
    home: &'a Path,
    protection_root: &'a Path,
    definitions: Vec<LocationDefinition>,
    selected_cleanup_root: bool,
    include_application_inventory: bool,
    excluded_paths: &'a [PathBuf],
}

fn scan_filesystem(
    options: ScanFilesystemOptions<'_>,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    let ScanFilesystemOptions {
        scan_root,
        home,
        protection_root,
        definitions,
        selected_cleanup_root,
        include_application_inventory,
        excluded_paths,
    } = options;
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
            protection_root,
            selected_cleanup_root,
            boundary,
            definitions: &definitions,
            location_summaries: &mut location_summaries,
            application_sizes: &mut application_sizes,
            excluded_paths,
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
            CleanupNodeLayout::standard(MAX_VISUAL_TREE_DEPTH),
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

    let sampled_at_ms = now_millis();
    Ok(CleanupScan {
        scan_id: String::new(),
        profile: CleanupScanProfile::Complete,
        scope_paths: Vec::new(),
        indexed: false,
        index_byte_size: 0,
        sampled_at_ms,
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
        target_kind: CleanupScanTargetKind::SystemDisk,
        target_path: scan_root.to_string_lossy().into_owned(),
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
    layout: CleanupNodeLayout,
) -> Result<CleanupNode, CommandError> {
    scan_directory(
        root,
        collect_large_files,
        count_discovered_bytes,
        safety,
        context,
        seen_files,
        layout,
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
    layout: CleanupNodeLayout,
) -> Result<CleanupNode, CommandError> {
    let directory_safety = context.safety_for_path(directory, safety);
    if context
        .excluded_paths
        .iter()
        .any(|excluded| excluded == directory)
    {
        context.stats.record_unreadable(directory);
        context
            .stats
            .report_progress(directory, context.home, context.on_progress, true);
        let node = restricted_cleanup_node(directory, directory_safety, context.home);
        context.capture_location_root(directory, &node);
        return Ok(node);
    }
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
    if layout.remaining_depth == 0 {
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
    let mut children =
        ChildAccumulator::new(layout.max_children, layout.consolidate_small_children);
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
                CleanupNodeLayout::standard(layout.remaining_depth - 1),
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
        let protection_reason = context.protection_for_path(&entry_path);
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
    let protection_reason = context.protection_for_path(directory);
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
        if context
            .excluded_paths
            .iter()
            .any(|excluded| excluded == &directory)
        {
            context.stats.record_unreadable(&directory);
            continue;
        }
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
    let protection_reason = context.protection_for_path(root);
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
    fn new(max_candidates: usize, consolidate_small_candidates: bool) -> Self {
        Self {
            max_candidates,
            consolidate_small_candidates,
            ..Self::default()
        }
    }

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
        if self.candidates.len() < self.max_candidates {
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
            let too_small = self.consolidate_small_candidates
                && self.total_allocated_size_bytes > 0
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
                deletion_protected: false,
                protection_reason: None,
                has_children: true,
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
fn file_identity(_path: &Path, metadata: &Metadata) -> Option<FileIdentity> {
    (metadata.nlink() > 1).then(|| (metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(path: &Path, _metadata: &Metadata) -> Option<FileIdentity> {
    let Ok(file) = fs::File::open(path) else {
        return None;
    };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } != 0;
    if !succeeded || information.nNumberOfLinks <= 1 {
        return None;
    }
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Some((information.dwVolumeSerialNumber, file_index))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(path: &Path, _metadata: &Metadata) -> Option<FileIdentity> {
    Some(path.to_path_buf())
}

fn should_count_file(
    path: &Path,
    metadata: &Metadata,
    seen_files: &mut HashSet<FileIdentity>,
) -> bool {
    file_identity(path, metadata).is_none_or(|identity| seen_files.insert(identity))
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
    scan_root == Path::new("/")
        && (path == Path::new("/System/Volumes") || path == Path::new("/Volumes"))
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
    #[cfg(target_os = "macos")]
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn same_disk_folder_scan_creates_an_explicit_bounded_delete_authority() {
        let root = test_root("same-disk-scan-root");
        let home = root.join("home");
        let selected = root.join("selected");
        let selected_file = selected.join("app-data/history.db");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(selected_file.parent().unwrap()).unwrap();
        fs::write(&selected_file, b"history").unwrap();

        let boundary = validate_selected_cleanup_root(
            selected.to_string_lossy().as_ref(),
            &home.canonicalize().unwrap(),
        )
        .unwrap();

        assert_eq!(boundary, Some(selected.canonicalize().unwrap()));

        let inspection = {
            let selected_root = DeleteRoot::open(&selected.canonicalize().unwrap()).unwrap();
            selected_root
                .bind(Path::new("app-data/history.db"))
                .unwrap()
                .inspect()
                .unwrap()
        };
        let display = selected_file.to_string_lossy().into_owned();
        let request = CleanupDeleteLeaseRequest {
            scan_id: None,
            directory_ids: Vec::new(),
            paths: vec![display.clone()],
            scan_sampled_at_ms: now_millis(),
            scan_root: Some(selected.to_string_lossy().into_owned()),
            scan_target_kind: CleanupScanTargetKind::Folder,
            expected_targets: vec![CleanupDeleteTargetEvidence {
                path: display,
                logical_size_bytes: inspection.logical_size_bytes,
                allocated_size_bytes: inspection.allocated_size_bytes,
                item_count: inspection.item_count,
            }],
            mode: CleanupDeleteMode::Permanent,
            application_uninstall: None,
        };
        assert_eq!(
            validate_cleanup_targets(&request, &home)
                .unwrap()
                .targets
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_scan_skips_mounted_volume_namespaces_without_blocking_folder_scans() {
        assert!(is_excluded_scan_namespace(
            Path::new("/Volumes"),
            Path::new("/")
        ));
        assert!(is_excluded_scan_namespace(
            Path::new("/System/Volumes"),
            Path::new("/")
        ));
        assert!(!is_excluded_scan_namespace(
            Path::new("/Volumes/Archive/folder"),
            Path::new("/Volumes/Archive")
        ));
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
            scan_id: None,
            directory_ids: Vec::new(),
            paths,
            scan_sampled_at_ms,
            scan_root: None,
            scan_target_kind: CleanupScanTargetKind::SystemDisk,
            expected_targets,
            mode: CleanupDeleteMode::Permanent,
            application_uninstall: None,
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

    #[cfg(target_os = "macos")]
    #[test]
    fn application_inventory_cache_requires_matching_language_fingerprint_and_age() {
        let root = test_root("application-inventory-cache");
        let cache_path = root.join("nested/application-inventory-v1-zh-cn.json");
        let fingerprint = vec![ApplicationInventoryFingerprintEntry {
            path: "/Applications/Example.app".to_owned(),
            bundle_modified_at_ms: Some(900),
            info_plist_modified_at_ms: Some(800),
        }];
        let snapshot = ApplicationInventorySnapshot {
            sampled_at_ms: 1_000,
            platform_supported: true,
            cached: false,
            refresh_recommended: false,
            applications: vec![crate::models::InstalledApplication {
                name: "示例".to_owned(),
                path: "/Applications/Example.app".to_owned(),
                bundle_id: Some("com.example.app".to_owned()),
                size_bytes: 4_096,
                last_used_at_ms: None,
                modified_at_ms: Some(900),
                uninstallable: true,
                unavailable_reason: None,
                installation_source: crate::models::ApplicationInstallationSource::MacosBundle,
                native_uninstall_identifier: None,
                native_uninstall_requires_elevation: false,
                icon_path: None,
            }],
        };

        save_application_inventory_cache_at(&cache_path, "zh-cn", &fingerprint, &snapshot, 1_000)
            .unwrap();
        let cached = load_application_inventory_cache(&cache_path, "zh-cn", &fingerprint, 2_000)
            .unwrap()
            .unwrap();
        assert!(cached.cached);
        assert!(!cached.refresh_recommended);
        assert_eq!(cached.applications[0].name, "示例");

        assert!(
            load_application_inventory_cache(&cache_path, "en", &fingerprint, 2_000)
                .unwrap()
                .is_none()
        );
        let changed_fingerprint = vec![ApplicationInventoryFingerprintEntry {
            bundle_modified_at_ms: Some(901),
            ..fingerprint[0].clone()
        }];
        assert!(
            load_application_inventory_cache(&cache_path, "zh-cn", &changed_fingerprint, 2_000,)
                .unwrap()
                .unwrap()
                .refresh_recommended
        );
        assert!(
            load_application_inventory_cache(
                &cache_path,
                "zh-cn",
                &fingerprint,
                1_000 + APPLICATION_INVENTORY_CACHE_STALE_AFTER_MS + 1,
            )
            .unwrap()
            .unwrap()
            .refresh_recommended
        );
        assert!(
            load_application_inventory_cache(
                &cache_path,
                "zh-cn",
                &fingerprint,
                1_000 + APPLICATION_INVENTORY_CACHE_RETENTION_MS + 1,
            )
            .unwrap()
            .is_none()
        );

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
    fn scans_a_configured_disk_root_while_preserving_home_display_paths() {
        let disk_root = test_root("system-disk");
        let home = disk_root.join("Users/demo");
        let downloads = home.join("Downloads");
        let shared_library = disk_root.join("Library/Application Support");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&shared_library).unwrap();
        fs::write(downloads.join("personal.bin"), vec![1_u8; 256]).unwrap();
        fs::write(shared_library.join("system-cache.bin"), vec![2_u8; 1_024]).unwrap();

        let scan = scan_filesystem(
            ScanFilesystemOptions {
                scan_root: &disk_root,
                home: &home,
                protection_root: &disk_root,
                definitions: vec![LocationDefinition {
                    kind: CleanupLocationKind::Downloads,
                    paths: vec![downloads],
                    safety: CleanupSafety::Review,
                }],
                selected_cleanup_root: false,
                include_application_inventory: false,
                excluded_paths: &[],
            },
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();

        assert_eq!(
            scan.root.path.as_deref(),
            Some(disk_root.to_string_lossy().as_ref())
        );
        // The fixture lives under the current user's approved temporary root,
        // so it remains cleanable even though it models a full disk tree.
        assert_eq!(scan.root.protection_reason, None);
        let library = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Library")
            .unwrap();
        assert!(!library.deletion_protected);
        assert_eq!(library.protection_reason, None);
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
                paths: vec![downloads.clone()],
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
        let grouped = scanned_root
            .children
            .iter()
            .find(|node| node.kind == CleanupNodeKind::Aggregate)
            .unwrap();
        assert!(!grouped.deletion_protected);
        assert_eq!(grouped.protection_reason, None);
        assert!(grouped.has_children);
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
        assert!(lease.executable);
        assert!(lease.changed_paths.is_empty());
        assert_eq!(lease.refreshed_targets[0].item_count, 1);
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

    #[test]
    fn cleanup_delete_confirmation_capacity_evicts_the_oldest_stale_lease() {
        let root = test_root("cleanup-lease-capacity");
        let target = root.join("Downloads/archive.zip");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        let display = target.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();
        let mut lease_ids = Vec::new();

        for _ in 0..=MAX_CLEANUP_LEASES {
            let lease = controller
                .create_lease_for_home(
                    cleanup_delete_request(&root, vec![display.clone()], u64::MAX),
                    &root,
                )
                .unwrap();
            lease_ids.push(lease.id);
        }

        assert_eq!(controller.leases.len(), MAX_CLEANUP_LEASES);
        let oldest = controller
            .execute(CleanupDeleteExecutionRequest {
                lease_id: lease_ids.remove(0),
            })
            .unwrap_err();
        assert_eq!(oldest.code, "cleanup_confirmation_unavailable");
        assert!(
            controller
                .set_lease_mode_for_home(
                    CleanupDeleteLeaseModeRequest {
                        lease_id: lease_ids.pop().unwrap(),
                        mode: CleanupDeleteMode::Permanent,
                    },
                    &root,
                )
                .is_ok(),
        );
        drop(controller);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn cleanup_delete_mode_switch_reuses_the_validated_targets() {
        let root = test_root("switch-delete-mode");
        let target = root.join("Downloads/archive.zip");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        let display = target.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();

        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(&root, vec![display], u64::MAX),
                &root,
            )
            .unwrap();
        assert!(lease.executable);

        fs::write(&target, b"changed after validation").unwrap();
        let switched = controller
            .set_lease_mode_for_home(
                CleanupDeleteLeaseModeRequest {
                    lease_id: lease.id.clone(),
                    mode: CleanupDeleteMode::Trash,
                },
                &root,
            )
            .unwrap();

        assert_eq!(switched.id, lease.id);
        assert_eq!(switched.mode, CleanupDeleteMode::Trash);
        assert_eq!(switched.refreshed_at_ms, lease.refreshed_at_ms);
        assert_eq!(switched.refreshed_targets, lease.refreshed_targets);

        let result = controller
            .execute(CleanupDeleteExecutionRequest {
                lease_id: switched.id,
            })
            .unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(result.failed.is_empty());
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_delete_mode_switch_rejects_unavailable_trash_without_losing_lease() {
        let root = test_root("switch-delete-mode-unavailable");
        let target = root.join("Downloads/archive.zip");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        let display = target.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();

        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(&root, vec![display], u64::MAX),
                &root,
            )
            .unwrap();

        let error = controller
            .set_lease_mode_for_home(
                CleanupDeleteLeaseModeRequest {
                    lease_id: lease.id.clone(),
                    mode: CleanupDeleteMode::Trash,
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(error.code, "cleanup_trash_unavailable");

        let result = controller
            .execute(CleanupDeleteExecutionRequest { lease_id: lease.id })
            .unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(result.failed.is_empty());
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn cleanup_delete_mode_switch_keeps_trash_targets_permanent_only() {
        let root = test_root("switch-trash-target-mode");
        let trash = trash_paths(&root)
            .into_iter()
            .next()
            .expect("Unix platforms expose a cleanup Trash root");
        let target = trash.join("old.txt");
        fs::create_dir_all(&trash).unwrap();
        fs::write(&target, b"old").unwrap();
        let mut controller = CleanupDeleteController::default();

        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![target.to_string_lossy().into_owned()],
                    u64::MAX,
                ),
                &root,
            )
            .unwrap();
        assert_eq!(lease.mode, CleanupDeleteMode::Permanent);

        let error = controller
            .set_lease_mode_for_home(
                CleanupDeleteLeaseModeRequest {
                    lease_id: lease.id,
                    mode: CleanupDeleteMode::Trash,
                },
                &root,
            )
            .unwrap_err();

        assert_eq!(error.code, "cleanup_target_conflicts_with_trash");
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn application_uninstall_only_accepts_bundle_id_owned_paths() {
        use std::os::unix::fs::symlink;

        let root = test_root("application-uninstall-scope");
        let application = root.join("Applications/Example.app");
        let executable_root = application.join("Contents/MacOS");
        let cache = root.join("Library/Caches/com.example.safe");
        fs::create_dir_all(&executable_root).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(executable_root.join("Example"), b"binary").unwrap();
        fs::write(
            application.join("Contents/Info.plist"),
            br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.safe</string>
<key>CFBundleName</key><string>Example</string>
</dict></plist>"#,
        )
        .unwrap();
        symlink("Example", executable_root.join("Current")).unwrap();
        fs::write(cache.join("cache.db"), b"cache").unwrap();

        let application_path = application.canonicalize().unwrap();
        let cache_path = cache.canonicalize().unwrap();
        let paths = vec![
            application_path.to_string_lossy().into_owned(),
            cache_path.to_string_lossy().into_owned(),
        ];
        let mut request = cleanup_delete_request(&root, paths, now_millis());
        request.application_uninstall = Some(crate::models::ApplicationUninstallScope {
            application_path: application_path.to_string_lossy().into_owned(),
            bundle_id: Some("com.example.safe".to_owned()),
        });
        let targets = validate_application_uninstall_targets(
            &request,
            request.application_uninstall.as_ref().unwrap(),
            &root,
        )
        .unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0].inspection_policy,
            CleanupTargetInspectionPolicy::ApplicationBundle,
        );
        assert_eq!(
            targets[0]
                .inspection
                .as_ref()
                .expect("application bundle inspection is retained")
                .item_count,
            3,
        );

        request.paths.push(
            root.join("Library/Caches/com.example.safe.backup")
                .to_string_lossy()
                .into_owned(),
        );
        let error = validate_application_uninstall_targets(
            &request,
            request.application_uninstall.as_ref().unwrap(),
            &root,
        )
        .unwrap_err();
        assert_eq!(error.code, "application_artifact_not_allowed");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn application_without_bundle_identifier_can_only_uninstall_its_bundle() {
        let root = test_root("application-uninstall-without-bundle-id");
        let application = root.join("Applications/Legacy.app");
        let executable_root = application.join("Contents/MacOS");
        fs::create_dir_all(&executable_root).unwrap();
        fs::write(executable_root.join("Legacy"), b"binary").unwrap();
        fs::write(
            application.join("Contents/Info.plist"),
            br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Legacy</string>
</dict></plist>"#,
        )
        .unwrap();

        let application_path = application.canonicalize().unwrap();
        let bundle =
            validate_application_bundle(application_path.to_string_lossy().as_ref(), &root, None)
                .unwrap();
        assert_eq!(bundle.bundle_id, None);
        assert_eq!(
            application_uninstall_candidates(&root, &bundle),
            vec![(
                ApplicationArtifactKind::Application,
                application_path.clone(),
                true,
            )],
        );

        let display = application_path.to_string_lossy().into_owned();
        let mut request = cleanup_delete_request(&root, vec![display.clone()], now_millis());
        request.application_uninstall = Some(crate::models::ApplicationUninstallScope {
            application_path: display,
            bundle_id: None,
        });
        let targets = validate_application_uninstall_targets(
            &request,
            request.application_uninstall.as_ref().unwrap(),
            &root,
        )
        .unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].inspection_policy,
            CleanupTargetInspectionPolicy::ApplicationBundle,
        );

        request.paths.push(
            root.join("Library/Caches/Legacy")
                .to_string_lossy()
                .into_owned(),
        );
        let error = validate_application_uninstall_targets(
            &request,
            request.application_uninstall.as_ref().unwrap(),
            &root,
        )
        .unwrap_err();
        assert_eq!(error.code, "application_artifact_not_allowed");
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
    fn cleanup_delete_protects_credentials_and_personal_libraries_but_allows_app_data() {
        let root = test_root("sensitive-user-data");
        let ssh_key = root.join(".ssh/id_ed25519");
        let keychain = root.join("Library/Keychains/login.keychain-db");
        let mail = root.join("Library/Mail/V10/Envelope Index");
        let photo_database =
            root.join("Pictures/Photos Library.photoslibrary/database/Photos.sqlite");
        let codex_session = root.join(".codex/sessions/session.jsonl");
        let docker_data = root.join(".docker/desktop/data.raw");
        let preferences = root.join("Library/Preferences/com.example.settings.plist");
        let application_support =
            root.join("Library/Application Support/com.example.App/history.db");
        let container_data =
            root.join("Library/Containers/com.example.App/Data/Documents/history.db");
        let app_cache = root.join("Library/Caches/example/cache.bin");
        let app_log = root.join("Library/Logs/example.log");
        let sandbox_cache =
            root.join("Library/Containers/com.example.App/Data/Library/Caches/cache.bin");
        let sandbox_temp = root.join("Library/Containers/com.example.App/Data/tmp/session.bin");
        let cargo_cache = root.join(".cargo/registry/cache.bin");
        for file in [
            &ssh_key,
            &keychain,
            &mail,
            &photo_database,
            &codex_session,
            &docker_data,
            &preferences,
            &application_support,
            &container_data,
            &app_cache,
            &app_log,
            &sandbox_cache,
            &sandbox_temp,
            &cargo_cache,
        ] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, b"fixture").unwrap();
        }
        let mut controller = CleanupDeleteController::default();

        for protected in [&ssh_key, &keychain, &mail, &photo_database] {
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

        for cache in [
            &codex_session,
            &docker_data,
            &preferences,
            &application_support,
            &container_data,
            &app_cache,
            &app_log,
            &sandbox_cache,
            &sandbox_temp,
            &cargo_cache,
        ] {
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
        assert_eq!(
            cleanup_protection_for_path(&root.join("Library"), &root),
            Some(CleanupProtectionReason::SensitiveUserData)
        );
        assert_eq!(
            cleanup_protection_for_path(&root.join("Library/Application Support"), &root),
            Some(CleanupProtectionReason::SensitiveUserData)
        );
        assert_eq!(cleanup_protection_for_path(&codex_session, &root), None);
        assert_eq!(cleanup_protection_for_path(&preferences, &root), None);
        assert_eq!(cleanup_protection_for_path(&app_cache, &root), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_delete_allows_owned_items_in_approved_temporary_locations() {
        let base = test_root("approved-temporary-location");
        let home = base.join("home");
        let temporary_file = base.join("temporary-item.bin");
        fs::create_dir_all(&home).unwrap();
        fs::write(&temporary_file, b"temporary").unwrap();
        let display = temporary_file.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();

        assert_eq!(cleanup_protection_for_path(&temporary_file, &home), None);
        assert_eq!(
            cleanup_protection_for_path(&env::temp_dir().canonicalize().unwrap(), &home),
            Some(CleanupProtectionReason::SystemLocation)
        );

        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(&home, vec![display], now_millis()),
                &home,
            )
            .unwrap();
        let result = controller
            .execute(CleanupDeleteExecutionRequest { lease_id: lease.id })
            .unwrap();

        assert_eq!(result.deleted.len(), 1);
        assert!(!temporary_file.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn cleanup_protection_keeps_unapproved_system_locations_outside_the_allowlist() {
        let home = test_root("cleanup-protection-home");
        fs::create_dir_all(&home).unwrap();

        for path in [
            "/Applications",
            "/Library/Caches",
            "/Users/Shared",
            "/private/var/log",
            "/private/var/folders/not-the-current-user/cache.bin",
        ] {
            assert_eq!(
                cleanup_protection_for_path(Path::new(path), &home),
                Some(CleanupProtectionReason::SystemLocation),
                "{path} must remain protected"
            );
        }

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn selected_scan_children_are_actionable_but_the_scan_root_stays_protected() {
        let home = Path::new("/Users/example");
        let scan_root = Path::new("/Volumes/Archive");
        let child = scan_root.join("Downloads/old-image.dmg");

        assert_eq!(
            cleanup_protection_for_scan_path(scan_root, home, scan_root, true),
            Some(CleanupProtectionReason::SystemLocation)
        );
        assert_eq!(
            cleanup_protection_for_scan_path(&child, home, scan_root, true),
            None
        );
        assert_eq!(
            cleanup_protection_for_scan_path(&child, home, scan_root, false),
            Some(CleanupProtectionReason::SystemLocation)
        );
    }

    #[test]
    fn segmented_selected_scan_keeps_the_original_root_as_the_protection_boundary() {
        let base = test_root("segmented-selected-root");
        let home = base.join("home");
        let scan_root = base.join("selected");
        let segment = scan_root.join("Downloads");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&segment).unwrap();
        fs::write(segment.join("archive.zip"), b"fixture").unwrap();
        let plan = CleanupScanSegmentPlan {
            request: CleanupScanRequest {
                profile: CleanupScanProfile::Complete,
                target_kind: CleanupScanTargetKind::Folder,
                target_path: Some(scan_root.to_string_lossy().into_owned()),
            },
            home,
            scan_root: scan_root.clone(),
            target_kind: CleanupScanTargetKind::Folder,
            segment_paths: vec![segment.clone()],
        };

        let scan = scan_cleanup_segment(&plan, &segment, &[], &AtomicBool::new(false), &mut |_| {})
            .unwrap();

        assert_eq!(
            scan.root.path.as_deref(),
            Some(segment.to_string_lossy().as_ref())
        );
        assert!(!scan.root.deletion_protected);
        assert_eq!(
            cleanup_protection_for_scan_path(&scan_root, &plan.home, &scan_root, true),
            Some(CleanupProtectionReason::SystemLocation)
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn segmented_scan_skips_an_unresponsive_nested_directory_and_keeps_other_results() {
        let base = test_root("segmented-scan-exclusion");
        let home = base.join("home");
        let scan_root = base.join("selected");
        let segment = scan_root.join("Downloads");
        let excluded = segment.join("unresponsive");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&excluded).unwrap();
        fs::write(segment.join("available.bin"), b"available").unwrap();
        fs::write(excluded.join("blocked.bin"), b"blocked").unwrap();
        let plan = CleanupScanSegmentPlan {
            request: CleanupScanRequest {
                profile: CleanupScanProfile::Complete,
                target_kind: CleanupScanTargetKind::Folder,
                target_path: Some(scan_root.to_string_lossy().into_owned()),
            },
            home,
            scan_root: scan_root.clone(),
            target_kind: CleanupScanTargetKind::Folder,
            segment_paths: vec![segment.clone()],
        };

        let scan = scan_cleanup_segment(
            &plan,
            &segment,
            std::slice::from_ref(&excluded),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();

        assert!(scan.scanned_entry_count > 0);
        assert!(scan.unreadable_entry_count > 0);
        assert!(
            scan.unreadable_paths
                .contains(&excluded.to_string_lossy().into_owned())
        );
        assert!(scan.root.children.iter().any(|node| {
            node.path.as_deref() == Some(excluded.to_string_lossy().as_ref())
                && node.kind == CleanupNodeKind::Restricted
        }));
        assert!(scan.root.children.iter().any(|node| {
            node.path.as_deref() == Some(segment.join("available.bin").to_string_lossy().as_ref())
                && node.kind == CleanupNodeKind::File
        }));
        fs::remove_dir_all(base).unwrap();
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_trash_staging_restores_the_original_when_native_handoff_fails() {
        let root = test_root("macos-trash-rollback");
        let target_path = root.join("Downloads/archive.zip");
        fs::create_dir_all(target_path.parent().unwrap()).unwrap();
        fs::write(&target_path, b"archive").unwrap();
        let request = cleanup_delete_request(
            &root,
            vec![target_path.to_string_lossy().into_owned()],
            now_millis(),
        );
        let target = validate_cleanup_targets(&request, &root)
            .unwrap()
            .targets
            .remove(0);
        let home_root = DeleteRoot::open(&root.canonicalize().unwrap()).unwrap();
        let parent_relative = Path::new("Library/Application Support/CoreRobin/Pending Trash");
        let parent = home_root
            .open_subdirectory(parent_relative, true, true)
            .unwrap();
        let directory_name = "lease-test-rollback".to_owned();
        let staging_path = root.join(parent_relative).join(&directory_name);
        let staging = MacOSTrashStaging {
            root: parent
                .create_private_subdirectory(directory_name.as_ref())
                .unwrap(),
            path: staging_path.clone(),
            parent,
            directory_name,
        };

        let error = move_cleanup_target_via_macos_staging(&target, &staging, |_| {
            Err("simulated native Trash failure".to_owned())
        })
        .unwrap_err();

        assert!(error.contains("simulated native Trash failure"));
        assert!(error.contains("original item was restored"));
        assert_eq!(fs::read(&target_path).unwrap(), b"archive");
        assert!(fs::read_dir(&staging_path).unwrap().next().is_none());
        drop(staging);
        assert!(!staging_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_trash_staging_hands_off_the_verified_original_name() {
        let root = test_root("macos-trash-handoff");
        let target_path = root.join("Downloads/archive.zip");
        let simulated_trash = root.join("Simulated Trash");
        fs::create_dir_all(target_path.parent().unwrap()).unwrap();
        fs::create_dir_all(&simulated_trash).unwrap();
        fs::write(&target_path, b"archive").unwrap();
        let request = cleanup_delete_request(
            &root,
            vec![target_path.to_string_lossy().into_owned()],
            now_millis(),
        );
        let target = validate_cleanup_targets(&request, &root)
            .unwrap()
            .targets
            .remove(0);
        let home_root = DeleteRoot::open(&root.canonicalize().unwrap()).unwrap();
        let parent_relative = Path::new("Library/Application Support/CoreRobin/Pending Trash");
        let parent = home_root
            .open_subdirectory(parent_relative, true, true)
            .unwrap();
        let directory_name = "lease-test-handoff".to_owned();
        let staging_path = root.join(parent_relative).join(&directory_name);
        let staging = MacOSTrashStaging {
            root: parent
                .create_private_subdirectory(directory_name.as_ref())
                .unwrap(),
            path: staging_path.clone(),
            parent,
            directory_name,
        };

        let moved_bytes = move_cleanup_target_via_macos_staging(&target, &staging, |staged| {
            fs::rename(staged, simulated_trash.join("archive.zip"))
                .map_err(|error| error.to_string())
        })
        .unwrap();

        assert!(moved_bytes > 0);
        assert!(!target_path.exists());
        assert_eq!(
            fs::read(simulated_trash.join("archive.zip")).unwrap(),
            b"archive"
        );
        assert!(fs::read_dir(&staging_path).unwrap().next().is_none());
        drop(staging);
        assert!(!staging_path.exists());
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
    fn cleanup_delete_unlinks_nested_symbolic_links_without_following_them() {
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
    fn cleanup_delete_uses_current_contents_without_reconfirming() {
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
        let result = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                attempted = true;
                Ok(0)
            })
            .unwrap();

        assert_eq!(result.deleted.len(), 1);
        assert!(result.failed.is_empty());
        assert!(attempted);
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_treats_missing_selection_as_already_removed() {
        let root = test_root("trash-missing-before-lease");
        let existing = root.join("Downloads/existing.txt");
        let missing = root.join("Downloads/missing.txt");
        fs::create_dir_all(existing.parent().unwrap()).unwrap();
        fs::write(&existing, b"existing").unwrap();
        let existing_display = existing.to_string_lossy().into_owned();
        let missing_display = missing.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();

        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![missing_display.clone(), existing_display.clone()],
                    u64::MAX,
                ),
                &root,
            )
            .unwrap();

        assert!(lease.executable);
        assert_eq!(
            lease.paths,
            vec![missing_display.clone(), existing_display.clone()]
        );
        assert_eq!(lease.missing_paths, vec![missing_display.clone()]);
        assert!(lease.unavailable_paths.is_empty());
        assert_eq!(lease.refreshed_targets.len(), 1);

        let mut attempted = Vec::new();
        let result = controller
            .execute_with(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                |path| {
                    attempted.push(path.to_path_buf());
                    Ok(8)
                },
            )
            .unwrap();

        assert_eq!(attempted, vec![existing.canonicalize().unwrap()]);
        assert_eq!(result.deleted.len(), 2);
        assert!(
            result
                .deleted
                .iter()
                .any(|success| success.path == missing_display && success.deleted_bytes == 0)
        );
        assert!(
            result
                .deleted
                .iter()
                .any(|success| success.path == existing_display && success.deleted_bytes == 8)
        );
        assert_eq!(result.deleted_bytes, 8);
        assert!(result.failed.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_continues_when_a_confirmed_target_disappears() {
        let root = test_root("trash-missing-after-lease");
        let missing = root.join("Downloads/missing.txt");
        let existing = root.join("Downloads/existing.txt");
        fs::create_dir_all(missing.parent().unwrap()).unwrap();
        fs::write(&missing, b"remove me first").unwrap();
        fs::write(&existing, b"existing").unwrap();
        let missing_display = missing.to_string_lossy().into_owned();
        let existing_display = existing.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![missing_display.clone(), existing_display.clone()],
                    u64::MAX,
                ),
                &root,
            )
            .unwrap();
        assert!(lease.executable);
        fs::remove_file(&missing).unwrap();

        let mut attempted = Vec::new();
        let result = controller
            .execute_with(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                |path| {
                    attempted.push(path.to_path_buf());
                    Ok(8)
                },
            )
            .unwrap();

        assert_eq!(attempted, vec![existing.canonicalize().unwrap()]);
        assert_eq!(result.deleted.len(), 2);
        assert!(
            result
                .deleted
                .iter()
                .any(|success| success.path == missing_display && success.deleted_bytes == 0)
        );
        assert!(
            result
                .deleted
                .iter()
                .any(|success| success.path == existing_display && success.deleted_bytes == 8)
        );
        assert!(result.failed.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_keeps_processing_targets_that_changed_after_confirmation() {
        let root = test_root("trash-partial-revalidation");
        let changed = root.join("Downloads/changed.txt");
        let existing = root.join("Downloads/existing.txt");
        fs::create_dir_all(changed.parent().unwrap()).unwrap();
        fs::write(&changed, b"before").unwrap();
        fs::write(&existing, b"existing").unwrap();
        let changed_display = changed.to_string_lossy().into_owned();
        let existing_display = existing.to_string_lossy().into_owned();
        let mut controller = CleanupDeleteController::default();
        let lease = controller
            .create_lease_for_home(
                cleanup_delete_request(
                    &root,
                    vec![changed_display.clone(), existing_display.clone()],
                    u64::MAX,
                ),
                &root,
            )
            .unwrap();
        assert!(lease.executable);
        std::thread::sleep(Duration::from_millis(5));
        fs::write(&changed, b"changed after confirmation").unwrap();

        let mut attempted = Vec::new();
        let result = controller
            .execute_with(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                |path| {
                    attempted.push(path.to_path_buf());
                    Ok(8)
                },
            )
            .unwrap();

        assert_eq!(
            attempted,
            vec![
                changed.canonicalize().unwrap(),
                existing.canonicalize().unwrap()
            ]
        );
        assert_eq!(result.deleted.len(), 2);
        assert!(
            result
                .deleted
                .iter()
                .any(|success| success.path == changed_display)
        );
        assert!(
            result
                .deleted
                .iter()
                .any(|success| success.path == existing_display)
        );
        assert!(result.failed.is_empty());
        assert!(changed.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_delete_continues_when_one_selected_target_is_inaccessible() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_root("trash-partial-permission");
        let locked_parent = root.join("Downloads/locked");
        let inaccessible = locked_parent.join("inaccessible.txt");
        let existing = root.join("Downloads/existing.txt");
        fs::create_dir_all(&locked_parent).unwrap();
        fs::write(&inaccessible, b"inaccessible").unwrap();
        fs::write(&existing, b"existing").unwrap();
        let inaccessible_display = inaccessible.to_string_lossy().into_owned();
        let existing_display = existing.to_string_lossy().into_owned();
        let request = cleanup_delete_request(
            &root,
            vec![inaccessible_display.clone(), existing_display.clone()],
            u64::MAX,
        );
        fs::set_permissions(&locked_parent, fs::Permissions::from_mode(0o000)).unwrap();
        let mut controller = CleanupDeleteController::default();
        let lease_result = controller.create_lease_for_home(request, &root);
        fs::set_permissions(&locked_parent, fs::Permissions::from_mode(0o700)).unwrap();
        let lease = lease_result.unwrap();

        assert!(lease.executable);
        assert!(lease.missing_paths.is_empty());
        assert_eq!(lease.unavailable_paths, vec![inaccessible_display.clone()]);

        let mut attempted = Vec::new();
        let result = controller
            .execute_with(
                CleanupDeleteExecutionRequest { lease_id: lease.id },
                |path| {
                    attempted.push(path.to_path_buf());
                    Ok(8)
                },
            )
            .unwrap();

        assert_eq!(attempted, vec![existing.canonicalize().unwrap()]);
        assert_eq!(result.deleted.len(), 1);
        assert_eq!(result.deleted[0].path, existing_display);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, inaccessible_display);
        assert!(inaccessible.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_delete_does_not_rescan_deep_contents_after_confirmation() {
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
        let result = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                attempted = true;
                Ok(0)
            })
            .unwrap();

        assert_eq!(result.deleted.len(), 1);
        assert!(result.failed.is_empty());
        assert!(attempted);
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_lease_reuses_scan_evidence_without_recursive_refresh() {
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

        assert!(lease.executable);
        assert!(lease.changed_paths.is_empty());
        assert_eq!(lease.refreshed_targets[0].item_count, 1);
        let mut attempted = false;
        let result = controller
            .execute_with(CleanupDeleteExecutionRequest { lease_id: lease.id }, |_| {
                attempted = true;
                Ok(0)
            })
            .unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(result.failed.is_empty());
        assert!(attempted);
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
