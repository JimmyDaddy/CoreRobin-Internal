use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use std::process::Command;

use crate::error::CommandError;
use crate::models::{
    CleanupApplication, CleanupFile, CleanupLocation, CleanupLocationKind, CleanupNode,
    CleanupPathState, CleanupSafety, CleanupScan, CleanupScanProgress,
    CleanupTrashExecutionRequest, CleanupTrashFailure, CleanupTrashLease, CleanupTrashLeaseRequest,
    CleanupTrashResult,
};

const LARGE_FILE_THRESHOLD_BYTES: u64 = 500 * 1_024 * 1_024;
const MAX_LARGE_FILES: usize = 12;
const MAX_UNREADABLE_PATHS: usize = 12;
const MAX_CHART_CHILDREN: usize = 18;
const PROGRESS_INTERVAL_ENTRIES: usize = 512;
const CLEANUP_LEASE_TTL: Duration = Duration::from_secs(60);
const MAX_CLEANUP_TARGETS: usize = 32;
const MAX_CLEANUP_LEASES: usize = 8;
static NEXT_CLEANUP_LEASE_ID: AtomicU64 = AtomicU64::new(1);

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
pub struct CleanupTrashController {
    leases: Vec<CleanupTrashLeaseEntry>,
}

#[derive(Clone, Debug)]
struct CleanupTrashTarget {
    display_path: String,
    canonical_path: PathBuf,
    modified_at_ms: Option<u64>,
}

#[derive(Debug)]
struct CleanupTrashLeaseEntry {
    id: String,
    expires_at: Instant,
    targets: Vec<CleanupTrashTarget>,
}

impl CleanupTrashController {
    pub fn create_lease(
        &mut self,
        request: CleanupTrashLeaseRequest,
    ) -> Result<CleanupTrashLease, CommandError> {
        let home = home_directory().ok_or_else(|| {
            CommandError::new(
                "home_directory_unavailable",
                "Pulse could not locate the current user's home directory.",
            )
        })?;
        self.create_lease_for_home(request, &home)
    }

    pub fn release_lease(&mut self, lease_id: &str) {
        if let Some(position) = self.leases.iter().position(|lease| lease.id == lease_id) {
            self.leases.remove(position);
        }
    }

    pub fn execute(
        &mut self,
        request: CleanupTrashExecutionRequest,
    ) -> Result<CleanupTrashResult, CommandError> {
        self.execute_with(request, |path| {
            trash::delete(path).map_err(|error| error.to_string())
        })
    }

    fn create_lease_for_home(
        &mut self,
        request: CleanupTrashLeaseRequest,
        home: &Path,
    ) -> Result<CleanupTrashLease, CommandError> {
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
        self.leases.push(CleanupTrashLeaseEntry {
            id: id.clone(),
            expires_at,
            targets: targets.clone(),
        });
        Ok(CleanupTrashLease {
            id,
            paths: targets
                .iter()
                .map(|target| target.display_path.clone())
                .collect(),
            changed_paths,
            expires_at_ms: now_millis().saturating_add(CLEANUP_LEASE_TTL.as_millis() as u64),
        })
    }

    fn execute_with<F>(
        &mut self,
        request: CleanupTrashExecutionRequest,
        mut move_to_trash: F,
    ) -> Result<CleanupTrashResult, CommandError>
    where
        F: FnMut(&Path) -> Result<(), String>,
    {
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

        let mut moved_paths = Vec::new();
        let mut failed = Vec::new();
        for target in lease.targets {
            match move_to_trash(&target.canonical_path) {
                Ok(()) => moved_paths.push(target.display_path),
                Err(message) => failed.push(CleanupTrashFailure {
                    path: target.display_path,
                    message,
                }),
            }
        }
        Ok(CleanupTrashResult {
            moved_paths,
            failed,
        })
    }
}

pub fn scan_cleanup(
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "Pulse could not locate the current user's home directory.",
        )
    })?;
    scan_home(&home, platform_paths(&home), true, cancelled, on_progress)
}

pub fn inspect_cleanup_path(display_path: &str) -> Result<CleanupPathState, CommandError> {
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "Pulse could not locate the current user's home directory.",
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

fn validate_cleanup_targets(
    request: &CleanupTrashLeaseRequest,
    home: &Path,
) -> Result<Vec<CleanupTrashTarget>, CommandError> {
    if request.paths.is_empty() || request.paths.len() > MAX_CLEANUP_TARGETS {
        return Err(CommandError::new(
            "invalid_cleanup_selection",
            format!("Choose between 1 and {MAX_CLEANUP_TARGETS} cleanup items before continuing."),
        ));
    }
    let canonical_home = home.canonicalize().map_err(|error| {
        CommandError::new(
            "home_directory_unavailable",
            format!("Pulse could not verify the home directory: {error}"),
        )
    })?;
    let trash_roots = trash_paths(&canonical_home);
    let mut seen = HashSet::new();
    let mut targets = Vec::with_capacity(request.paths.len());
    for display in &request.paths {
        let path = expand_cleanup_path(display, &canonical_home)?;
        if path == canonical_home || trash_roots.iter().any(|root| path.starts_with(root)) {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "Pulse will not move the home directory or content that is already in the Trash.",
            ));
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            CommandError::new(
                "cleanup_target_unavailable",
                format!("Pulse could not inspect {display}: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err(CommandError::new(
                "unsupported_cleanup_target",
                format!("Pulse will not move links or special files: {display}"),
            ));
        }
        let canonical_path = path.canonicalize().map_err(|error| {
            CommandError::new(
                "cleanup_target_unavailable",
                format!("Pulse could not verify {display}: {error}"),
            )
        })?;
        if canonical_path == canonical_home
            || trash_roots
                .iter()
                .any(|root| canonical_path.starts_with(root))
        {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "Pulse will not move the home directory or content that is already in the Trash.",
            ));
        }
        if !canonical_path.starts_with(&canonical_home) {
            return Err(CommandError::new(
                "cleanup_target_outside_home",
                format!("Pulse only moves items inside your home folder: {display}"),
            ));
        }
        if !seen.insert(canonical_path.clone()) {
            return Err(CommandError::new(
                "duplicate_cleanup_target",
                format!("The cleanup selection contains the same item more than once: {display}"),
            ));
        }
        targets.push(CleanupTrashTarget {
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
            format!("Pulse could not resolve this cleanup path: {display_path}"),
        ));
    }
    Ok(path)
}

fn revalidate_cleanup_target(target: &CleanupTrashTarget) -> Result<(), CommandError> {
    let metadata = fs::symlink_metadata(&target.canonical_path).map_err(|error| {
        CommandError::new(
            "cleanup_target_changed",
            format!(
                "{} changed after confirmation; Pulse moved nothing. Review the selection again: {error}",
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
                "{} changed after confirmation; Pulse moved nothing. Review the selection again.",
                target.display_path
            ),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct LocationDefinition {
    kind: CleanupLocationKind,
    paths: Vec<PathBuf>,
    safety: CleanupSafety,
    collect_large_files: bool,
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
struct PathSummary {
    size_bytes: u64,
    item_count: usize,
    direct_children: HashMap<PathBuf, NodeAggregate>,
}

#[derive(Default)]
struct NodeAggregate {
    size_bytes: u64,
    item_count: usize,
}

struct ScanContext<'a> {
    stats: &'a mut ScanStats,
    largest_files: &'a mut Vec<CleanupFile>,
    home: &'a Path,
    cancelled: &'a AtomicBool,
    on_progress: &'a mut dyn FnMut(CleanupScanProgress),
}

fn scan_home(
    home: &Path,
    definitions: Vec<LocationDefinition>,
    include_application_inventory: bool,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    let mut stats = ScanStats::new();
    let mut largest_files = Vec::new();
    let mut locations = Vec::new();
    stats.report_progress(home, home, on_progress, true);

    {
        let mut context = ScanContext {
            stats: &mut stats,
            largest_files: &mut largest_files,
            home,
            cancelled,
            on_progress,
        };
        for definition in definitions {
            let mut summary = LocationSummary::default();
            for path in &definition.paths {
                let path_summary =
                    scan_path(path, definition.collect_large_files, true, &mut context)?;
                if path.is_dir() {
                    summary.available = true;
                    summary.size_bytes = summary.size_bytes.saturating_add(path_summary.size_bytes);
                    summary.item_count += path_summary.item_count;
                    summary.nodes.push(cleanup_root_node(
                        path,
                        path_summary,
                        definition.safety,
                        home,
                    ));
                }
            }
            locations.push(CleanupLocation {
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
            });
        }

        for path in large_file_roots(home) {
            scan_path(&path, true, false, &mut context)?;
        }
    }

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

    stats.report_progress(home, home, on_progress, true);

    Ok(CleanupScan {
        sampled_at_ms: now_millis(),
        duration_ms: stats.elapsed_ms(),
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
    context: &mut ScanContext<'_>,
) -> Result<PathSummary, CommandError> {
    let mut summary = PathSummary::default();
    if !root.is_dir() {
        return Ok(summary);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        ensure_scan_active(context.cancelled)?;
        context
            .stats
            .report_progress(&directory, context.home, context.on_progress, false);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
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
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    context.stats.record_unreadable(&entry.path());
                    continue;
                }
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    context.stats.record_unreadable(&entry.path());
                    continue;
                }
            };
            let size_bytes = metadata.len();
            summary.size_bytes = summary.size_bytes.saturating_add(size_bytes);
            summary.item_count += 1;
            if count_discovered_bytes {
                context.stats.discovered_bytes =
                    context.stats.discovered_bytes.saturating_add(size_bytes);
            }
            let entry_path = entry.path();
            if let Some(direct_child) = direct_child_path(root, &entry_path) {
                let aggregate = summary.direct_children.entry(direct_child).or_default();
                aggregate.size_bytes = aggregate.size_bytes.saturating_add(size_bytes);
                aggregate.item_count += 1;
            }
            if collect_large_files && size_bytes >= LARGE_FILE_THRESHOLD_BYTES {
                context.largest_files.push(CleanupFile {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry_path.to_string_lossy().into_owned(),
                    size_bytes,
                    modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
                });
            }
            context
                .stats
                .report_progress(&directory, context.home, context.on_progress, false);
        }
    }
    Ok(summary)
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

fn direct_child_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(root).ok()?;
    relative
        .components()
        .next()
        .map(|component| root.join(component))
}

fn cleanup_root_node(
    root: &Path,
    summary: PathSummary,
    safety: CleanupSafety,
    home: &Path,
) -> CleanupNode {
    let root_path = display_path(root, home);
    let mut children = summary.direct_children.into_iter().collect::<Vec<_>>();
    children.sort_by_key(|(_, aggregate)| Reverse(aggregate.size_bytes));
    let omitted = children.split_off(children.len().min(MAX_CHART_CHILDREN));
    let mut nodes = children
        .into_iter()
        .map(|(path, aggregate)| CleanupNode {
            id: display_path(&path, home),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| display_path(&path, home)),
            path: Some(display_path(&path, home)),
            size_bytes: aggregate.size_bytes,
            item_count: aggregate.item_count,
            safety,
            children: Vec::new(),
        })
        .collect::<Vec<_>>();
    if !omitted.is_empty() {
        nodes.push(CleanupNode {
            id: format!("{root_path}::other"),
            name: "other".to_owned(),
            path: None,
            size_bytes: omitted.iter().fold(0_u64, |total, (_, item)| {
                total.saturating_add(item.size_bytes)
            }),
            item_count: omitted.iter().map(|(_, item)| item.item_count).sum(),
            safety,
            children: Vec::new(),
        });
    }
    CleanupNode {
        id: root_path.clone(),
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_path.clone()),
        path: Some(root_path),
        size_bytes: summary.size_bytes,
        item_count: summary.item_count,
        safety,
        children: nodes,
    }
}

fn platform_paths(home: &Path) -> Vec<LocationDefinition> {
    vec![
        LocationDefinition {
            kind: CleanupLocationKind::Downloads,
            paths: vec![home.join("Downloads")],
            safety: CleanupSafety::Review,
            collect_large_files: true,
        },
        LocationDefinition {
            kind: CleanupLocationKind::Trash,
            paths: trash_paths(home),
            safety: CleanupSafety::Reclaimable,
            collect_large_files: false,
        },
        LocationDefinition {
            kind: CleanupLocationKind::AppCache,
            paths: app_cache_paths(home),
            safety: CleanupSafety::Reclaimable,
            collect_large_files: false,
        },
        LocationDefinition {
            kind: CleanupLocationKind::DeveloperCache,
            paths: developer_cache_paths(home),
            safety: CleanupSafety::Reclaimable,
            collect_large_files: false,
        },
        LocationDefinition {
            kind: CleanupLocationKind::HiddenData,
            paths: hidden_user_paths(home),
            safety: CleanupSafety::Review,
            collect_large_files: true,
        },
    ]
}

fn large_file_roots(home: &Path) -> Vec<PathBuf> {
    ["Desktop", "Documents", "Movies"]
        .iter()
        .map(|name| home.join(name))
        .collect()
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
        home.join(".cache"),
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

fn display_path(path: &Path, home: &Path) -> String {
    path.strip_prefix(home)
        .map(|relative| format!("~/{}", relative.to_string_lossy()))
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
    use std::fs::{self, File};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

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
        File::create(downloads.join("large.zip"))
            .unwrap()
            .set_len(LARGE_FILE_THRESHOLD_BYTES + 1)
            .unwrap();
        fs::write(trash.join("old.txt"), b"old").unwrap();

        let scan = scan_for_test(
            &root,
            vec![
                LocationDefinition {
                    kind: CleanupLocationKind::Downloads,
                    paths: vec![downloads],
                    safety: CleanupSafety::Review,
                    collect_large_files: true,
                },
                LocationDefinition {
                    kind: CleanupLocationKind::Trash,
                    paths: vec![trash],
                    safety: CleanupSafety::Reclaimable,
                    collect_large_files: false,
                },
            ],
        );

        assert_eq!(scan.locations.len(), 2);
        assert_eq!(scan.locations[0].item_count, 1);
        assert_eq!(scan.locations[0].safety, CleanupSafety::Review);
        assert_eq!(scan.locations[1].size_bytes, 3);
        assert_eq!(scan.locations[0].nodes.len(), 1);
        assert_eq!(scan.locations[0].nodes[0].children.len(), 1);
        assert_eq!(scan.largest_files.len(), 1);
        assert!(scan.deletion_available);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_trash_confirmation_is_single_use_and_bound_to_the_selected_path() {
        let root = test_root("trash-lease");
        let target = root.join("Downloads/archive.zip");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"archive").unwrap();
        let display = target.to_string_lossy().into_owned();
        let mut controller = CleanupTrashController::default();

        let lease = controller
            .create_lease_for_home(
                CleanupTrashLeaseRequest {
                    paths: vec![display.clone()],
                    scan_sampled_at_ms: 0,
                },
                &root,
            )
            .unwrap();

        assert_eq!(lease.paths, vec![display.clone()]);
        assert_eq!(lease.changed_paths, vec![display.clone()]);
        let mut moved = Vec::new();
        let result = controller
            .execute_with(
                CleanupTrashExecutionRequest {
                    lease_id: lease.id.clone(),
                },
                |path| {
                    moved.push(path.to_path_buf());
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(result.moved_paths, vec![display]);
        assert!(result.failed.is_empty());
        assert_eq!(moved, vec![target.canonicalize().unwrap()]);

        let error = controller
            .execute_with(CleanupTrashExecutionRequest { lease_id: lease.id }, |_| {
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, "cleanup_confirmation_unavailable");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_trash_rejects_home_trash_and_overlapping_paths() {
        let root = test_root("trash-protected");
        let folder = root.join("Downloads");
        let child = folder.join("file.txt");
        let trash = root.join(".Trash");
        fs::create_dir_all(&folder).unwrap();
        fs::create_dir_all(&trash).unwrap();
        fs::write(&child, b"file").unwrap();
        fs::write(trash.join("old.txt"), b"old").unwrap();
        let mut controller = CleanupTrashController::default();

        let home_error = controller
            .create_lease_for_home(
                CleanupTrashLeaseRequest {
                    paths: vec![root.to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(home_error.code, "protected_cleanup_path");

        let trash_error = controller
            .create_lease_for_home(
                CleanupTrashLeaseRequest {
                    paths: vec![trash.join("old.txt").to_string_lossy().into_owned()],
                    scan_sampled_at_ms: now_millis(),
                },
                &root,
            )
            .unwrap_err();
        assert_eq!(trash_error.code, "protected_cleanup_path");

        let overlap_error = controller
            .create_lease_for_home(
                CleanupTrashLeaseRequest {
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
    fn cleanup_trash_revalidates_targets_after_confirmation() {
        let root = test_root("trash-revalidate");
        let target = root.join("Downloads");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("before.txt"), b"before").unwrap();
        let mut controller = CleanupTrashController::default();
        let lease = controller
            .create_lease_for_home(
                CleanupTrashLeaseRequest {
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
            .execute_with(CleanupTrashExecutionRequest { lease_id: lease.id }, |_| {
                attempted = true;
                Ok(())
            })
            .unwrap_err();

        assert_eq!(error.code, "cleanup_target_changed");
        assert!(!attempted);
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_trash_reports_partial_platform_failures() {
        let root = test_root("trash-partial");
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let mut controller = CleanupTrashController::default();
        let lease = controller
            .create_lease_for_home(
                CleanupTrashLeaseRequest {
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
                CleanupTrashExecutionRequest { lease_id: lease.id },
                |path| {
                    if path.ends_with("second.txt") {
                        Err("simulated platform refusal".to_owned())
                    } else {
                        Ok(())
                    }
                },
            )
            .unwrap();

        assert_eq!(result.moved_paths.len(), 1);
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
                collect_large_files: true,
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
                collect_large_files: false,
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
        env::temp_dir().join(format!("pulse-cleanup-{suffix}-{nonce}"))
    }
}
