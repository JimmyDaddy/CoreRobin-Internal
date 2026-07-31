use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use sysinfo::{DiskKind, Disks};

use crate::error::CommandError;
use crate::models::{
    CleanupApplication, CleanupDeleteLeaseRequest, CleanupDeleteTargetEvidence, CleanupFile,
    CleanupIndexedChildrenPage, CleanupLocation, CleanupLocationKind, CleanupNode, CleanupNodeKind,
    CleanupProtectionReason, CleanupSafety, CleanupScan, CleanupScanIndexSummary,
    CleanupScanProfile, CleanupScanProgress, CleanupScanRequest, CleanupScanTargetKind,
};

use super::{
    LARGE_FILE_THRESHOLD_BYTES, MAX_LARGE_FILES, MAX_UNREADABLE_PATHS, ScanFilesystemBoundary,
    allocated_file_size, cleanup_node_name, cleanup_protection_for_scan_path, display_path,
    ensure_scan_active, home_directory, is_cloud_backed_cleanup_root, is_excluded_scan_namespace,
    matching_location_definition, platform_paths, resolve_cleanup_scan_target, system_time_millis,
};

const SCHEMA_VERSION: i64 = 2;
const DETAIL_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DIRECTORY_PAGE_SIZE: usize = 24;
const VISIBLE_FILES_PER_DIRECTORY: usize = 128;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
struct IndexedFile {
    name: String,
    absolute_path: String,
    display_path: String,
    logical_size_bytes: u64,
    allocated_size_bytes: u64,
    modified_at_ms: Option<u64>,
    safety: CleanupSafety,
    deletion_protected: bool,
    protection_reason: Option<CleanupProtectionReason>,
    device_id: Option<i64>,
    inode: Option<i64>,
}

#[derive(Clone, Debug, Default)]
struct DirectoryTotals {
    logical_size_bytes: u64,
    allocated_size_bytes: u64,
    item_count: usize,
    direct_child_count: usize,
    omitted_file_logical_bytes: u64,
    omitted_file_allocated_bytes: u64,
    omitted_file_count: usize,
}

#[derive(Debug)]
struct IndexScanStats {
    started: Instant,
    scanned_entry_count: usize,
    discovered_bytes: u64,
    unreadable_entry_count: usize,
    unreadable_paths: Vec<String>,
    last_reported_entry_count: usize,
    largest_files: Vec<CleanupFile>,
    location_totals: HashMap<CleanupLocationKind, (u64, usize)>,
}

impl IndexScanStats {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            scanned_entry_count: 0,
            discovered_bytes: 0,
            unreadable_entry_count: 0,
            unreadable_paths: Vec::new(),
            last_reported_entry_count: 0,
            largest_files: Vec::new(),
            location_totals: HashMap::new(),
        }
    }

    fn record_unreadable(&mut self, path: &Path, home: &Path) {
        self.unreadable_entry_count = self.unreadable_entry_count.saturating_add(1);
        if self.unreadable_paths.len() < MAX_UNREADABLE_PATHS {
            self.unreadable_paths.push(display_path(path, home));
        }
    }

    fn record_file(
        &mut self,
        path: &Path,
        home: &Path,
        definitions: &[super::LocationDefinition],
        allocated_size_bytes: u64,
    ) {
        self.discovered_bytes = self.discovered_bytes.saturating_add(allocated_size_bytes);
        if let Some((_, definition)) = matching_location_definition(definitions, path) {
            let totals = self.location_totals.entry(definition.kind).or_default();
            totals.0 = totals.0.saturating_add(allocated_size_bytes);
            totals.1 = totals.1.saturating_add(1);
        }
        if allocated_size_bytes >= LARGE_FILE_THRESHOLD_BYTES {
            let modified_at_ms = fs::metadata(path)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(system_time_millis);
            self.largest_files.push(CleanupFile {
                name: cleanup_node_name(path),
                path: path.to_string_lossy().into_owned(),
                size_bytes: allocated_size_bytes,
                modified_at_ms,
            });
            self.largest_files
                .sort_by_key(|file| Reverse(file.size_bytes));
            self.largest_files.truncate(MAX_LARGE_FILES);
        }
        let _ = home;
    }

    fn report(
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
                < 512
        {
            return;
        }
        self.last_reported_entry_count = self.scanned_entry_count;
        on_progress(CleanupScanProgress {
            scanned_entry_count: self.scanned_entry_count,
            discovered_bytes: self.discovered_bytes,
            current_path: display_path(path, home),
            elapsed_ms: self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        });
    }
}

struct ScanContext<'a> {
    scan_id: &'a str,
    home: &'a Path,
    scan_root: &'a Path,
    protection_root: &'a Path,
    selected_cleanup_root: bool,
    boundary: ScanFilesystemBoundary,
    definitions: &'a [super::LocationDefinition],
    excluded_paths: &'a [PathBuf],
    cancelled: &'a AtomicBool,
    seen_files: &'a mut HashSet<super::FileIdentity>,
    shared_seen_files: Option<&'a Arc<Mutex<HashSet<super::FileIdentity>>>>,
    stats: &'a mut IndexScanStats,
    on_progress: &'a mut dyn FnMut(CleanupScanProgress),
}

pub(crate) fn build_indexed_scan(
    request: CleanupScanRequest,
    scan_id: &str,
    index_path: &Path,
    cancelled: &AtomicBool,
    excluded_paths: &[PathBuf],
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    build_indexed_scan_with_shared_identities(
        request,
        scan_id,
        index_path,
        cancelled,
        excluded_paths,
        on_progress,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_indexed_scan_with_shared_identities(
    request: CleanupScanRequest,
    scan_id: &str,
    index_path: &Path,
    cancelled: &AtomicBool,
    excluded_paths: &[PathBuf],
    on_progress: &mut dyn FnMut(CleanupScanProgress),
    shared_seen_files: Option<&Arc<Mutex<HashSet<super::FileIdentity>>>>,
) -> Result<CleanupScan, CommandError> {
    #[cfg(target_os = "macos")]
    let _activity = super::CleanupScanActivity::begin();
    if request.profile == CleanupScanProfile::CommonLocations
        && request.target_kind != CleanupScanTargetKind::SystemDisk
    {
        return Err(CommandError::new(
            "cleanup_quick_scan_target_invalid",
            "Quick scan is only available for the system disk.",
        ));
    }
    let (home, scan_root, target_kind) = resolve_cleanup_scan_target(&request)?;
    ensure_private_index_parent(index_path)?;
    let scan_exclusions = cleanup_scan_exclusions(index_path, &scan_root, excluded_paths);
    let mut connection = open_index(index_path)?;
    initialize_schema(&connection)?;
    purge_expired_and_incomplete(&connection)?;

    let definitions = platform_paths(&home);
    let scope_paths = if request.profile == CleanupScanProfile::CommonLocations {
        common_location_roots(&home, &scan_root)?
    } else {
        Vec::new()
    };
    let root_path = display_path(&scan_root, &home);
    let root_name = if request.profile == CleanupScanProfile::CommonLocations {
        "Common locations".to_owned()
    } else {
        cleanup_node_name(&scan_root)
    };
    let root_absolute_path = scan_root.to_string_lossy().into_owned();
    prepare_scan(
        &connection,
        scan_id,
        request.profile,
        target_kind,
        &root_absolute_path,
        &root_name,
        &root_path,
        &scope_paths,
    )?;

    let boundary = ScanFilesystemBoundary::for_root(&scan_root)?;
    let mut seen_files = load_seen_files(&connection, scan_id)?;
    let mut stats = IndexScanStats::new();
    restore_completed_segment_stats(&connection, scan_id, &mut stats)?;
    let root_id = root_node_id(&connection, scan_id)?;
    let selected_cleanup_root = target_kind != CleanupScanTargetKind::SystemDisk;
    let roots = if request.profile == CleanupScanProfile::CommonLocations {
        scope_paths.clone()
    } else {
        scan_root_children(&scan_root, boundary, cancelled)?
    };

    if request.profile == CleanupScanProfile::CommonLocations {
        remove_quick_part_indexes(index_path)?;
        scan_quick_roots_parallel(
            &mut connection,
            index_path,
            scan_id,
            root_id,
            &roots,
            &home,
            &scan_root,
            &definitions,
            &scan_exclusions,
            cancelled,
            &mut stats,
            on_progress,
        )?;
    } else {
        for root in roots {
            scan_root_segment(
                &mut connection,
                scan_id,
                root_id,
                &root,
                &home,
                &scan_root,
                selected_cleanup_root,
                boundary,
                &definitions,
                &scan_exclusions,
                cancelled,
                &mut seen_files,
                shared_seen_files,
                &mut stats,
                on_progress,
            )?;
        }
    }

    if request.profile == CleanupScanProfile::Complete {
        let transaction = connection.transaction().map_err(index_error)?;
        let mut context = ScanContext {
            scan_id,
            home: &home,
            scan_root: &scan_root,
            protection_root: &scan_root,
            selected_cleanup_root,
            boundary,
            definitions: &definitions,
            excluded_paths: &scan_exclusions,
            cancelled,
            seen_files: &mut seen_files,
            shared_seen_files,
            stats: &mut stats,
            on_progress,
        };
        scan_direct_files_into_index(
            &transaction,
            root_id,
            &scan_root,
            CleanupSafety::Review,
            &mut context,
        )?;
        transaction.commit().map_err(index_error)?;
    }

    ensure_scan_active(cancelled)?;
    update_root_totals(&connection, scan_id, root_id)?;
    let completed_at_ms = now_millis_i64();
    connection
        .execute(
            "UPDATE scans
             SET state = 'completed', sampled_at_ms = ?2, duration_ms = ?3,
                 scanned_entry_count = ?4, unreadable_entry_count = ?5,
                 unreadable_paths_json = ?6
             WHERE id = ?1",
            params![
                scan_id,
                completed_at_ms,
                elapsed_millis(stats.started),
                to_i64(stats.scanned_entry_count as u64),
                to_i64(stats.unreadable_entry_count as u64),
                serde_json::to_string(&stats.unreadable_paths).unwrap_or_else(|_| "[]".to_owned()),
            ],
        )
        .map_err(index_error)?;
    replace_scan_locations_from_index(&connection, scan_id, &definitions)?;
    rebuild_largest_files(&connection, scan_id)?;
    retire_previous_detailed_scans(&connection, scan_id, target_kind, &root_absolute_path)?;
    checkpoint_index(&connection)?;
    enforce_private_index_permissions(index_path)?;
    load_scan(&connection, index_path, scan_id)
}

#[allow(clippy::too_many_arguments)]
fn scan_root_segment(
    connection: &mut Connection,
    scan_id: &str,
    root_id: i64,
    root: &Path,
    home: &Path,
    scan_root: &Path,
    selected_cleanup_root: bool,
    boundary: ScanFilesystemBoundary,
    definitions: &[super::LocationDefinition],
    excluded_paths: &[PathBuf],
    cancelled: &AtomicBool,
    seen_files: &mut HashSet<super::FileIdentity>,
    shared_seen_files: Option<&Arc<Mutex<HashSet<super::FileIdentity>>>>,
    stats: &mut IndexScanStats,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<(), CommandError> {
    ensure_scan_active(cancelled)?;
    let absolute = root.to_string_lossy().into_owned();
    if completed_segment(connection, scan_id, &absolute)? {
        return Ok(());
    }
    let transaction = connection.transaction().map_err(index_error)?;
    let segment_scanned_before = stats.scanned_entry_count;
    let segment_discovered_before = stats.discovered_bytes;
    let segment_unreadable_before = stats.unreadable_entry_count;
    let segment_unreadable_paths_before = stats.unreadable_paths.len();
    let safety = matching_location_definition(definitions, root)
        .map_or(CleanupSafety::Review, |(_, definition)| definition.safety);
    let mut context = ScanContext {
        scan_id,
        home,
        scan_root,
        protection_root: scan_root,
        selected_cleanup_root,
        boundary,
        definitions,
        excluded_paths,
        cancelled,
        seen_files,
        shared_seen_files,
        stats,
        on_progress,
    };
    scan_directory_into_index(&transaction, root_id, root, safety, &mut context)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO scan_segments(
               scan_id, path, completed_at_ms, scanned_entry_count,
               discovered_bytes, unreadable_entry_count, unreadable_paths_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                scan_id,
                absolute,
                now_millis_i64(),
                to_i64(
                    stats
                        .scanned_entry_count
                        .saturating_sub(segment_scanned_before) as u64
                ),
                to_i64(
                    stats
                        .discovered_bytes
                        .saturating_sub(segment_discovered_before)
                ),
                to_i64(
                    stats
                        .unreadable_entry_count
                        .saturating_sub(segment_unreadable_before) as u64
                ),
                serde_json::to_string(&stats.unreadable_paths[segment_unreadable_paths_before..])
                    .unwrap_or_else(|_| "[]".to_owned()),
            ],
        )
        .map_err(index_error)?;
    transaction.commit().map_err(index_error)
}

struct QuickScanPart {
    index_path: PathBuf,
    scan: CleanupScan,
    root_path: PathBuf,
}

#[allow(clippy::too_many_arguments)]
fn scan_quick_roots_parallel(
    connection: &mut Connection,
    index_path: &Path,
    scan_id: &str,
    root_id: i64,
    roots: &[PathBuf],
    home: &Path,
    scan_root: &Path,
    definitions: &[super::LocationDefinition],
    excluded_paths: &[PathBuf],
    cancelled: &AtomicBool,
    stats: &mut IndexScanStats,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<(), CommandError> {
    let parallelism = quick_scan_parallelism(scan_root);
    let shared_seen_files = Arc::new(Mutex::new(load_seen_files(connection, scan_id)?));
    let pending = roots
        .iter()
        .filter_map(|root| {
            let absolute = root.to_string_lossy().into_owned();
            match completed_segment(connection, scan_id, &absolute) {
                Ok(false) => Some(Ok(root.clone())),
                Ok(true) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (wave_index, wave) in pending.chunks(parallelism).enumerate() {
        ensure_scan_active(cancelled)?;
        let base_scanned = stats.scanned_entry_count;
        let base_discovered = stats.discovered_bytes;
        let parts = match thread::scope(|scope| -> Result<Vec<QuickScanPart>, CommandError> {
            let (sender, receiver) = mpsc::channel::<(usize, CleanupScanProgress)>();
            let handles = wave
                .iter()
                .enumerate()
                .map(|(slot, root)| {
                    let sender = sender.clone();
                    let root = root.clone();
                    let part_path = quick_part_index_path(
                        index_path,
                        scan_id,
                        wave_index.saturating_mul(parallelism).saturating_add(slot),
                    );
                    let shared_seen_files = Arc::clone(&shared_seen_files);
                    scope.spawn(move || {
                        remove_cleanup_index(&part_path)?;
                        let part_scan_id = format!("quick-part-{wave_index}-{slot}");
                        let scan = build_indexed_scan_with_shared_identities(
                            CleanupScanRequest {
                                profile: CleanupScanProfile::Complete,
                                target_kind: CleanupScanTargetKind::Folder,
                                target_path: Some(root.to_string_lossy().into_owned()),
                            },
                            &part_scan_id,
                            &part_path,
                            cancelled,
                            excluded_paths,
                            &mut |progress| {
                                let _ = sender.send((slot, progress));
                            },
                            Some(&shared_seen_files),
                        )?;
                        Ok::<_, CommandError>(QuickScanPart {
                            index_path: part_path,
                            scan,
                            root_path: root,
                        })
                    })
                })
                .collect::<Vec<_>>();
            drop(sender);
            let mut latest = HashMap::<usize, CleanupScanProgress>::new();
            while let Ok((slot, progress)) = receiver.recv() {
                latest.insert(slot, progress.clone());
                on_progress(CleanupScanProgress {
                    scanned_entry_count: base_scanned.saturating_add(
                        latest.values().map(|value| value.scanned_entry_count).sum(),
                    ),
                    discovered_bytes: base_discovered
                        .saturating_add(latest.values().map(|value| value.discovered_bytes).sum()),
                    current_path: progress.current_path,
                    elapsed_ms: stats
                        .started
                        .elapsed()
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64,
                });
            }
            handles
                .into_iter()
                .map(|handle| {
                    handle.join().map_err(|_| {
                        CommandError::internal("A quick-scan worker stopped unexpectedly.")
                    })?
                })
                .collect()
        }) {
            Ok(parts) => parts,
            Err(error) => {
                let _ = remove_quick_part_indexes(index_path);
                return Err(error);
            }
        };
        for part in parts {
            if let Err(error) = merge_quick_scan_part(
                connection,
                scan_id,
                root_id,
                home,
                scan_root,
                definitions,
                &part,
                stats,
            ) {
                let _ = remove_quick_part_indexes(index_path);
                return Err(error);
            }
            remove_cleanup_index(&part.index_path)?;
        }
    }
    Ok(())
}

fn quick_scan_parallelism(scan_root: &Path) -> usize {
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| scan_root.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .filter(|disk| !disk.is_removable() && disk.kind() == DiskKind::SSD)
        .map_or(1, |_| 4)
}

fn quick_part_index_path(index_path: &Path, scan_id: &str, slot: usize) -> PathBuf {
    let safe_id = scan_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    index_path.with_file_name(format!(".cleanup-quick-{safe_id}-{slot}.sqlite"))
}

#[allow(clippy::too_many_arguments)]
fn merge_quick_scan_part(
    connection: &mut Connection,
    scan_id: &str,
    root_id: i64,
    home: &Path,
    scan_root: &Path,
    definitions: &[super::LocationDefinition],
    part: &QuickScanPart,
    stats: &mut IndexScanStats,
) -> Result<(), CommandError> {
    let source = open_index(&part.index_path)?;
    initialize_schema(&source)?;
    let source_root_id = root_node_id(&source, &part.scan.scan_id)?;
    let transaction = connection.transaction().map_err(index_error)?;
    let target_node_id = clone_external_node_subtree(
        &source,
        &transaction,
        &part.scan.scan_id,
        source_root_id,
        scan_id,
        Some(root_id),
    )?;
    let metadata = fs::symlink_metadata(&part.root_path).map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("A quick-scan location changed before it could be indexed: {error}"),
        )
    })?;
    let safety = matching_location_definition(definitions, &part.root_path)
        .map_or(CleanupSafety::Review, |(_, definition)| definition.safety);
    let protection_reason =
        cleanup_protection_for_scan_path(&part.root_path, home, scan_root, false);
    transaction
        .execute(
            "UPDATE nodes SET safety = ?2, deletion_protected = ?3,
               protection_reason = ?4, modified_at_ms = ?5,
               device_id = ?6, inode = ?7
             WHERE scan_id = ?1 AND id = ?8",
            params![
                scan_id,
                safety_text(safety),
                i64::from(protection_reason.is_some()),
                protection_reason.map(protection_reason_text),
                metadata
                    .modified()
                    .ok()
                    .and_then(system_time_millis)
                    .map(to_i64),
                metadata_device_id(&metadata),
                metadata_inode(&metadata),
                target_node_id,
            ],
        )
        .map_err(index_error)?;
    copy_seen_files(&source, &transaction, &part.scan.scan_id, scan_id)?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO scan_segments(
               scan_id, path, completed_at_ms, scanned_entry_count,
               discovered_bytes, unreadable_entry_count, unreadable_paths_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                scan_id,
                part.root_path.to_string_lossy().as_ref(),
                now_millis_i64(),
                to_i64(part.scan.scanned_entry_count as u64),
                to_i64(part.scan.root.allocated_size_bytes),
                to_i64(part.scan.unreadable_entry_count as u64),
                serde_json::to_string(&part.scan.unreadable_paths)
                    .unwrap_or_else(|_| "[]".to_owned()),
            ],
        )
        .map_err(index_error)?;
    transaction.commit().map_err(index_error)?;
    stats.scanned_entry_count = stats
        .scanned_entry_count
        .saturating_add(part.scan.scanned_entry_count);
    stats.discovered_bytes = stats
        .discovered_bytes
        .saturating_add(part.scan.root.allocated_size_bytes);
    stats.unreadable_entry_count = stats
        .unreadable_entry_count
        .saturating_add(part.scan.unreadable_entry_count);
    for path in &part.scan.unreadable_paths {
        if stats.unreadable_paths.len() >= MAX_UNREADABLE_PATHS {
            break;
        }
        if !stats.unreadable_paths.contains(path) {
            stats.unreadable_paths.push(path.clone());
        }
    }
    Ok(())
}

pub(crate) fn load_latest_indexed_scan(
    index_path: &Path,
) -> Result<Option<CleanupScan>, CommandError> {
    if !index_path.is_file() {
        return Ok(None);
    }
    let connection = open_index(index_path)?;
    initialize_schema(&connection)?;
    purge_expired_and_incomplete(&connection)?;
    let scan_id = connection
        .query_row(
            "SELECT id FROM scans WHERE state = 'completed'
             ORDER BY sampled_at_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(index_error)?;
    scan_id
        .map(|scan_id| load_scan(&connection, index_path, &scan_id))
        .transpose()
}

pub(crate) fn load_indexed_scan(
    index_path: &Path,
    scan_id: &str,
) -> Result<CleanupScan, CommandError> {
    let connection = open_index_read_only(index_path)?;
    load_scan(&connection, index_path, scan_id)
}

pub(crate) fn load_indexed_directory(
    index_path: &Path,
    scan_id: &str,
    directory_id: &str,
) -> Result<CleanupNode, CommandError> {
    let connection = open_index_read_only(index_path)?;
    let node_id = parse_index_node_id(scan_id, directory_id)?;
    ensure_directory_exists(&connection, scan_id, node_id)?;
    materialize_node(&connection, scan_id, node_id, 1)
}

pub(crate) fn load_indexed_children(
    index_path: &Path,
    scan_id: &str,
    directory_id: &str,
    cursor: usize,
    limit: usize,
) -> Result<CleanupIndexedChildrenPage, CommandError> {
    let connection = open_index_read_only(index_path)?;
    let node_id = parse_index_node_id(scan_id, directory_id)?;
    ensure_directory_exists(&connection, scan_id, node_id)?;
    let limit = limit.clamp(1, 100);
    let mut statement = connection
        .prepare(
            "SELECT id FROM nodes WHERE scan_id = ?1 AND parent_id = ?2
             ORDER BY allocated_size_bytes DESC, name ASC, id ASC LIMIT ?3 OFFSET ?4",
        )
        .map_err(index_error)?;
    let ids = statement
        .query_map(
            params![
                scan_id,
                node_id,
                i64::try_from(limit.saturating_add(1)).unwrap_or(101),
                i64::try_from(cursor).unwrap_or(i64::MAX),
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    let has_more = ids.len() > limit;
    let items = ids
        .into_iter()
        .take(limit)
        .map(|id| materialize_node(&connection, scan_id, id, 0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CleanupIndexedChildrenPage {
        next_cursor: has_more.then_some(cursor.saturating_add(items.len())),
        items,
    })
}

pub(crate) fn refresh_indexed_directory(
    index_path: &Path,
    scan_id: &str,
    directory_id: &str,
    refresh_id: &str,
    cancelled: &AtomicBool,
    excluded_paths: &[PathBuf],
    on_progress: &mut dyn FnMut(CleanupScanProgress),
) -> Result<CleanupScan, CommandError> {
    #[cfg(target_os = "macos")]
    let _activity = super::CleanupScanActivity::begin();
    ensure_private_index_parent(index_path)?;
    let mut connection = open_index(index_path)?;
    initialize_schema(&connection)?;
    let node_id = parse_index_node_id(scan_id, directory_id)?;
    let (absolute_path, parent_id, safety) = connection
        .query_row(
            "SELECT absolute_path, parent_id, safety
             FROM nodes
             WHERE scan_id = ?1 AND id = ?2 AND kind IN ('folder','restricted')",
            params![scan_id, node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(index_error)?
        .ok_or_else(|| {
            CommandError::new(
                "cleanup_index_node_missing",
                "The selected folder is not available in this scan index.",
            )
        })?;
    let target = PathBuf::from(&absolute_path);
    let target = target.canonicalize().map_err(|error| {
        CommandError::new(
            "cleanup_refresh_target_unavailable",
            format!("The selected folder is no longer available: {error}"),
        )
    })?;
    let metadata = fs::symlink_metadata(&target).map_err(|error| {
        CommandError::new(
            "cleanup_refresh_target_unavailable",
            format!("The selected folder is no longer available: {error}"),
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CommandError::new(
            "cleanup_refresh_target_invalid",
            "Only an existing folder can be refreshed.",
        ));
    }

    let (_profile, _target_kind, _scan_target_path, _original_root_id) = connection
        .query_row(
            "SELECT profile, target_kind, target_path, root_node_id
             FROM scans WHERE id = ?1 AND state = 'completed'",
            params![scan_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(index_error)?
        .ok_or_else(|| {
            CommandError::new(
                "cleanup_index_scan_missing",
                "The cleanup scan is no longer available.",
            )
        })?;
    let staging_scan_id = format!("refresh:{refresh_id}");
    delete_scan(&connection, &staging_scan_id)?;
    let home = home_directory().ok_or_else(|| {
        CommandError::internal("CoreRobin could not resolve the current user's home folder.")
    })?;
    prepare_scan(
        &connection,
        &staging_scan_id,
        CleanupScanProfile::Complete,
        CleanupScanTargetKind::Folder,
        &target.to_string_lossy(),
        &cleanup_node_name(&target),
        &display_path(&target, &home),
        &[],
    )?;
    let staging_root_id = root_node_id(&connection, &staging_scan_id)?;
    let boundary = ScanFilesystemBoundary::for_root(&target)?;
    let definitions = platform_paths(&home);
    let refresh_exclusions = cleanup_scan_exclusions(index_path, &target, excluded_paths);
    let mut seen_files = HashSet::new();
    let mut stats = IndexScanStats::new();
    let transaction = connection.transaction().map_err(index_error)?;
    let mut context = ScanContext {
        scan_id: &staging_scan_id,
        home: &home,
        scan_root: &target,
        protection_root: &target,
        selected_cleanup_root: true,
        boundary,
        definitions: &definitions,
        excluded_paths: &refresh_exclusions,
        cancelled,
        seen_files: &mut seen_files,
        shared_seen_files: None,
        stats: &mut stats,
        on_progress,
    };
    scan_directory_into_index(
        &transaction,
        staging_root_id,
        &target,
        parse_safety(&safety),
        &mut context,
    )?;
    transaction.commit().map_err(index_error)?;
    ensure_scan_active(cancelled)?;
    let staged_target_id = connection
        .query_row(
            "SELECT id FROM nodes WHERE scan_id = ?1 AND parent_id = ?2 LIMIT 1",
            params![staging_scan_id, staging_root_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(index_error)?;

    let replacement = connection.transaction().map_err(index_error)?;
    replace_node_subtree_preserving_root(
        &replacement,
        &staging_scan_id,
        staged_target_id,
        scan_id,
        node_id,
    )?;
    recompute_ancestor_totals(&replacement, scan_id, parent_id)?;
    replace_scan_locations_from_index(&replacement, scan_id, &definitions)?;
    replacement
        .execute(
            "UPDATE scans SET sampled_at_ms = ?2,
             duration_ms = duration_ms + ?3,
             scanned_entry_count = scanned_entry_count + ?4,
             unreadable_entry_count = unreadable_entry_count + ?5
             WHERE id = ?1",
            params![
                scan_id,
                now_millis_i64(),
                elapsed_millis(stats.started),
                to_i64(stats.scanned_entry_count as u64),
                to_i64(stats.unreadable_entry_count as u64),
            ],
        )
        .map_err(index_error)?;
    delete_scan(&replacement, &staging_scan_id)?;
    replacement.commit().map_err(index_error)?;
    rebuild_largest_files(&connection, scan_id)?;
    checkpoint_index(&connection)?;
    enforce_private_index_permissions(index_path)?;
    load_scan(&connection, index_path, scan_id)
}

pub(crate) fn cleanup_index_summary(
    index_path: &Path,
) -> Result<CleanupScanIndexSummary, CommandError> {
    if !index_path.is_file() {
        return Ok(CleanupScanIndexSummary {
            available: false,
            byte_size: 0,
            scan_count: 0,
            updated_at_ms: None,
        });
    }
    let connection = open_index(index_path)?;
    initialize_schema(&connection)?;
    let (scan_count, updated_at_ms) = connection
        .query_row(
            "SELECT COUNT(*), MAX(sampled_at_ms) FROM scans WHERE state = 'completed'",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map_err(index_error)?;
    Ok(CleanupScanIndexSummary {
        available: scan_count > 0,
        byte_size: index_file_size(index_path),
        scan_count: usize::try_from(scan_count).unwrap_or(0),
        updated_at_ms: updated_at_ms.and_then(|value| u64::try_from(value).ok()),
    })
}

pub(crate) fn remove_cleanup_index(index_path: &Path) -> Result<(), CommandError> {
    for path in [
        index_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", index_path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", index_path.to_string_lossy())),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "Could not remove the cleanup scan index {}: {error}",
                    path.display()
                )));
            }
        }
    }
    if index_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "cleanup-scan-index-v1.sqlite")
    {
        remove_quick_part_indexes(index_path)?;
    }
    Ok(())
}

fn cleanup_scan_exclusions(
    index_path: &Path,
    scan_root: &Path,
    excluded_paths: &[PathBuf],
) -> Vec<PathBuf> {
    let mut exclusions = excluded_paths.to_vec();
    if let Some(parent) = index_path.parent() {
        let parent = parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf());
        if parent.starts_with(scan_root) {
            exclusions.push(parent);
        } else {
            exclusions.extend([
                index_path.to_path_buf(),
                PathBuf::from(format!("{}-wal", index_path.to_string_lossy())),
                PathBuf::from(format!("{}-shm", index_path.to_string_lossy())),
            ]);
        }
    }
    exclusions.sort();
    exclusions.dedup();
    exclusions
}

fn path_is_excluded(path: &Path, excluded_paths: &[PathBuf]) -> bool {
    excluded_paths
        .iter()
        .any(|excluded| path == excluded || path.starts_with(excluded))
}

fn remove_quick_part_indexes(index_path: &Path) -> Result<(), CommandError> {
    let Some(parent) = index_path.parent() else {
        return Ok(());
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".cleanup-quick-")
            || !(name.ends_with(".sqlite")
                || name.ends_with(".sqlite-wal")
                || name.ends_with(".sqlite-shm"))
        {
            continue;
        }
        fs::remove_file(entry.path()).map_err(|error| {
            CommandError::internal(format!(
                "Could not remove a temporary cleanup index: {error}"
            ))
        })?;
    }
    Ok(())
}

fn scan_directory_into_index(
    transaction: &Transaction<'_>,
    parent_id: i64,
    directory: &Path,
    fallback_safety: CleanupSafety,
    context: &mut ScanContext<'_>,
) -> Result<DirectoryTotals, CommandError> {
    ensure_scan_active(context.cancelled)?;
    if path_is_excluded(directory, context.excluded_paths) {
        return Ok(DirectoryTotals::default());
    }
    context
        .stats
        .report(directory, context.home, context.on_progress, false);
    let directory_safety = matching_location_definition(context.definitions, directory)
        .map_or(fallback_safety, |(_, definition)| definition.safety);
    let protection_reason = cleanup_protection_for_scan_path(
        directory,
        context.home,
        context.protection_root,
        context.selected_cleanup_root,
    );
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => metadata,
        _ => {
            context.stats.record_unreadable(directory, context.home);
            return Ok(DirectoryTotals::default());
        }
    };
    if !context.boundary.allows_directory(&metadata)
        || is_excluded_scan_namespace(directory, context.scan_root)
        || is_cloud_backed_cleanup_root(directory, context.home)
    {
        return Ok(DirectoryTotals::default());
    }

    let node_id = insert_directory_placeholder(
        transaction,
        context.scan_id,
        parent_id,
        directory,
        context.home,
        directory_safety,
        protection_reason,
        &metadata,
    )?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => {
            context.stats.record_unreadable(directory, context.home);
            mark_restricted(transaction, node_id)?;
            return Ok(DirectoryTotals::default());
        }
    };
    let mut totals = DirectoryTotals::default();
    let mut visible_files = Vec::<IndexedFile>::with_capacity(VISIBLE_FILES_PER_DIRECTORY);
    let mut large_files = Vec::<IndexedFile>::new();

    for entry in entries {
        ensure_scan_active(context.cancelled)?;
        context.stats.scanned_entry_count = context.stats.scanned_entry_count.saturating_add(1);
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                context.stats.record_unreadable(directory, context.home);
                continue;
            }
        };
        let path = entry.path();
        if path_is_excluded(&path, context.excluded_paths) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                context.stats.record_unreadable(&path, context.home);
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    context.stats.record_unreadable(&path, context.home);
                    continue;
                }
            };
            if !context.boundary.allows_directory(&metadata)
                || is_excluded_scan_namespace(&path, context.scan_root)
            {
                continue;
            }
            let child =
                scan_directory_into_index(transaction, node_id, &path, directory_safety, context)?;
            totals.logical_size_bytes = totals
                .logical_size_bytes
                .saturating_add(child.logical_size_bytes);
            totals.allocated_size_bytes = totals
                .allocated_size_bytes
                .saturating_add(child.allocated_size_bytes);
            totals.item_count = totals.item_count.saturating_add(child.item_count);
            totals.direct_child_count = totals.direct_child_count.saturating_add(1);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                context.stats.record_unreadable(&path, context.home);
                continue;
            }
        };
        if !should_count_indexed_file(
            transaction,
            context.scan_id,
            &path,
            &metadata,
            context.seen_files,
            context.shared_seen_files,
        )? {
            continue;
        }
        let logical = metadata.len();
        let allocated = allocated_file_size(&path, &metadata);
        context
            .stats
            .record_file(&path, context.home, context.definitions, allocated);
        totals.logical_size_bytes = totals.logical_size_bytes.saturating_add(logical);
        totals.allocated_size_bytes = totals.allocated_size_bytes.saturating_add(allocated);
        totals.item_count = totals.item_count.saturating_add(1);
        totals.direct_child_count = totals.direct_child_count.saturating_add(1);
        let protection_reason = cleanup_protection_for_scan_path(
            &path,
            context.home,
            context.protection_root,
            context.selected_cleanup_root,
        );
        let candidate = IndexedFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            absolute_path: path.to_string_lossy().into_owned(),
            display_path: display_path(&path, context.home),
            logical_size_bytes: logical,
            allocated_size_bytes: allocated,
            modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
            safety: directory_safety,
            deletion_protected: protection_reason.is_some(),
            protection_reason,
            device_id: metadata_device_id(&metadata),
            inode: metadata_inode(&metadata),
        };
        if allocated >= LARGE_FILE_THRESHOLD_BYTES {
            large_files.push(candidate);
        } else if visible_files.len() < VISIBLE_FILES_PER_DIRECTORY {
            visible_files.push(candidate);
        } else if let Some((smallest_index, _)) = visible_files
            .iter()
            .enumerate()
            .min_by_key(|(_, file)| file.allocated_size_bytes)
            && allocated > visible_files[smallest_index].allocated_size_bytes
        {
            let omitted = std::mem::replace(&mut visible_files[smallest_index], candidate);
            totals.omitted_file_logical_bytes = totals
                .omitted_file_logical_bytes
                .saturating_add(omitted.logical_size_bytes);
            totals.omitted_file_allocated_bytes = totals
                .omitted_file_allocated_bytes
                .saturating_add(omitted.allocated_size_bytes);
            totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
        } else {
            totals.omitted_file_logical_bytes = totals
                .omitted_file_logical_bytes
                .saturating_add(candidate.logical_size_bytes);
            totals.omitted_file_allocated_bytes = totals
                .omitted_file_allocated_bytes
                .saturating_add(candidate.allocated_size_bytes);
            totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
        }
        context
            .stats
            .report(directory, context.home, context.on_progress, false);
    }

    for file in visible_files.iter().chain(large_files.iter()) {
        insert_file(transaction, context.scan_id, node_id, file)?;
    }
    update_directory(transaction, node_id, &totals)?;
    Ok(totals)
}

fn scan_direct_files_into_index(
    transaction: &Transaction<'_>,
    parent_id: i64,
    directory: &Path,
    safety: CleanupSafety,
    context: &mut ScanContext<'_>,
) -> Result<(), CommandError> {
    let entries = fs::read_dir(directory).map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not read the selected scan root: {error}"),
        )
    })?;
    let mut totals = DirectoryTotals::default();
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        ensure_scan_active(context.cancelled)?;
        let path = entry.path();
        if path_is_excluded(&path, context.excluded_paths) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        context.stats.scanned_entry_count = context.stats.scanned_entry_count.saturating_add(1);
        let Ok(metadata) = entry.metadata() else {
            context.stats.record_unreadable(&path, context.home);
            continue;
        };
        if !should_count_indexed_file(
            transaction,
            context.scan_id,
            &path,
            &metadata,
            context.seen_files,
            context.shared_seen_files,
        )? {
            continue;
        }
        let logical = metadata.len();
        let allocated = allocated_file_size(&path, &metadata);
        context
            .stats
            .record_file(&path, context.home, context.definitions, allocated);
        totals.logical_size_bytes = totals.logical_size_bytes.saturating_add(logical);
        totals.allocated_size_bytes = totals.allocated_size_bytes.saturating_add(allocated);
        totals.item_count = totals.item_count.saturating_add(1);
        let protection_reason = cleanup_protection_for_scan_path(
            &path,
            context.home,
            context.protection_root,
            context.selected_cleanup_root,
        );
        candidates.push(IndexedFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            absolute_path: path.to_string_lossy().into_owned(),
            display_path: display_path(&path, context.home),
            logical_size_bytes: logical,
            allocated_size_bytes: allocated,
            modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
            safety,
            deletion_protected: protection_reason.is_some(),
            protection_reason,
            device_id: metadata_device_id(&metadata),
            inode: metadata_inode(&metadata),
        });
    }
    candidates.sort_by_key(|file| Reverse(file.allocated_size_bytes));
    for file in candidates.iter().take(VISIBLE_FILES_PER_DIRECTORY) {
        insert_file(transaction, context.scan_id, parent_id, file)?;
    }
    if candidates.len() > VISIBLE_FILES_PER_DIRECTORY {
        for file in &candidates[VISIBLE_FILES_PER_DIRECTORY..] {
            totals.omitted_file_logical_bytes = totals
                .omitted_file_logical_bytes
                .saturating_add(file.logical_size_bytes);
            totals.omitted_file_allocated_bytes = totals
                .omitted_file_allocated_bytes
                .saturating_add(file.allocated_size_bytes);
            totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
        }
    }
    add_directory_totals(transaction, parent_id, &totals)
}

fn load_scan(
    connection: &Connection,
    index_path: &Path,
    scan_id: &str,
) -> Result<CleanupScan, CommandError> {
    let (
        sampled_at_ms,
        duration_ms,
        profile,
        target_kind,
        target_path,
        scope_paths_json,
        scanned_entry_count,
        unreadable_entry_count,
        unreadable_paths_json,
        root_node_id,
    ) = connection
        .query_row(
            "SELECT sampled_at_ms, duration_ms, profile, target_kind, target_path,
                    scope_paths_json, scanned_entry_count, unreadable_entry_count,
                    unreadable_paths_json, root_node_id
             FROM scans WHERE id = ?1 AND state = 'completed'",
            params![scan_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .map_err(index_error)?;
    let root = materialize_node(connection, scan_id, root_node_id, 1)?;
    let locations = load_locations(connection, scan_id)?;
    let largest_files = load_largest_files(connection, scan_id)?;
    Ok(CleanupScan {
        scan_id: scan_id.to_owned(),
        profile: parse_profile(&profile),
        scope_paths: serde_json::from_str(&scope_paths_json).unwrap_or_default(),
        indexed: true,
        index_byte_size: index_file_size(index_path),
        sampled_at_ms: u64::try_from(sampled_at_ms).unwrap_or(0),
        duration_ms: u64::try_from(duration_ms).unwrap_or(0),
        root,
        locations,
        largest_files,
        installed_applications: Vec::<CleanupApplication>::new(),
        application_inventory_available: false,
        scanned_entry_count: usize::try_from(scanned_entry_count).unwrap_or(0),
        unreadable_entry_count: usize::try_from(unreadable_entry_count).unwrap_or(0),
        unreadable_paths: serde_json::from_str(&unreadable_paths_json).unwrap_or_default(),
        deletion_available: true,
        target_kind: parse_target_kind(&target_kind),
        target_path,
    })
}

fn materialize_node(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
    remaining_depth: usize,
) -> Result<CleanupNode, CommandError> {
    let mut node = query_node(connection, scan_id, node_id)?;
    if remaining_depth == 0 || node.kind == CleanupNodeKind::Aggregate {
        return Ok(node);
    }
    let mut statement = connection
        .prepare(
            "SELECT id FROM nodes WHERE scan_id = ?1 AND parent_id = ?2
             ORDER BY allocated_size_bytes DESC, name ASC LIMIT ?3",
        )
        .map_err(index_error)?;
    let ids = statement
        .query_map(
            params![
                scan_id,
                node_id,
                i64::try_from(DIRECTORY_PAGE_SIZE).unwrap_or(24)
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    node.children = ids
        .into_iter()
        .map(|id| materialize_node(connection, scan_id, id, remaining_depth - 1))
        .collect::<Result<Vec<_>, _>>()?;
    let omitted = query_omitted_node(connection, scan_id, node_id)?;
    if let Some(omitted) = omitted {
        node.children.push(omitted);
    }
    Ok(node)
}

fn query_node(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<CleanupNode, CommandError> {
    connection
        .query_row(
            "SELECT name, display_path, logical_size_bytes, allocated_size_bytes,
                    item_count, safety, kind, deletion_protected, protection_reason,
                    has_children
             FROM nodes WHERE scan_id = ?1 AND id = ?2",
            params![scan_id, node_id],
            |row| {
                let display_path = row.get::<_, Option<String>>(1)?;
                let kind = parse_node_kind(&row.get::<_, String>(6)?);
                Ok(CleanupNode {
                    id: format!("index:{scan_id}:{node_id}"),
                    name: row.get(0)?,
                    path: display_path,
                    size_bytes: from_i64(row.get(3)?),
                    logical_size_bytes: from_i64(row.get(2)?),
                    allocated_size_bytes: from_i64(row.get(3)?),
                    item_count: usize::try_from(row.get::<_, i64>(4)?).unwrap_or(0),
                    safety: parse_safety(&row.get::<_, String>(5)?),
                    kind,
                    deletion_protected: row.get::<_, i64>(7)? != 0,
                    protection_reason: row
                        .get::<_, Option<String>>(8)?
                        .as_deref()
                        .and_then(parse_protection_reason),
                    has_children: row.get::<_, i64>(9)? != 0,
                    children: Vec::new(),
                })
            },
        )
        .map_err(index_error)
}

fn parse_index_node_id(scan_id: &str, directory_id: &str) -> Result<i64, CommandError> {
    let prefix = format!("index:{scan_id}:");
    directory_id
        .strip_prefix(&prefix)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            CommandError::new(
                "cleanup_index_node_invalid",
                "The selected folder does not belong to this scan.",
            )
        })
}

fn ensure_directory_exists(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<(), CommandError> {
    let available = connection
        .query_row(
            "SELECT COUNT(*) FROM nodes
             WHERE scan_id = ?1 AND id = ?2 AND kind IN ('folder','restricted')",
            params![scan_id, node_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(index_error)?
        > 0;
    if available {
        Ok(())
    } else {
        Err(CommandError::new(
            "cleanup_index_node_missing",
            "The selected folder is not available in this scan index.",
        ))
    }
}

fn query_omitted_node(
    connection: &Connection,
    scan_id: &str,
    parent_id: i64,
) -> Result<Option<CleanupNode>, CommandError> {
    let values = connection
        .query_row(
            "SELECT omitted_file_logical_bytes, omitted_file_allocated_bytes,
                    omitted_file_count, display_path, safety
             FROM nodes WHERE scan_id = ?1 AND id = ?2",
            params![scan_id, parent_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(index_error)?;
    let hidden_children = connection
        .query_row(
            "SELECT COALESCE(SUM(logical_size_bytes), 0),
                    COALESCE(SUM(allocated_size_bytes), 0),
                    COALESCE(SUM(item_count), 0),
                    COUNT(*)
             FROM (
               SELECT logical_size_bytes, allocated_size_bytes, item_count
               FROM nodes
               WHERE scan_id = ?1 AND parent_id = ?2
               ORDER BY allocated_size_bytes DESC, name ASC, id ASC
               LIMIT -1 OFFSET ?3
             )",
            params![
                scan_id,
                parent_id,
                i64::try_from(DIRECTORY_PAGE_SIZE).unwrap_or(24)
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .map_err(index_error)?;
    let logical = values.0.saturating_add(hidden_children.0);
    let allocated = values.1.saturating_add(hidden_children.1);
    let item_count = values.2.saturating_add(hidden_children.2);
    if item_count <= 0 {
        return Ok(None);
    }
    let id = format!(
        "{}#{}",
        values
            .3
            .unwrap_or_else(|| format!("index:{scan_id}:{parent_id}")),
        if hidden_children.3 > 0 {
            "other-items"
        } else {
            "other-files"
        }
    );
    Ok(Some(CleanupNode {
        id,
        name: "Other files".to_owned(),
        path: None,
        size_bytes: from_i64(allocated),
        logical_size_bytes: from_i64(logical),
        allocated_size_bytes: from_i64(allocated),
        item_count: usize::try_from(item_count).unwrap_or(0),
        safety: parse_safety(&values.4),
        kind: CleanupNodeKind::Aggregate,
        deletion_protected: true,
        protection_reason: Some(CleanupProtectionReason::Aggregate),
        has_children: false,
        children: Vec::new(),
    }))
}

fn initialize_schema(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS metadata(
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scans(
              id TEXT PRIMARY KEY,
              profile TEXT NOT NULL,
              target_kind TEXT NOT NULL,
              target_path TEXT NOT NULL,
              scope_paths_json TEXT NOT NULL,
              state TEXT NOT NULL,
              started_at_ms INTEGER NOT NULL,
              sampled_at_ms INTEGER NOT NULL DEFAULT 0,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              scanned_entry_count INTEGER NOT NULL DEFAULT 0,
              unreadable_entry_count INTEGER NOT NULL DEFAULT 0,
              unreadable_paths_json TEXT NOT NULL DEFAULT '[]',
              root_node_id INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS nodes(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              scan_id TEXT NOT NULL,
              parent_id INTEGER,
              name TEXT NOT NULL,
              absolute_path TEXT,
              display_path TEXT,
              logical_size_bytes INTEGER NOT NULL DEFAULT 0,
              allocated_size_bytes INTEGER NOT NULL DEFAULT 0,
              item_count INTEGER NOT NULL DEFAULT 0,
              safety TEXT NOT NULL,
              kind TEXT NOT NULL,
              deletion_protected INTEGER NOT NULL DEFAULT 0,
              protection_reason TEXT,
              has_children INTEGER NOT NULL DEFAULT 0,
              modified_at_ms INTEGER,
              device_id INTEGER,
              inode INTEGER,
              omitted_file_logical_bytes INTEGER NOT NULL DEFAULT 0,
              omitted_file_allocated_bytes INTEGER NOT NULL DEFAULT 0,
              omitted_file_count INTEGER NOT NULL DEFAULT 0,
              UNIQUE(scan_id, display_path)
            );
            CREATE INDEX IF NOT EXISTS nodes_by_parent
              ON nodes(scan_id, parent_id, allocated_size_bytes DESC, name);
            CREATE TABLE IF NOT EXISTS scan_segments(
              scan_id TEXT NOT NULL,
              path TEXT NOT NULL,
              completed_at_ms INTEGER NOT NULL,
              scanned_entry_count INTEGER NOT NULL DEFAULT 0,
              discovered_bytes INTEGER NOT NULL DEFAULT 0,
              unreadable_entry_count INTEGER NOT NULL DEFAULT 0,
              unreadable_paths_json TEXT NOT NULL DEFAULT '[]',
              PRIMARY KEY(scan_id, path)
            );
            CREATE TABLE IF NOT EXISTS scan_locations(
              scan_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              paths_json TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              item_count INTEGER NOT NULL,
              safety TEXT NOT NULL,
              available INTEGER NOT NULL,
              PRIMARY KEY(scan_id, kind)
            );
            CREATE TABLE IF NOT EXISTS largest_files(
              scan_id TEXT NOT NULL,
              path TEXT NOT NULL,
              name TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              modified_at_ms INTEGER,
              PRIMARY KEY(scan_id, path)
            );
            CREATE TABLE IF NOT EXISTS seen_files(
              scan_id TEXT NOT NULL,
              identity_a TEXT NOT NULL,
              identity_b TEXT NOT NULL,
              PRIMARY KEY(scan_id, identity_a, identity_b)
            );
            ",
        )
        .map_err(index_error)?;
    ensure_table_column(
        connection,
        "scan_segments",
        "scanned_entry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_table_column(
        connection,
        "scan_segments",
        "discovered_bytes",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_table_column(
        connection,
        "scan_segments",
        "unreadable_entry_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_table_column(
        connection,
        "scan_segments",
        "unreadable_paths_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    connection
        .execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(index_error)?;
    Ok(())
}

fn ensure_table_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), CommandError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(index_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    if columns.iter().any(|existing| existing == column) {
        return Ok(());
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))
        .map_err(index_error)
}

#[allow(clippy::too_many_arguments)]
fn prepare_scan(
    connection: &Connection,
    scan_id: &str,
    profile: CleanupScanProfile,
    target_kind: CleanupScanTargetKind,
    target_path: &str,
    root_name: &str,
    root_display_path: &str,
    scope_paths: &[PathBuf],
) -> Result<(), CommandError> {
    if connection
        .query_row(
            "SELECT COUNT(*) FROM scans WHERE id = ?1 AND state = 'running'",
            params![scan_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(index_error)?
        > 0
    {
        return Ok(());
    }
    connection
        .execute("DELETE FROM scans WHERE id = ?1", params![scan_id])
        .map_err(index_error)?;
    connection
        .execute("DELETE FROM nodes WHERE scan_id = ?1", params![scan_id])
        .map_err(index_error)?;
    let scope_paths_json = serde_json::to_string(
        &scope_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_owned());
    connection
        .execute(
            "INSERT INTO scans(
               id, profile, target_kind, target_path, scope_paths_json, state, started_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)",
            params![
                scan_id,
                profile_text(profile),
                target_kind_text(target_kind),
                target_path,
                scope_paths_json,
                now_millis_i64(),
            ],
        )
        .map_err(index_error)?;
    connection
        .execute(
            "INSERT INTO nodes(
               scan_id, parent_id, name, absolute_path, display_path, safety, kind,
               deletion_protected, protection_reason, has_children
             ) VALUES (?1, NULL, ?2, ?3, ?4, 'review', 'folder', 1, 'system_location', 1)",
            params![scan_id, root_name, target_path, root_display_path],
        )
        .map_err(index_error)?;
    let root_id = connection.last_insert_rowid();
    connection
        .execute(
            "UPDATE scans SET root_node_id = ?2 WHERE id = ?1",
            params![scan_id, root_id],
        )
        .map_err(index_error)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_directory_placeholder(
    transaction: &Transaction<'_>,
    scan_id: &str,
    parent_id: i64,
    path: &Path,
    home: &Path,
    safety: CleanupSafety,
    protection_reason: Option<CleanupProtectionReason>,
    metadata: &Metadata,
) -> Result<i64, CommandError> {
    #[cfg(unix)]
    let (device_id, inode) = (
        i64::try_from(std::os::unix::fs::MetadataExt::dev(metadata)).ok(),
        i64::try_from(std::os::unix::fs::MetadataExt::ino(metadata)).ok(),
    );
    #[cfg(not(unix))]
    let (device_id, inode) = (None::<i64>, None::<i64>);
    transaction
        .execute(
            "INSERT OR REPLACE INTO nodes(
               scan_id, parent_id, name, absolute_path, display_path, safety, kind,
               deletion_protected, protection_reason, has_children, modified_at_ms,
               device_id, inode
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'folder', ?7, ?8, 0, ?9, ?10, ?11)",
            params![
                scan_id,
                parent_id,
                cleanup_node_name(path),
                path.to_string_lossy().into_owned(),
                display_path(path, home),
                safety_text(safety),
                i64::from(protection_reason.is_some()),
                protection_reason.map(protection_reason_text),
                metadata
                    .modified()
                    .ok()
                    .and_then(system_time_millis)
                    .map(to_i64),
                device_id,
                inode,
            ],
        )
        .map_err(index_error)?;
    Ok(transaction.last_insert_rowid())
}

fn insert_file(
    transaction: &Transaction<'_>,
    scan_id: &str,
    parent_id: i64,
    file: &IndexedFile,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "INSERT OR REPLACE INTO nodes(
               scan_id, parent_id, name, absolute_path, display_path,
               logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
               deletion_protected, protection_reason, has_children, modified_at_ms,
               device_id, inode
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, 'file', ?9, ?10, 0, ?11, ?12, ?13)",
            params![
                scan_id,
                parent_id,
                file.name,
                file.absolute_path,
                file.display_path,
                to_i64(file.logical_size_bytes),
                to_i64(file.allocated_size_bytes),
                safety_text(file.safety),
                i64::from(file.deletion_protected),
                file.protection_reason.map(protection_reason_text),
                file.modified_at_ms.map(to_i64),
                file.device_id,
                file.inode,
            ],
        )
        .map_err(index_error)?;
    Ok(())
}

pub(crate) fn resolve_indexed_delete_request(
    index_path: &Path,
    mut request: CleanupDeleteLeaseRequest,
) -> Result<CleanupDeleteLeaseRequest, CommandError> {
    let scan_id = request.scan_id.as_deref().ok_or_else(|| {
        CommandError::new(
            "cleanup_index_selection_invalid",
            "The cleanup selection is missing its scan identity.",
        )
    })?;
    if request.directory_ids.is_empty() || request.directory_ids.len() > super::MAX_CLEANUP_TARGETS
    {
        return Err(CommandError::new(
            "cleanup_index_selection_invalid",
            "Choose one or more items from the current space scan.",
        ));
    }
    let connection = open_index(index_path)?;
    initialize_schema(&connection)?;
    let completed = connection
        .query_row(
            "SELECT COUNT(*) FROM scans WHERE id = ?1 AND state = 'completed'",
            params![scan_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(index_error)?
        > 0;
    if !completed {
        return Err(CommandError::new(
            "cleanup_index_scan_missing",
            "This space scan is no longer available. Run a new scan before cleaning.",
        ));
    }

    let mut paths = Vec::with_capacity(request.directory_ids.len());
    let mut evidence = Vec::with_capacity(request.directory_ids.len());
    let mut seen = HashSet::new();
    for opaque_id in &request.directory_ids {
        let node_id = parse_index_node_id(scan_id, opaque_id)?;
        if !seen.insert(node_id) {
            return Err(CommandError::new(
                "duplicate_cleanup_target",
                "The cleanup selection contains the same item more than once.",
            ));
        }
        let stored = connection
            .query_row(
                "SELECT absolute_path, display_path, logical_size_bytes,
                        allocated_size_bytes, item_count, kind, deletion_protected,
                        device_id, inode
                 FROM nodes WHERE scan_id = ?1 AND id = ?2",
                params![scan_id, node_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(index_error)?
            .ok_or_else(|| {
                CommandError::new(
                    "cleanup_index_node_missing",
                    "A selected item is no longer present in this scan.",
                )
            })?;
        if stored.5 == "aggregate" || stored.6 != 0 {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "This item is a protected or summarized scan result and cannot be deleted.",
            ));
        }
        let absolute_path = stored.0.ok_or_else(|| {
            CommandError::new(
                "cleanup_index_node_invalid",
                "The selected scan item has no filesystem path.",
            )
        })?;
        let metadata = fs::symlink_metadata(&absolute_path).map_err(|error| {
            CommandError::new(
                "cleanup_index_identity_changed",
                format!("The selected item changed after the scan: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink()
            || stored
                .7
                .is_some_and(|value| Some(value) != metadata_device_id(&metadata))
            || stored
                .8
                .is_some_and(|value| Some(value) != metadata_inode(&metadata))
        {
            return Err(CommandError::new(
                "cleanup_index_identity_changed",
                "The selected item no longer matches the file identity recorded by the scan.",
            ));
        }
        let display_path = stored.1.unwrap_or(absolute_path);
        paths.push(display_path.clone());
        evidence.push(CleanupDeleteTargetEvidence {
            path: display_path,
            logical_size_bytes: from_i64(stored.2),
            allocated_size_bytes: from_i64(stored.3),
            item_count: usize::try_from(stored.4).unwrap_or(0),
        });
    }
    request.paths = paths;
    request.expected_targets = evidence;
    Ok(request)
}

pub(crate) fn apply_indexed_deletions(
    index_path: &Path,
    scan_id: &str,
    opaque_node_ids: &[String],
) -> Result<CleanupScan, CommandError> {
    if opaque_node_ids.is_empty() {
        return load_indexed_scan(index_path, scan_id);
    }
    let mut connection = open_index(index_path)?;
    initialize_schema(&connection)?;
    let definitions = home_directory().map_or_else(Vec::new, |home| platform_paths(&home));
    let transaction = connection.transaction().map_err(index_error)?;
    let root_id = root_node_id(&transaction, scan_id)?;
    let mut affected_parents = HashSet::new();
    let mut seen = HashSet::new();
    for opaque_id in opaque_node_ids {
        let node_id = parse_index_node_id(scan_id, opaque_id)?;
        if node_id == root_id || !seen.insert(node_id) {
            continue;
        }
        let parent_id = transaction
            .query_row(
                "SELECT parent_id FROM nodes
                 WHERE scan_id = ?1 AND id = ?2 AND deletion_protected = 0
                   AND kind != 'aggregate'",
                params![scan_id, node_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(index_error)?
            .flatten();
        if let Some(parent_id) = parent_id {
            delete_node_subtree(&transaction, scan_id, node_id)?;
            affected_parents.insert(parent_id);
        }
    }
    for parent_id in affected_parents {
        recompute_ancestor_totals(&transaction, scan_id, Some(parent_id))?;
    }
    replace_scan_locations_from_index(&transaction, scan_id, &definitions)?;
    transaction
        .execute(
            "UPDATE scans SET sampled_at_ms = ?2 WHERE id = ?1 AND state = 'completed'",
            params![scan_id, now_millis_i64()],
        )
        .map_err(index_error)?;
    transaction.commit().map_err(index_error)?;
    rebuild_largest_files(&connection, scan_id)?;
    checkpoint_index(&connection)?;
    load_scan(&connection, index_path, scan_id)
}

fn update_directory(
    transaction: &Transaction<'_>,
    node_id: i64,
    totals: &DirectoryTotals,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "UPDATE nodes SET
               logical_size_bytes = ?2, allocated_size_bytes = ?3, item_count = ?4,
               has_children = ?5, omitted_file_logical_bytes = ?6,
               omitted_file_allocated_bytes = ?7, omitted_file_count = ?8
             WHERE id = ?1",
            params![
                node_id,
                to_i64(totals.logical_size_bytes),
                to_i64(totals.allocated_size_bytes),
                to_i64(totals.item_count as u64),
                i64::from(totals.direct_child_count > 0),
                to_i64(totals.omitted_file_logical_bytes),
                to_i64(totals.omitted_file_allocated_bytes),
                to_i64(totals.omitted_file_count as u64),
            ],
        )
        .map_err(index_error)?;
    Ok(())
}

fn add_directory_totals(
    transaction: &Transaction<'_>,
    node_id: i64,
    totals: &DirectoryTotals,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "UPDATE nodes SET
               logical_size_bytes = logical_size_bytes + ?2,
               allocated_size_bytes = allocated_size_bytes + ?3,
               item_count = item_count + ?4,
               omitted_file_logical_bytes = omitted_file_logical_bytes + ?5,
               omitted_file_allocated_bytes = omitted_file_allocated_bytes + ?6,
               omitted_file_count = omitted_file_count + ?7,
               has_children = 1
             WHERE id = ?1",
            params![
                node_id,
                to_i64(totals.logical_size_bytes),
                to_i64(totals.allocated_size_bytes),
                to_i64(totals.item_count as u64),
                to_i64(totals.omitted_file_logical_bytes),
                to_i64(totals.omitted_file_allocated_bytes),
                to_i64(totals.omitted_file_count as u64),
            ],
        )
        .map_err(index_error)?;
    Ok(())
}

fn mark_restricted(transaction: &Transaction<'_>, node_id: i64) -> Result<(), CommandError> {
    transaction
        .execute(
            "UPDATE nodes SET kind = 'restricted', deletion_protected = 1,
             protection_reason = 'restricted' WHERE id = ?1",
            params![node_id],
        )
        .map_err(index_error)?;
    Ok(())
}

fn delete_node_subtree(
    transaction: &Transaction<'_>,
    scan_id: &str,
    node_id: i64,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "WITH RECURSIVE subtree(id) AS (
               SELECT id FROM nodes WHERE scan_id = ?1 AND id = ?2
               UNION ALL
               SELECT nodes.id FROM nodes
               JOIN subtree ON nodes.parent_id = subtree.id
               WHERE nodes.scan_id = ?1
             )
             DELETE FROM nodes
             WHERE scan_id = ?1 AND id IN (SELECT id FROM subtree)",
            params![scan_id, node_id],
        )
        .map_err(index_error)?;
    Ok(())
}

fn replace_node_subtree_preserving_root(
    transaction: &Transaction<'_>,
    source_scan_id: &str,
    source_node_id: i64,
    target_scan_id: &str,
    target_node_id: i64,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "WITH RECURSIVE descendants(id) AS (
               SELECT id FROM nodes
               WHERE scan_id = ?1 AND parent_id = ?2
               UNION ALL
               SELECT nodes.id FROM nodes
               JOIN descendants ON nodes.parent_id = descendants.id
               WHERE nodes.scan_id = ?1
             )
             DELETE FROM nodes
             WHERE scan_id = ?1 AND id IN (SELECT id FROM descendants)",
            params![target_scan_id, target_node_id],
        )
        .map_err(index_error)?;
    let source = load_stored_node(transaction, source_scan_id, source_node_id)?;
    transaction
        .execute(
            "UPDATE nodes SET
               name = ?2, absolute_path = ?3, display_path = ?4,
               logical_size_bytes = ?5, allocated_size_bytes = ?6,
               item_count = ?7, safety = ?8, kind = ?9,
               deletion_protected = ?10, protection_reason = ?11,
               has_children = ?12, modified_at_ms = ?13, device_id = ?14,
               inode = ?15, omitted_file_logical_bytes = ?16,
               omitted_file_allocated_bytes = ?17, omitted_file_count = ?18
             WHERE scan_id = ?1 AND id = ?19",
            params![
                target_scan_id,
                source.name,
                source.absolute_path,
                source.display_path,
                source.logical_size_bytes,
                source.allocated_size_bytes,
                source.item_count,
                source.safety,
                source.kind,
                source.deletion_protected,
                source.protection_reason,
                source.has_children,
                source.modified_at_ms,
                source.device_id,
                source.inode,
                source.omitted_file_logical_bytes,
                source.omitted_file_allocated_bytes,
                source.omitted_file_count,
                target_node_id,
            ],
        )
        .map_err(index_error)?;
    let child_ids = child_node_ids(transaction, source_scan_id, source_node_id)?;
    for child_id in child_ids {
        clone_node_subtree(
            transaction,
            source_scan_id,
            child_id,
            target_scan_id,
            Some(target_node_id),
        )?;
    }
    Ok(())
}

#[derive(Debug)]
struct StoredNode {
    name: String,
    absolute_path: Option<String>,
    display_path: Option<String>,
    logical_size_bytes: i64,
    allocated_size_bytes: i64,
    item_count: i64,
    safety: String,
    kind: String,
    deletion_protected: i64,
    protection_reason: Option<String>,
    has_children: i64,
    modified_at_ms: Option<i64>,
    device_id: Option<i64>,
    inode: Option<i64>,
    omitted_file_logical_bytes: i64,
    omitted_file_allocated_bytes: i64,
    omitted_file_count: i64,
}

fn clone_node_subtree(
    transaction: &Transaction<'_>,
    source_scan_id: &str,
    source_node_id: i64,
    target_scan_id: &str,
    target_parent_id: Option<i64>,
) -> Result<i64, CommandError> {
    let stored = load_stored_node(transaction, source_scan_id, source_node_id)?;
    transaction
        .execute(
            "INSERT INTO nodes(
               scan_id, parent_id, name, absolute_path, display_path,
               logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
               deletion_protected, protection_reason, has_children, modified_at_ms,
               device_id, inode, omitted_file_logical_bytes,
               omitted_file_allocated_bytes, omitted_file_count
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18, ?19
             )",
            params![
                target_scan_id,
                target_parent_id,
                stored.name,
                stored.absolute_path,
                stored.display_path,
                stored.logical_size_bytes,
                stored.allocated_size_bytes,
                stored.item_count,
                stored.safety,
                stored.kind,
                stored.deletion_protected,
                stored.protection_reason,
                stored.has_children,
                stored.modified_at_ms,
                stored.device_id,
                stored.inode,
                stored.omitted_file_logical_bytes,
                stored.omitted_file_allocated_bytes,
                stored.omitted_file_count,
            ],
        )
        .map_err(index_error)?;
    let target_node_id = transaction.last_insert_rowid();
    let child_ids = child_node_ids(transaction, source_scan_id, source_node_id)?;
    for child_id in child_ids {
        clone_node_subtree(
            transaction,
            source_scan_id,
            child_id,
            target_scan_id,
            Some(target_node_id),
        )?;
    }
    Ok(target_node_id)
}

fn clone_external_node_subtree(
    source: &Connection,
    target: &Transaction<'_>,
    source_scan_id: &str,
    source_node_id: i64,
    target_scan_id: &str,
    target_parent_id: Option<i64>,
) -> Result<i64, CommandError> {
    let stored = load_stored_node(source, source_scan_id, source_node_id)?;
    target
        .execute(
            "INSERT INTO nodes(
               scan_id, parent_id, name, absolute_path, display_path,
               logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
               deletion_protected, protection_reason, has_children, modified_at_ms,
               device_id, inode, omitted_file_logical_bytes,
               omitted_file_allocated_bytes, omitted_file_count
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18, ?19
             )",
            params![
                target_scan_id,
                target_parent_id,
                stored.name,
                stored.absolute_path,
                stored.display_path,
                stored.logical_size_bytes,
                stored.allocated_size_bytes,
                stored.item_count,
                stored.safety,
                stored.kind,
                stored.deletion_protected,
                stored.protection_reason,
                stored.has_children,
                stored.modified_at_ms,
                stored.device_id,
                stored.inode,
                stored.omitted_file_logical_bytes,
                stored.omitted_file_allocated_bytes,
                stored.omitted_file_count,
            ],
        )
        .map_err(index_error)?;
    let target_node_id = target.last_insert_rowid();
    for child_id in child_node_ids(source, source_scan_id, source_node_id)? {
        clone_external_node_subtree(
            source,
            target,
            source_scan_id,
            child_id,
            target_scan_id,
            Some(target_node_id),
        )?;
    }
    Ok(target_node_id)
}

fn copy_seen_files(
    source: &Connection,
    target: &Transaction<'_>,
    source_scan_id: &str,
    target_scan_id: &str,
) -> Result<(), CommandError> {
    let mut statement = source
        .prepare("SELECT identity_a, identity_b FROM seen_files WHERE scan_id = ?1")
        .map_err(index_error)?;
    let identities = statement
        .query_map(params![source_scan_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    for (identity_a, identity_b) in identities {
        target
            .execute(
                "INSERT OR IGNORE INTO seen_files(scan_id, identity_a, identity_b)
                 VALUES (?1, ?2, ?3)",
                params![target_scan_id, identity_a, identity_b],
            )
            .map_err(index_error)?;
    }
    Ok(())
}

fn load_stored_node(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<StoredNode, CommandError> {
    connection
        .query_row(
            "SELECT name, absolute_path, display_path, logical_size_bytes,
                    allocated_size_bytes, item_count, safety, kind,
                    deletion_protected, protection_reason, has_children,
                    modified_at_ms, device_id, inode,
                    omitted_file_logical_bytes, omitted_file_allocated_bytes,
                    omitted_file_count
             FROM nodes WHERE scan_id = ?1 AND id = ?2",
            params![scan_id, node_id],
            |row| {
                Ok(StoredNode {
                    name: row.get(0)?,
                    absolute_path: row.get(1)?,
                    display_path: row.get(2)?,
                    logical_size_bytes: row.get(3)?,
                    allocated_size_bytes: row.get(4)?,
                    item_count: row.get(5)?,
                    safety: row.get(6)?,
                    kind: row.get(7)?,
                    deletion_protected: row.get(8)?,
                    protection_reason: row.get(9)?,
                    has_children: row.get(10)?,
                    modified_at_ms: row.get(11)?,
                    device_id: row.get(12)?,
                    inode: row.get(13)?,
                    omitted_file_logical_bytes: row.get(14)?,
                    omitted_file_allocated_bytes: row.get(15)?,
                    omitted_file_count: row.get(16)?,
                })
            },
        )
        .map_err(index_error)
}

fn child_node_ids(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<Vec<i64>, CommandError> {
    let mut statement = connection
        .prepare("SELECT id FROM nodes WHERE scan_id = ?1 AND parent_id = ?2 ORDER BY id")
        .map_err(index_error)?;
    statement
        .query_map(params![scan_id, node_id], |row| row.get::<_, i64>(0))
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)
}

fn recompute_ancestor_totals(
    transaction: &Transaction<'_>,
    scan_id: &str,
    mut node_id: Option<i64>,
) -> Result<(), CommandError> {
    while let Some(current_id) = node_id {
        let (
            logical,
            allocated,
            item_count,
            child_count,
            omitted_logical,
            omitted_allocated,
            omitted_count,
            parent_id,
        ) = transaction
            .query_row(
                "SELECT
                   COALESCE((SELECT SUM(logical_size_bytes) FROM nodes
                             WHERE scan_id = ?1 AND parent_id = ?2), 0),
                   COALESCE((SELECT SUM(allocated_size_bytes) FROM nodes
                             WHERE scan_id = ?1 AND parent_id = ?2), 0),
                   COALESCE((SELECT SUM(item_count) FROM nodes
                             WHERE scan_id = ?1 AND parent_id = ?2), 0),
                   (SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND parent_id = ?2),
                   omitted_file_logical_bytes,
                   omitted_file_allocated_bytes,
                   omitted_file_count,
                   parent_id
                 FROM nodes WHERE scan_id = ?1 AND id = ?2",
                params![scan_id, current_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                },
            )
            .map_err(index_error)?;
        transaction
            .execute(
                "UPDATE nodes SET logical_size_bytes = ?2,
                 allocated_size_bytes = ?3, item_count = ?4, has_children = ?5
                 WHERE scan_id = ?1 AND id = ?6",
                params![
                    scan_id,
                    logical.saturating_add(omitted_logical),
                    allocated.saturating_add(omitted_allocated),
                    item_count.saturating_add(omitted_count),
                    i64::from(child_count > 0 || omitted_count > 0),
                    current_id
                ],
            )
            .map_err(index_error)?;
        node_id = parent_id;
    }
    Ok(())
}

fn replace_scan_locations_from_index(
    connection: &Connection,
    scan_id: &str,
    definitions: &[super::LocationDefinition],
) -> Result<(), CommandError> {
    connection
        .execute(
            "DELETE FROM scan_locations WHERE scan_id = ?1",
            params![scan_id],
        )
        .map_err(index_error)?;
    for definition in definitions {
        let mut size = 0_i64;
        let mut count = 0_i64;
        for path in &definition.paths {
            let totals = connection
                .query_row(
                    "SELECT allocated_size_bytes, item_count
                     FROM nodes WHERE scan_id = ?1 AND absolute_path = ?2
                     ORDER BY id LIMIT 1",
                    params![scan_id, path.to_string_lossy().as_ref()],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(index_error)?;
            if let Some((path_size, path_count)) = totals {
                size = size.saturating_add(path_size);
                count = count.saturating_add(path_count);
            }
        }
        connection
            .execute(
                "INSERT INTO scan_locations(
                   scan_id, kind, paths_json, size_bytes, item_count, safety, available
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    scan_id,
                    location_kind_text(definition.kind),
                    serde_json::to_string(
                        &definition
                            .paths
                            .iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                    )
                    .unwrap_or_else(|_| "[]".to_owned()),
                    size,
                    count,
                    safety_text(definition.safety),
                    i64::from(definition.paths.iter().any(|path| path.is_dir())),
                ],
            )
            .map_err(index_error)?;
    }
    Ok(())
}

fn rebuild_largest_files(connection: &Connection, scan_id: &str) -> Result<(), CommandError> {
    connection
        .execute(
            "DELETE FROM largest_files WHERE scan_id = ?1",
            params![scan_id],
        )
        .map_err(index_error)?;
    connection
        .execute(
            "INSERT INTO largest_files(scan_id, path, name, size_bytes, modified_at_ms)
             SELECT scan_id, absolute_path, name, allocated_size_bytes, modified_at_ms
             FROM nodes
             WHERE scan_id = ?1 AND kind = 'file'
               AND allocated_size_bytes >= ?2 AND absolute_path IS NOT NULL
             ORDER BY allocated_size_bytes DESC LIMIT ?3",
            params![
                scan_id,
                to_i64(LARGE_FILE_THRESHOLD_BYTES),
                i64::try_from(MAX_LARGE_FILES).unwrap_or(12)
            ],
        )
        .map_err(index_error)?;
    Ok(())
}

fn update_root_totals(
    connection: &Connection,
    scan_id: &str,
    root_id: i64,
) -> Result<(), CommandError> {
    let (
        logical,
        allocated,
        item_count,
        child_count,
        omitted_logical,
        omitted_allocated,
        omitted_count,
    ) = connection
        .query_row(
            "SELECT
               COALESCE((SELECT SUM(logical_size_bytes) FROM nodes
                         WHERE scan_id = ?1 AND parent_id = ?2), 0),
               COALESCE((SELECT SUM(allocated_size_bytes) FROM nodes
                         WHERE scan_id = ?1 AND parent_id = ?2), 0),
               COALESCE((SELECT SUM(item_count) FROM nodes
                         WHERE scan_id = ?1 AND parent_id = ?2), 0),
               (SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND parent_id = ?2),
               omitted_file_logical_bytes,
               omitted_file_allocated_bytes,
               omitted_file_count
             FROM nodes WHERE scan_id = ?1 AND id = ?2",
            params![scan_id, root_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .map_err(index_error)?;
    connection
        .execute(
            "UPDATE nodes SET logical_size_bytes = ?2, allocated_size_bytes = ?3,
             item_count = ?4, has_children = ?5 WHERE id = ?1",
            params![
                root_id,
                logical.saturating_add(omitted_logical),
                allocated.saturating_add(omitted_allocated),
                item_count.saturating_add(omitted_count),
                i64::from(child_count > 0 || omitted_count > 0)
            ],
        )
        .map_err(index_error)?;
    Ok(())
}

fn load_locations(
    connection: &Connection,
    scan_id: &str,
) -> Result<Vec<CleanupLocation>, CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT kind, paths_json, size_bytes, item_count, safety, available
             FROM scan_locations WHERE scan_id = ?1",
        )
        .map_err(index_error)?;
    let rows = statement
        .query_map(params![scan_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    drop(statement);
    rows.into_iter()
        .map(|row| {
            let paths: Vec<String> = serde_json::from_str(&row.1).unwrap_or_default();
            let mut nodes = Vec::new();
            for path in &paths {
                let node_id = connection
                    .query_row(
                        "SELECT id FROM nodes
                         WHERE scan_id = ?1 AND absolute_path = ?2
                         ORDER BY id LIMIT 1",
                        params![scan_id, path],
                        |node_row| node_row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(index_error)?;
                if let Some(node_id) = node_id {
                    nodes.push(materialize_node(connection, scan_id, node_id, 1)?);
                }
            }
            Ok(CleanupLocation {
                kind: parse_location_kind(&row.0),
                paths,
                size_bytes: from_i64(row.2),
                item_count: usize::try_from(row.3).unwrap_or(0),
                safety: parse_safety(&row.4),
                available: row.5 != 0,
                nodes,
            })
        })
        .collect()
}

fn load_largest_files(
    connection: &Connection,
    scan_id: &str,
) -> Result<Vec<CleanupFile>, CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT name, path, size_bytes, modified_at_ms FROM largest_files
             WHERE scan_id = ?1 ORDER BY size_bytes DESC LIMIT ?2",
        )
        .map_err(index_error)?;
    statement
        .query_map(params![scan_id, MAX_LARGE_FILES as i64], |row| {
            Ok(CleanupFile {
                name: row.get(0)?,
                path: row.get(1)?,
                size_bytes: from_i64(row.get(2)?),
                modified_at_ms: row
                    .get::<_, Option<i64>>(3)?
                    .and_then(|value| u64::try_from(value).ok()),
            })
        })
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)
}

fn common_location_roots(home: &Path, scan_root: &Path) -> Result<Vec<PathBuf>, CommandError> {
    let boundary = ScanFilesystemBoundary::for_root(scan_root)?;
    let mut candidates = vec![
        home.join("Downloads"),
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Movies"),
        home.join("Music"),
        home.join("Pictures"),
    ];
    for definition in platform_paths(home) {
        candidates.extend(definition.paths);
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        home.join("Library/Application Support"),
        home.join("Library/Containers"),
        home.join("Library/Group Containers"),
        PathBuf::from("/Library/Caches"),
        PathBuf::from("/private/var/folders"),
        PathBuf::from("/private/tmp"),
    ]);
    #[cfg(target_os = "linux")]
    candidates.extend([home.join(".local/share"), PathBuf::from("/tmp")]);
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Temp"));
    }

    let mut roots = candidates
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || !boundary.allows_directory(&metadata)
            {
                return None;
            }
            path.canonicalize().ok()
        })
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    let mut deduplicated = Vec::<PathBuf>::new();
    for root in roots {
        if deduplicated.iter().any(|parent| root.starts_with(parent)) {
            continue;
        }
        deduplicated.retain(|child| !child.starts_with(&root));
        deduplicated.push(root);
    }
    deduplicated.sort();
    Ok(deduplicated)
}

fn scan_root_children(
    scan_root: &Path,
    boundary: ScanFilesystemBoundary,
    cancelled: &AtomicBool,
) -> Result<Vec<PathBuf>, CommandError> {
    let entries = fs::read_dir(scan_root).map_err(|error| {
        CommandError::new(
            "cleanup_scan_root_unavailable",
            format!("CoreRobin could not read the selected scan root: {error}"),
        )
    })?;
    let mut paths = Vec::new();
    for entry in entries {
        ensure_scan_active(cancelled)?;
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if is_excluded_scan_namespace(&path, scan_root) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if boundary.allows_directory(&metadata) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

#[cfg(unix)]
fn load_seen_files(
    connection: &Connection,
    scan_id: &str,
) -> Result<HashSet<super::FileIdentity>, CommandError> {
    let mut statement = connection
        .prepare("SELECT identity_a, identity_b FROM seen_files WHERE scan_id = ?1")
        .map_err(index_error)?;
    statement
        .query_map(params![scan_id], |row| {
            let device = row.get::<_, String>(0)?.parse::<u64>().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let inode = row.get::<_, String>(1)?.parse::<u64>().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok((device, inode))
        })
        .map_err(index_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(index_error)
}

#[cfg(windows)]
fn load_seen_files(
    connection: &Connection,
    scan_id: &str,
) -> Result<HashSet<super::FileIdentity>, CommandError> {
    let mut statement = connection
        .prepare("SELECT identity_a, identity_b FROM seen_files WHERE scan_id = ?1")
        .map_err(index_error)?;
    statement
        .query_map(params![scan_id], |row| {
            let volume = row.get::<_, String>(0)?.parse::<u32>().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let index = row.get::<_, String>(1)?.parse::<u64>().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok((volume, index))
        })
        .map_err(index_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(index_error)
}

#[cfg(not(any(unix, windows)))]
fn load_seen_files(
    connection: &Connection,
    scan_id: &str,
) -> Result<HashSet<super::FileIdentity>, CommandError> {
    let mut statement = connection
        .prepare("SELECT identity_a FROM seen_files WHERE scan_id = ?1")
        .map_err(index_error)?;
    statement
        .query_map(params![scan_id], |row| {
            row.get::<_, String>(0).map(PathBuf::from)
        })
        .map_err(index_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(index_error)
}

fn should_count_indexed_file(
    transaction: &Transaction<'_>,
    scan_id: &str,
    path: &Path,
    metadata: &Metadata,
    seen_files: &mut HashSet<super::FileIdentity>,
    shared_seen_files: Option<&Arc<Mutex<HashSet<super::FileIdentity>>>>,
) -> Result<bool, CommandError> {
    let Some(identity) = super::file_identity(path, metadata) else {
        return Ok(true);
    };
    let inserted = if let Some(shared_seen_files) = shared_seen_files {
        shared_seen_files
            .lock()
            .map_err(|_| CommandError::internal("The cleanup identity index became unavailable."))?
            .insert(clone_file_identity(&identity))
    } else {
        seen_files.insert(clone_file_identity(&identity))
    };
    if inserted {
        if shared_seen_files.is_some() {
            seen_files.insert(clone_file_identity(&identity));
        }
        let (identity_a, identity_b) = encode_file_identity(&identity);
        transaction
            .execute(
                "INSERT OR IGNORE INTO seen_files(scan_id, identity_a, identity_b)
                 VALUES (?1, ?2, ?3)",
                params![scan_id, identity_a, identity_b],
            )
            .map_err(index_error)?;
    }
    Ok(inserted)
}

#[cfg(any(unix, windows))]
fn clone_file_identity(identity: &super::FileIdentity) -> super::FileIdentity {
    *identity
}

#[cfg(not(any(unix, windows)))]
fn clone_file_identity(identity: &super::FileIdentity) -> super::FileIdentity {
    identity.clone()
}

#[cfg(unix)]
fn encode_file_identity(identity: &super::FileIdentity) -> (String, String) {
    (identity.0.to_string(), identity.1.to_string())
}

#[cfg(windows)]
fn encode_file_identity(identity: &super::FileIdentity) -> (String, String) {
    (identity.0.to_string(), identity.1.to_string())
}

#[cfg(not(any(unix, windows)))]
fn encode_file_identity(identity: &super::FileIdentity) -> (String, String) {
    (identity.to_string_lossy().into_owned(), String::new())
}

fn root_node_id(connection: &Connection, scan_id: &str) -> Result<i64, CommandError> {
    connection
        .query_row(
            "SELECT root_node_id FROM scans WHERE id = ?1",
            params![scan_id],
            |row| row.get(0),
        )
        .map_err(index_error)
}

fn completed_segment(
    connection: &Connection,
    scan_id: &str,
    path: &str,
) -> Result<bool, CommandError> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM scan_segments WHERE scan_id = ?1 AND path = ?2",
            params![scan_id, path],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .map_err(index_error)
}

fn restore_completed_segment_stats(
    connection: &Connection,
    scan_id: &str,
    stats: &mut IndexScanStats,
) -> Result<(), CommandError> {
    let (scanned, discovered, unreadable) = connection
        .query_row(
            "SELECT COALESCE(SUM(scanned_entry_count), 0),
                    COALESCE(SUM(discovered_bytes), 0),
                    COALESCE(SUM(unreadable_entry_count), 0)
             FROM scan_segments WHERE scan_id = ?1",
            params![scan_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(index_error)?;
    stats.scanned_entry_count = usize::try_from(scanned).unwrap_or(usize::MAX);
    stats.last_reported_entry_count = stats.scanned_entry_count;
    stats.discovered_bytes = from_i64(discovered);
    stats.unreadable_entry_count = usize::try_from(unreadable).unwrap_or(usize::MAX);
    let mut statement = connection
        .prepare(
            "SELECT unreadable_paths_json FROM scan_segments
             WHERE scan_id = ?1 ORDER BY completed_at_ms",
        )
        .map_err(index_error)?;
    let rows = statement
        .query_map(params![scan_id], |row| row.get::<_, String>(0))
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    stats.unreadable_paths = rows
        .into_iter()
        .flat_map(|json| serde_json::from_str::<Vec<String>>(&json).unwrap_or_default())
        .take(MAX_UNREADABLE_PATHS)
        .collect();
    Ok(())
}

fn retire_previous_detailed_scans(
    connection: &Connection,
    current_scan_id: &str,
    target_kind: CleanupScanTargetKind,
    target_path: &str,
) -> Result<(), CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT id FROM scans
             WHERE id != ?1 AND state = 'completed'
               AND target_kind = ?2 AND target_path = ?3",
        )
        .map_err(index_error)?;
    let previous = statement
        .query_map(
            params![current_scan_id, target_kind_text(target_kind), target_path],
            |row| row.get::<_, String>(0),
        )
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    drop(statement);
    for scan_id in previous {
        delete_scan(connection, &scan_id)?;
    }
    Ok(())
}

fn purge_expired_and_incomplete(connection: &Connection) -> Result<(), CommandError> {
    let cutoff = now_millis_i64()
        .saturating_sub(i64::try_from(DETAIL_RETENTION.as_millis()).unwrap_or(i64::MAX));
    let mut statement = connection
        .prepare(
            "SELECT id FROM scans
             WHERE (state != 'completed' AND started_at_ms < ?1)
                OR (state = 'completed' AND sampled_at_ms < ?1)",
        )
        .map_err(index_error)?;
    let ids = statement
        .query_map(params![cutoff], |row| row.get::<_, String>(0))
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    drop(statement);
    for id in ids {
        delete_scan(connection, &id)?;
    }
    Ok(())
}

fn delete_scan(connection: &Connection, scan_id: &str) -> Result<(), CommandError> {
    for table in [
        "nodes",
        "scan_segments",
        "scan_locations",
        "largest_files",
        "seen_files",
    ] {
        connection
            .execute(
                &format!("DELETE FROM {table} WHERE scan_id = ?1"),
                params![scan_id],
            )
            .map_err(index_error)?;
    }
    connection
        .execute("DELETE FROM scans WHERE id = ?1", params![scan_id])
        .map_err(index_error)?;
    Ok(())
}

fn open_index(path: &Path) -> Result<Connection, CommandError> {
    let connection = Connection::open(path).map_err(index_error)?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(index_error)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(index_error)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(index_error)?;
    Ok(connection)
}

fn open_index_read_only(path: &Path) -> Result<Connection, CommandError> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(index_error)?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(index_error)?;
    Ok(connection)
}

fn checkpoint_index(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(index_error)
}

fn ensure_private_index_parent(path: &Path) -> Result<(), CommandError> {
    let parent = path.parent().ok_or_else(|| {
        CommandError::internal("The cleanup scan index path has no parent directory.")
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        CommandError::internal(format!(
            "Could not create the cleanup scan index directory: {error}"
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|error| {
            CommandError::internal(format!(
                "Could not protect the cleanup scan index directory: {error}"
            ))
        })?;
    }
    Ok(())
}

fn enforce_private_index_permissions(_path: &Path) -> Result<(), CommandError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            CommandError::internal(format!("Could not protect the cleanup scan index: {error}"))
        })?;
    }
    Ok(())
}

fn index_file_size(path: &Path) -> u64 {
    [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", path.to_string_lossy())),
    ]
    .iter()
    .filter_map(|path| fs::metadata(path).ok())
    .map(|metadata| metadata.len())
    .sum()
}

fn index_error(error: rusqlite::Error) -> CommandError {
    CommandError::internal(format!("Cleanup scan index operation failed: {error}"))
}

fn elapsed_millis(started: Instant) -> i64 {
    i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

fn now_millis_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_i64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(unix)]
fn metadata_device_id(metadata: &Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    i64::try_from(metadata.dev()).ok()
}

#[cfg(not(unix))]
fn metadata_device_id(_metadata: &Metadata) -> Option<i64> {
    None
}

#[cfg(unix)]
fn metadata_inode(metadata: &Metadata) -> Option<i64> {
    use std::os::unix::fs::MetadataExt;
    i64::try_from(metadata.ino()).ok()
}

#[cfg(not(unix))]
fn metadata_inode(_metadata: &Metadata) -> Option<i64> {
    None
}

fn profile_text(value: CleanupScanProfile) -> &'static str {
    match value {
        CleanupScanProfile::CommonLocations => "common_locations",
        CleanupScanProfile::Complete => "complete",
    }
}

fn parse_profile(value: &str) -> CleanupScanProfile {
    match value {
        "common_locations" => CleanupScanProfile::CommonLocations,
        _ => CleanupScanProfile::Complete,
    }
}

fn target_kind_text(value: CleanupScanTargetKind) -> &'static str {
    match value {
        CleanupScanTargetKind::SystemDisk => "system_disk",
        CleanupScanTargetKind::Volume => "volume",
        CleanupScanTargetKind::Folder => "folder",
    }
}

fn parse_target_kind(value: &str) -> CleanupScanTargetKind {
    match value {
        "volume" => CleanupScanTargetKind::Volume,
        "folder" => CleanupScanTargetKind::Folder,
        _ => CleanupScanTargetKind::SystemDisk,
    }
}

fn safety_text(value: CleanupSafety) -> &'static str {
    match value {
        CleanupSafety::Reclaimable => "reclaimable",
        CleanupSafety::Review => "review",
    }
}

fn parse_safety(value: &str) -> CleanupSafety {
    match value {
        "reclaimable" => CleanupSafety::Reclaimable,
        _ => CleanupSafety::Review,
    }
}

fn protection_reason_text(value: CleanupProtectionReason) -> &'static str {
    match value {
        CleanupProtectionReason::SystemLocation => "system_location",
        CleanupProtectionReason::HomeRoot => "home_root",
        CleanupProtectionReason::TrashRoot => "trash_root",
        CleanupProtectionReason::SensitiveUserData => "sensitive_user_data",
        CleanupProtectionReason::Aggregate => "aggregate",
        CleanupProtectionReason::Restricted => "restricted",
    }
}

fn parse_protection_reason(value: &str) -> Option<CleanupProtectionReason> {
    match value {
        "system_location" => Some(CleanupProtectionReason::SystemLocation),
        "home_root" => Some(CleanupProtectionReason::HomeRoot),
        "trash_root" => Some(CleanupProtectionReason::TrashRoot),
        "sensitive_user_data" => Some(CleanupProtectionReason::SensitiveUserData),
        "aggregate" => Some(CleanupProtectionReason::Aggregate),
        "restricted" => Some(CleanupProtectionReason::Restricted),
        _ => None,
    }
}

fn parse_node_kind(value: &str) -> CleanupNodeKind {
    match value {
        "file" => CleanupNodeKind::File,
        "aggregate" => CleanupNodeKind::Aggregate,
        "restricted" => CleanupNodeKind::Restricted,
        _ => CleanupNodeKind::Folder,
    }
}

fn location_kind_text(value: CleanupLocationKind) -> &'static str {
    match value {
        CleanupLocationKind::Downloads => "downloads",
        CleanupLocationKind::Trash => "trash",
        CleanupLocationKind::AppCache => "app_cache",
        CleanupLocationKind::DeveloperCache => "developer_cache",
        CleanupLocationKind::HiddenData => "hidden_data",
    }
}

fn parse_location_kind(value: &str) -> CleanupLocationKind {
    match value {
        "trash" => CleanupLocationKind::Trash,
        "app_cache" => CleanupLocationKind::AppCache,
        "developer_cache" => CleanupLocationKind::DeveloperCache,
        "hidden_data" => CleanupLocationKind::HiddenData,
        _ => CleanupLocationKind::Downloads,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn scan_folder(path: &Path, index_path: &Path, scan_id: &str) -> CleanupScan {
        build_indexed_scan(
            CleanupScanRequest {
                profile: CleanupScanProfile::Complete,
                target_kind: CleanupScanTargetKind::Folder,
                target_path: Some(path.to_string_lossy().into_owned()),
            },
            scan_id,
            index_path,
            &AtomicBool::new(false),
            &[],
            &mut |_| {},
        )
        .unwrap()
    }

    #[test]
    fn quick_roots_are_existing_and_non_overlapping() {
        let root = tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(home.join("Downloads")).unwrap();
        fs::create_dir_all(home.join(".cache/nested")).unwrap();
        let roots = common_location_roots(&home, root.path()).unwrap();
        assert!(!roots.is_empty());
        for (index, root) in roots.iter().enumerate() {
            assert!(
                roots
                    .iter()
                    .enumerate()
                    .all(|(other_index, other)| index == other_index || !root.starts_with(other))
            );
        }
    }

    #[test]
    fn quick_roots_are_scanned_in_parallel_parts_and_merged_into_one_index() {
        let fixture = tempdir().unwrap();
        let home = fixture.path().join("home");
        let first = home.join("Downloads");
        let second = home.join("Library/Caches");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("download.bin"), vec![1_u8; 1_024]).unwrap();
        fs::write(second.join("cache.bin"), vec![2_u8; 2_048]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup-scan-index-v1.sqlite");
        let mut connection = open_index(&index_path).unwrap();
        initialize_schema(&connection).unwrap();
        prepare_scan(
            &connection,
            "quick",
            CleanupScanProfile::CommonLocations,
            CleanupScanTargetKind::SystemDisk,
            &fixture.path().to_string_lossy(),
            "Common locations",
            "/",
            &[first.clone(), second.clone()],
        )
        .unwrap();
        let root_id = root_node_id(&connection, "quick").unwrap();
        let mut stats = IndexScanStats::new();
        scan_quick_roots_parallel(
            &mut connection,
            &index_path,
            "quick",
            root_id,
            &[first, second],
            &home,
            fixture.path(),
            &platform_paths(&home),
            &[],
            &AtomicBool::new(false),
            &mut stats,
            &mut |_| {},
        )
        .unwrap();
        update_root_totals(&connection, "quick", root_id).unwrap();
        let root = materialize_node(&connection, "quick", root_id, 2).unwrap();

        assert_eq!(root.children.len(), 2);
        assert!(root.children.iter().any(|node| node.name == "Downloads"));
        assert!(root.children.iter().any(|node| node.name == "Caches"));
        assert_eq!(stats.scanned_entry_count, 2);
        assert!(
            fs::read_dir(storage.path())
                .unwrap()
                .flatten()
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cleanup-quick-"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn parallel_quick_scan_counts_cross_root_hard_links_once() {
        let fixture = tempdir().unwrap();
        let home = fixture.path().join("home");
        let first = home.join("Downloads");
        let second = home.join("Library/Caches");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let original = first.join("shared.bin");
        let linked = second.join("shared.bin");
        fs::write(&original, vec![7_u8; 8_192]).unwrap();
        fs::hard_link(&original, &linked).unwrap();
        let expected = allocated_file_size(&original, &fs::metadata(&original).unwrap());
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup-scan-index-v1.sqlite");
        let mut connection = open_index(&index_path).unwrap();
        initialize_schema(&connection).unwrap();
        prepare_scan(
            &connection,
            "quick-hardlink",
            CleanupScanProfile::CommonLocations,
            CleanupScanTargetKind::SystemDisk,
            &fixture.path().to_string_lossy(),
            "Common locations",
            "/",
            &[first.clone(), second.clone()],
        )
        .unwrap();
        let root_id = root_node_id(&connection, "quick-hardlink").unwrap();
        let mut stats = IndexScanStats::new();

        scan_quick_roots_parallel(
            &mut connection,
            &index_path,
            "quick-hardlink",
            root_id,
            &[first, second],
            &home,
            fixture.path(),
            &platform_paths(&home),
            &[],
            &AtomicBool::new(false),
            &mut stats,
            &mut |_| {},
        )
        .unwrap();
        update_root_totals(&connection, "quick-hardlink", root_id).unwrap();
        let root = materialize_node(&connection, "quick-hardlink", root_id, 2).unwrap();

        assert_eq!(root.allocated_size_bytes, expected);
        assert_eq!(stats.discovered_bytes, expected);
    }

    #[cfg(unix)]
    #[test]
    fn index_files_are_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        scan_folder(fixture.path(), &index_path, "permissions");

        assert_eq!(
            fs::metadata(&index_path).unwrap().permissions().mode() & 0o777,
            0o600,
        );
    }

    #[test]
    fn indexed_directory_queries_do_not_touch_the_filesystem() {
        let root = tempdir().unwrap();
        let scan_root = root.path().join("scan-root");
        let downloads = scan_root.join("Downloads");
        fs::create_dir_all(downloads.join("nested")).unwrap();
        fs::write(downloads.join("nested/file.bin"), vec![1_u8; 64]).unwrap();
        let index_path = root.path().join("index.sqlite");
        let scan = build_indexed_scan(
            CleanupScanRequest {
                profile: CleanupScanProfile::Complete,
                target_kind: CleanupScanTargetKind::Folder,
                target_path: Some(scan_root.to_string_lossy().into_owned()),
            },
            "fixture",
            &index_path,
            &AtomicBool::new(false),
            &[],
            &mut |_| {},
        )
        .unwrap();
        let downloads_node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Downloads")
            .unwrap();
        fs::remove_dir_all(&downloads).unwrap();
        let indexed =
            load_indexed_directory(&index_path, &scan.scan_id, &downloads_node.id).unwrap();
        assert_eq!(indexed.name, "Downloads");
        assert!(indexed.allocated_size_bytes > 0);
    }

    #[test]
    fn children_are_paginated_without_reading_the_filesystem() {
        let fixture = tempdir().unwrap();
        for index in 0..90 {
            fs::write(
                fixture.path().join(format!("item-{index:03}.bin")),
                vec![index as u8; 1_024],
            )
            .unwrap();
        }
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "pagination");
        fs::remove_dir_all(fixture.path()).unwrap();

        let first =
            load_indexed_children(&index_path, &scan.scan_id, &scan.root.id, 0, 24).unwrap();
        let second = load_indexed_children(
            &index_path,
            &scan.scan_id,
            &scan.root.id,
            first.next_cursor.unwrap(),
            24,
        )
        .unwrap();

        assert_eq!(first.items.len(), 24);
        assert_eq!(second.items.len(), 24);
        assert!(
            first
                .items
                .iter()
                .all(|item| item.id.starts_with("index:pagination:"))
        );
        assert!(
            first
                .items
                .iter()
                .all(|left| { second.items.iter().all(|right| left.id != right.id) })
        );
        let initial = load_indexed_directory(&index_path, &scan.scan_id, &scan.root.id).unwrap();
        assert!(
            initial
                .children
                .iter()
                .any(|node| node.id.ends_with("#other-items"))
        );
    }

    #[test]
    fn refresh_replaces_a_subtree_transactionally_and_preserves_its_id() {
        let fixture = tempdir().unwrap();
        let folder = fixture.path().join("Downloads");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("before.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "refresh");
        let before = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Downloads")
            .unwrap()
            .clone();

        fs::write(folder.join("after.bin"), vec![2_u8; 2_048]).unwrap();
        refresh_indexed_directory(
            &index_path,
            &scan.scan_id,
            &before.id,
            "refresh-job",
            &AtomicBool::new(false),
            &[],
            &mut |_| {},
        )
        .unwrap();
        let after = load_indexed_directory(&index_path, &scan.scan_id, &before.id).unwrap();

        assert_eq!(after.id, before.id);
        assert!(after.allocated_size_bytes > before.allocated_size_bytes);
        assert!(after.children.iter().any(|node| node.name == "after.bin"));
    }

    #[test]
    fn cancelled_refresh_keeps_the_previous_subtree_available() {
        let fixture = tempdir().unwrap();
        let folder = fixture.path().join("Downloads");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("before.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "refresh-cancel");
        let before = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Downloads")
            .unwrap()
            .clone();
        fs::write(folder.join("after.bin"), vec![2_u8; 2_048]).unwrap();

        let cancelled = AtomicBool::new(true);
        assert_eq!(
            refresh_indexed_directory(
                &index_path,
                &scan.scan_id,
                &before.id,
                "cancelled-refresh",
                &cancelled,
                &[],
                &mut |_| {},
            )
            .unwrap_err()
            .code,
            "cleanup_scan_cancelled",
        );
        let after = load_indexed_directory(&index_path, &scan.scan_id, &before.id).unwrap();
        assert_eq!(after.allocated_size_bytes, before.allocated_size_bytes);
        assert!(!after.children.iter().any(|node| node.name == "after.bin"));
    }

    #[test]
    fn indexed_deletions_recompute_parent_sizes_without_rescanning() {
        let fixture = tempdir().unwrap();
        let folder = fixture.path().join("Downloads");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("keep.bin"), vec![1_u8; 1_024]).unwrap();
        fs::write(folder.join("delete.bin"), vec![2_u8; 2_048]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "delete-accounting");
        let folder_summary = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Downloads")
            .unwrap()
            .clone();
        let folder_before =
            load_indexed_directory(&index_path, &scan.scan_id, &folder_summary.id).unwrap();
        let deleted = folder_before
            .children
            .iter()
            .find(|node| node.name == "delete.bin")
            .unwrap()
            .clone();

        fs::remove_file(folder.join("delete.bin")).unwrap();
        let updated = apply_indexed_deletions(
            &index_path,
            &scan.scan_id,
            std::slice::from_ref(&deleted.id),
        )
        .unwrap();
        let folder_after =
            load_indexed_directory(&index_path, &scan.scan_id, &folder_before.id).unwrap();

        assert!(folder_after.allocated_size_bytes < folder_before.allocated_size_bytes);
        assert_eq!(
            updated.root.allocated_size_bytes,
            folder_after.allocated_size_bytes
        );
        assert!(
            !folder_after
                .children
                .iter()
                .any(|node| node.id == deleted.id)
        );
    }

    #[test]
    fn indexed_deletions_preserve_omitted_file_totals() {
        let fixture = tempdir().unwrap();
        for index in 0..140 {
            fs::write(
                fixture.path().join(format!("item-{index:03}.bin")),
                vec![index as u8; 1_024],
            )
            .unwrap();
        }
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "delete-omitted-accounting");
        let visible = scan
            .root
            .children
            .iter()
            .find(|node| node.kind == CleanupNodeKind::File)
            .unwrap()
            .clone();
        let deleted_size = visible.allocated_size_bytes;
        fs::remove_file(visible.path.as_ref().unwrap()).unwrap();

        let updated = apply_indexed_deletions(
            &index_path,
            &scan.scan_id,
            std::slice::from_ref(&visible.id),
        )
        .unwrap();

        assert_eq!(
            updated.root.allocated_size_bytes,
            scan.root.allocated_size_bytes.saturating_sub(deleted_size),
        );
        assert_eq!(updated.root.item_count, scan.root.item_count - 1);
        assert!(
            updated
                .root
                .children
                .iter()
                .any(|node| node.kind == CleanupNodeKind::Aggregate)
        );
    }

    #[test]
    fn only_the_latest_detailed_index_is_kept_for_each_target() {
        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        scan_folder(fixture.path(), &index_path, "older");
        let latest = scan_folder(fixture.path(), &index_path, "latest");

        assert_eq!(latest.scan_id, "latest");
        assert!(load_indexed_scan(&index_path, "older").is_err());
        let summary = cleanup_index_summary(&index_path).unwrap();
        assert_eq!(summary.scan_count, 1);
    }

    #[test]
    fn a_custom_scan_never_counts_its_own_mutating_index() {
        let fixture = tempdir().unwrap();
        let index_path = fixture.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "self-index");

        assert_eq!(scan.root.allocated_size_bytes, 0);
        assert_eq!(scan.root.item_count, 0);
    }

    #[test]
    fn indexed_child_queries_stay_below_the_interaction_budget() {
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let mut connection = open_index(&index_path).unwrap();
        initialize_schema(&connection).unwrap();
        prepare_scan(
            &connection,
            "query-budget",
            CleanupScanProfile::Complete,
            CleanupScanTargetKind::Folder,
            storage.path().to_string_lossy().as_ref(),
            "query-budget",
            "query-budget",
            &[],
        )
        .unwrap();
        let root_id = root_node_id(&connection, "query-budget").unwrap();
        let transaction = connection.transaction().unwrap();
        for index in 0..4_000_i64 {
            transaction
                .execute(
                    "INSERT INTO nodes(
                       scan_id, parent_id, name, absolute_path, display_path,
                       logical_size_bytes, allocated_size_bytes, item_count,
                       safety, kind, deletion_protected, has_children
                     ) VALUES (
                       'query-budget', ?1, ?2, ?3, ?3, ?4, ?4, 1,
                       'review', 'folder', 0, 0
                     )",
                    params![
                        root_id,
                        format!("folder-{index:04}"),
                        format!("/virtual/folder-{index:04}"),
                        4_000_i64.saturating_sub(index),
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        drop(connection);

        let mut elapsed = Vec::new();
        for cursor in (0..2_400).step_by(24) {
            let started = Instant::now();
            let page = load_indexed_children(
                &index_path,
                "query-budget",
                &format!("index:query-budget:{root_id}"),
                cursor,
                24,
            )
            .unwrap();
            assert_eq!(page.items.len(), 24);
            elapsed.push(started.elapsed());
        }
        elapsed.sort_unstable();
        let p95 = elapsed[elapsed.len() * 95 / 100];
        assert!(
            p95 < Duration::from_millis(150),
            "indexed directory query P95 was {p95:?}",
        );
    }

    #[test]
    fn indexed_delete_requests_ignore_client_paths_and_verify_identity() {
        let fixture = tempdir().unwrap();
        let file = fixture.path().join("large.bin");
        fs::write(&file, vec![3_u8; 2_048]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "delete");
        let node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "large.bin")
            .unwrap();
        let request = CleanupDeleteLeaseRequest {
            scan_id: Some(scan.scan_id.clone()),
            directory_ids: vec![node.id.clone()],
            paths: vec!["/client/cannot/choose/this".to_owned()],
            scan_sampled_at_ms: scan.sampled_at_ms,
            scan_root: Some(fixture.path().to_string_lossy().into_owned()),
            scan_target_kind: CleanupScanTargetKind::Folder,
            expected_targets: vec![CleanupDeleteTargetEvidence {
                path: "/client/cannot/choose/this".to_owned(),
                logical_size_bytes: 1,
                allocated_size_bytes: 1,
                item_count: 1,
            }],
            mode: crate::models::CleanupDeleteMode::Permanent,
            application_uninstall: None,
        };
        let resolved = resolve_indexed_delete_request(&index_path, request).unwrap();
        assert_eq!(
            resolved.paths,
            vec![file.canonicalize().unwrap().to_string_lossy().into_owned()],
        );
        assert_eq!(resolved.expected_targets[0].logical_size_bytes, 2_048);

        #[cfg(unix)]
        {
            fs::rename(&file, fixture.path().join("original.bin")).unwrap();
            fs::write(&file, vec![4_u8; 2_048]).unwrap();
            let stale = CleanupDeleteLeaseRequest {
                scan_id: Some(scan.scan_id),
                directory_ids: vec![node.id.clone()],
                paths: vec![file.to_string_lossy().into_owned()],
                scan_sampled_at_ms: scan.sampled_at_ms,
                scan_root: Some(fixture.path().to_string_lossy().into_owned()),
                scan_target_kind: CleanupScanTargetKind::Folder,
                expected_targets: resolved.expected_targets,
                mode: crate::models::CleanupDeleteMode::Permanent,
                application_uninstall: None,
            };
            assert_eq!(
                resolve_indexed_delete_request(&index_path, stale)
                    .unwrap_err()
                    .code,
                "cleanup_index_identity_changed",
            );
        }
    }
}
