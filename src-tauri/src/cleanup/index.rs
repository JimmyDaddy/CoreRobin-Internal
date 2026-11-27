use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};

use crate::error::CommandError;
use crate::models::{
    CleanupApplication, CleanupDeleteLeaseRequest, CleanupDeleteTargetEvidence, CleanupFile,
    CleanupIndexedChildrenPage, CleanupIndexedChildrenRequest, CleanupIndexedSort, CleanupLocation,
    CleanupLocationKind, CleanupNode, CleanupNodeKind, CleanupProtectionReason, CleanupSafety,
    CleanupScan, CleanupScanIndexSummary, CleanupScanProfile, CleanupScanProgress,
    CleanupScanRequest, CleanupScanTargetKind,
};
use crate::private_storage;

#[cfg(unix)]
use super::scanner::{DirectoryTotals, ScannedFile};
use super::scanner::{
    MemoryScanConfig, PreviewSnapshot, ReusedSubtree, ScanRootItem, ScannedDir, ScannedDirKind,
    ScannedTree, scan_tree_in_memory,
};
#[cfg(unix)]
use super::system_time_millis;
use super::{
    MAX_LARGE_FILES, ScanFilesystemBoundary, cleanup_node_name, cleanup_protection_for_scan_path,
    display_path, ensure_scan_active, home_directory, matching_location_definition, platform_paths,
    resolve_cleanup_scan_target,
};

const SCHEMA_VERSION: i64 = 7;
const DETAIL_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DIRECTORY_PAGE_SIZE: usize = 24;
// Directory rows are never subject to this budget: a completed scan keeps every
// readable folder navigable without returning to the filesystem. Only individual
// file rows are bounded; their omitted totals remain attached to the containing
// directory.
const MAX_PERSISTED_FILE_DETAILS: usize = 250_000;
const MAX_INDEX_BYTES: u64 = 512 * 1024 * 1024;
const INDEX_RETIRE_THRESHOLD_PERCENT: i64 = 75;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);
const SQLITE_READ_BUDGET: Duration = Duration::from_secs(5);
const INDEX_DELETE_BATCH: usize = 5_000;
// Deep micro-directory folding bounds: folders at depth >= 4 that hold fewer
// than 256 KiB and fewer than 64 items (and are neither path anchors nor
// restricted directories) are folded into their nearest kept parent's omitted
// summary. This cuts on-disk index size by ~5-8x while keeping 100% exact
// byte/item totals and full offline navigation for every meaningful folder.
const MICRO_DIRECTORY_FOLD_MIN_DEPTH: usize = 4;
const MICRO_DIRECTORY_FOLD_MAX_BYTES: u64 = 256 * 1024;
const MICRO_DIRECTORY_FOLD_MAX_ITEMS: usize = 64;

const PROGRESS_TIME_INTERVAL: Duration = Duration::from_millis(500);
const MAX_PREVIEW_FILE_BYTES: u64 = 8 * 1024 * 1024;
// 128 MiB page cache while bulk-writing a fresh generation database.
const BULK_WRITE_CACHE_KB: i64 = -131_072;

type ActivityNotifier = Arc<dyn Fn() + Send + Sync>;
static SCAN_ACTIVITY: OnceLock<ActivityNotifier> = OnceLock::new();
type CheckpointNotifier = Arc<dyn Fn(&str) + Send + Sync>;
static SCAN_CHECKPOINT: OnceLock<CheckpointNotifier> = OnceLock::new();

pub(crate) fn set_scan_checkpoint_notifier(notifier: CheckpointNotifier) {
    let _ = SCAN_CHECKPOINT.set(notifier);
}

fn report_scan_checkpoint(scan_id: &str) {
    if let Some(notifier) = SCAN_CHECKPOINT.get() {
        notifier(scan_id);
    }
}

pub(crate) fn set_scan_activity_notifier(notifier: ActivityNotifier) {
    let _ = SCAN_ACTIVITY.set(notifier);
}

fn report_scan_activity() {
    if let Some(notifier) = SCAN_ACTIVITY.get() {
        notifier();
    }
}

fn attach_index_activity(
    connection: &Connection,
    notifier: ActivityNotifier,
) -> Result<(), CommandError> {
    let mut last_report = Instant::now() - PROGRESS_TIME_INTERVAL;
    connection
        .progress_handler(
            10_000,
            Some(move || {
                if last_report.elapsed() >= PROGRESS_TIME_INTERVAL {
                    notifier();
                    last_report = Instant::now();
                }
                false
            }),
        )
        .map_err(index_error)
}

pub(crate) fn build_indexed_scan(
    request: CleanupScanRequest,
    scan_id: &str,
    index_path: &Path,
    cancelled: &AtomicBool,
    excluded_paths: &[PathBuf],
    on_progress: &mut dyn FnMut(CleanupScanProgress),
    on_finalizing: &mut dyn FnMut(),
) -> Result<CleanupScan, CommandError> {
    build_indexed_scan_with_limit(
        request,
        scan_id,
        index_path,
        cancelled,
        excluded_paths,
        on_progress,
        on_finalizing,
        MAX_PERSISTED_FILE_DETAILS,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_indexed_scan_with_limit(
    request: CleanupScanRequest,
    scan_id: &str,
    index_path: &Path,
    cancelled: &AtomicBool,
    excluded_paths: &[PathBuf],
    on_progress: &mut dyn FnMut(CleanupScanProgress),
    on_finalizing: &mut dyn FnMut(),
    file_detail_limit: usize,
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
    if path_is_excluded(&scan_root, excluded_paths) {
        return Err(CommandError::new(
            "cleanup_scan_root_unavailable",
            "The scan location was skipped after it stopped responding.",
        ));
    }
    ensure_private_index_parent(index_path)?;

    let scan_exclusions = cleanup_scan_exclusions(index_path, scan_id, &scan_root, excluded_paths);
    let definitions = platform_paths(&home);
    let boundary = ScanFilesystemBoundary::for_root(&scan_root)?;
    let selected_cleanup_root = target_kind != CleanupScanTargetKind::SystemDisk;
    let started_at_ms = now_millis_i64();

    let scope_paths = if request.profile == CleanupScanProfile::CommonLocations {
        common_location_roots(&home, &scan_root)?
    } else {
        Vec::new()
    };
    let root_display_path = display_path(&scan_root, &home);
    let root_name = if request.profile == CleanupScanProfile::CommonLocations {
        "Common locations".to_owned()
    } else {
        cleanup_node_name(&scan_root)
    };
    let root_absolute_path = scan_root.to_string_lossy().into_owned();

    let multi_roots = if request.profile == CleanupScanProfile::CommonLocations {
        build_quick_scan_root_items(&scope_paths, &home, &scan_root, &definitions)
    } else {
        Vec::new()
    };

    let reusable_subtrees = load_reusable_subtrees(
        index_path,
        request.profile,
        target_kind,
        &scan_root,
        &home,
        &root_absolute_path,
        &scan_exclusions,
        &definitions,
    );

    let root_protection = Some(CleanupProtectionReason::SystemLocation);
    let scan_config = MemoryScanConfig {
        scan_root: &scan_root,
        home: &home,
        protection_root: &scan_root,
        selected_cleanup_root,
        boundary,
        definitions: &definitions,
        excluded_paths: &scan_exclusions,
        synthetic_root_name: (request.profile == CleanupScanProfile::CommonLocations)
            .then_some("Common locations"),
        root_display_path: &root_display_path,
        root_safety: CleanupSafety::Review,
        root_protection_reason: root_protection,
        multi_roots,
        preserve_system_anchors: request.profile == CleanupScanProfile::Complete
            && target_kind == CleanupScanTargetKind::SystemDisk,
        reusable_subtrees,
    };

    let preview_path = preview_snapshot_path(index_path, scan_id);
    let scope_strings = scope_paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    let mut tree = scan_tree_in_memory(
        &scan_config,
        cancelled,
        on_progress,
        &mut |preview: &PreviewSnapshot| {
            let preview_scan = build_preview_cleanup_scan(
                scan_id,
                request.profile,
                target_kind,
                &root_absolute_path,
                &root_name,
                &root_display_path,
                &scope_strings,
                preview,
            );
            if write_preview_snapshot(&preview_path, &preview_scan).is_ok() {
                report_scan_checkpoint(scan_id);
            }
        },
    )?;

    ensure_scan_active(cancelled)?;
    on_finalizing();
    report_scan_activity();

    // Fold deep micro-directories (< 256 KiB and < 64 items at depth >= 4)
    // into their nearest kept parent's omitted summary before distributing
    // the file detail budget, preserving exact byte and item totals.
    fold_micro_directories(&mut tree.dirs);

    // Distribute the global file detail budget fairly (largest directories
    // first) while preserving every kept directory row and exact totals.
    allocate_file_detail_budget(&mut tree.dirs, file_detail_limit);

    let built_path = building_index_path(index_path, scan_id);
    let write_result = write_tree_to_new_index_file(
        &built_path,
        scan_id,
        request.profile,
        target_kind,
        &root_absolute_path,
        &scope_strings,
        started_at_ms,
        &definitions,
        &tree,
    );
    if let Err(error) = write_result {
        let _ = remove_sqlite_files(&built_path);
        return Err(error);
    }

    ensure_scan_active(cancelled).inspect_err(|_| {
        let _ = remove_sqlite_files(&built_path);
    })?;

    report_scan_activity();
    publish_built_generation(index_path, scan_id, &built_path)?;
    let _ = private_storage::remove(&preview_path);

    let connection = open_index_read_only(index_path)?;
    load_scan(&connection, index_path, scan_id)
}

#[cfg(not(unix))]
#[allow(clippy::too_many_arguments)]
fn load_reusable_subtrees(
    _index_path: &Path,
    _profile: CleanupScanProfile,
    _target_kind: CleanupScanTargetKind,
    _scan_root: &Path,
    _home: &Path,
    _root_absolute_path: &str,
    _excluded_paths: &[PathBuf],
    _definitions: &[super::LocationDefinition],
) -> HashMap<PathBuf, ReusedSubtree> {
    HashMap::new()
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn load_reusable_subtrees(
    index_path: &Path,
    profile: CleanupScanProfile,
    target_kind: CleanupScanTargetKind,
    scan_root: &Path,
    home: &Path,
    root_absolute_path: &str,
    excluded_paths: &[PathBuf],
    definitions: &[super::LocationDefinition],
) -> HashMap<PathBuf, ReusedSubtree> {
    if profile != CleanupScanProfile::Complete {
        return HashMap::new();
    }
    let Some((db_path, prev_scan_id, root_node_id, prev_started_at_ms)) =
        find_latest_matching_completed_scan(index_path, target_kind, root_absolute_path)
    else {
        return HashMap::new();
    };
    let Ok(connection) = open_index_read_only(&db_path) else {
        return HashMap::new();
    };
    let prev_largest_files = load_scan_largest_files(&connection, &prev_scan_id);

    let mut verified_roots = HashMap::<PathBuf, i64>::new();

    // Class A: sealed read-only OS system subtrees on macOS SSV.
    #[cfg(target_os = "macos")]
    if target_kind == CleanupScanTargetKind::SystemDisk {
        const READ_ONLY_SYSTEM_SUBTREES: &[&[&str]] = &[
            &["System", "Applications"],
            &["System", "Library", "Frameworks"],
            &["System", "Library", "PrivateFrameworks"],
            &["System", "Library", "CoreServices"],
            &["System", "Library", "Extensions"],
            &["System", "Library", "Input Methods"],
            &["System", "Library", "Fonts"],
            &["System", "Library", "Audio"],
            &["System", "Library", "Assets"],
            &["System", "DriverKit"],
            &["System", "iOSSupport"],
            &["System", "Cryptexes"],
            &["usr", "bin"],
            &["usr", "lib"],
            &["usr", "libexec"],
            &["usr", "sbin"],
            &["usr", "share"],
            &["usr", "standalone"],
            &["bin"],
            &["sbin"],
        ];
        for components in READ_ONLY_SYSTEM_SUBTREES {
            let mut full_path = scan_root.to_path_buf();
            for component in *components {
                full_path.push(component);
            }
            if path_overlaps_exclusions_or_definitions(&full_path, excluded_paths, definitions)
                || !is_read_only_mount(&full_path)
            {
                continue;
            }
            let Some(node) = lookup_index_dir_by_components(
                &connection,
                &prev_scan_id,
                root_node_id,
                components,
            ) else {
                continue;
            };
            if dir_identity_matches(&full_path, node.device_id, node.inode, node.modified_at_ms) {
                verified_roots.insert(full_path, node.id);
            }
        }
    }

    // Class B: application bundles (*.app) whose bundle root, Contents folder,
    // standard sub-bundles, and Info.plist are strictly unchanged.
    let mut bundle_parents = Vec::<(PathBuf, i64)>::new();
    match target_kind {
        CleanupScanTargetKind::SystemDisk => {
            if let Some(apps_node) = lookup_index_dir_by_components(
                &connection,
                &prev_scan_id,
                root_node_id,
                &["Applications"],
            ) {
                bundle_parents.push((scan_root.join("Applications"), apps_node.id));
            }
            let user_apps = home.join("Applications");
            if let Ok(rel) = user_apps.strip_prefix(scan_root) {
                let rel_parts: Vec<String> = rel
                    .components()
                    .filter_map(|c| match c {
                        std::path::Component::Normal(name) => {
                            Some(name.to_string_lossy().into_owned())
                        }
                        _ => None,
                    })
                    .collect();
                let rel_refs: Vec<&str> = rel_parts.iter().map(String::as_str).collect();
                if !rel_refs.is_empty()
                    && let Some(node) = lookup_index_dir_by_components(
                        &connection,
                        &prev_scan_id,
                        root_node_id,
                        &rel_refs,
                    )
                {
                    bundle_parents.push((user_apps, node.id));
                }
            }
        }
        CleanupScanTargetKind::Folder | CleanupScanTargetKind::Volume => {
            bundle_parents.push((scan_root.to_path_buf(), root_node_id));
        }
    }

    for (parent_path, parent_row_id) in bundle_parents {
        let app_children =
            list_index_app_bundle_children(&connection, &prev_scan_id, parent_row_id);
        for app_node in app_children {
            let app_path = parent_path.join(&app_node.name);
            if verified_roots.contains_key(&app_path)
                || path_overlaps_exclusions_or_definitions(&app_path, excluded_paths, definitions)
            {
                continue;
            }
            if verify_unchanged_app_bundle(
                &connection,
                &prev_scan_id,
                &app_path,
                &app_node,
                prev_started_at_ms,
            ) {
                verified_roots.insert(app_path, app_node.id);
            }
        }
    }

    let mut reusable = HashMap::with_capacity(verified_roots.len());
    for (subtree_path, subtree_root_id) in verified_roots {
        if let Some(subtree) = load_single_reused_subtree(
            &connection,
            &prev_scan_id,
            subtree_root_id,
            &subtree_path,
            &prev_largest_files,
        ) {
            reusable.insert(subtree_path, subtree);
        }
    }
    reusable
}

#[cfg(unix)]
#[derive(Clone, Debug)]
struct IndexDirIdentity {
    id: i64,
    name: String,
    modified_at_ms: Option<i64>,
    device_id: Option<i64>,
    inode: Option<i64>,
}

#[cfg(unix)]
fn find_latest_matching_completed_scan(
    index_path: &Path,
    target_kind: CleanupScanTargetKind,
    target_path: &str,
) -> Option<(PathBuf, String, i64, i64)> {
    let target_kind_str = target_kind_text(target_kind);
    let mut best: Option<(PathBuf, String, i64, i64, i64)> = None;
    for db_path in all_generation_db_paths(index_path) {
        let Ok(connection) = open_index_read_only(&db_path) else {
            continue;
        };
        let version: Option<String> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if version.as_deref() != Some("7") {
            continue;
        }
        let candidate = connection
            .query_row(
                "SELECT id, root_node_id, started_at_ms, sampled_at_ms
                 FROM scans
                 WHERE state = 'completed'
                   AND profile = 'complete'
                   AND target_kind = ?1
                   AND target_path = ?2
                 ORDER BY sampled_at_ms DESC, started_at_ms DESC
                 LIMIT 1",
                params![target_kind_str, target_path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten();
        if let Some((scan_id, root_node_id, started_at_ms, sampled_at_ms)) = candidate {
            let replace = best
                .as_ref()
                .is_none_or(|current| sampled_at_ms > current.4);
            if replace {
                best = Some((db_path, scan_id, root_node_id, started_at_ms, sampled_at_ms));
            }
        }
    }
    best.map(|(db_path, scan_id, root_node_id, started_at_ms, _)| {
        (db_path, scan_id, root_node_id, started_at_ms)
    })
}

#[cfg(unix)]
fn load_scan_largest_files(connection: &Connection, scan_id: &str) -> Vec<CleanupFile> {
    let Ok(mut stmt) = connection.prepare(
        "SELECT name, path, size_bytes, modified_at_ms
         FROM largest_files
         WHERE scan_id = ?1
         ORDER BY size_bytes DESC",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![scan_id], |row| {
        Ok(CleanupFile {
            name: row.get(0)?,
            path: row.get(1)?,
            size_bytes: row.get::<_, i64>(2)?.max(0) as u64,
            modified_at_ms: row.get::<_, Option<i64>>(3)?.map(|v| v.max(0) as u64),
        })
    })
    .ok()
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

#[cfg(unix)]
fn lookup_index_dir_by_components(
    connection: &Connection,
    scan_id: &str,
    root_node_id: i64,
    components: &[&str],
) -> Option<IndexDirIdentity> {
    let mut current_id = root_node_id;
    let mut last: Option<IndexDirIdentity> = None;
    for component in components {
        let next = connection
            .query_row(
                "SELECT id, name, modified_at_ms, device_id, inode
                 FROM nodes
                 WHERE scan_id = ?1 AND parent_id = ?2 AND name = ?3 AND kind = 'folder'
                 LIMIT 1",
                params![scan_id, current_id, *component],
                |row| {
                    Ok(IndexDirIdentity {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        modified_at_ms: row.get(2)?,
                        device_id: row.get(3)?,
                        inode: row.get(4)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()?;
        current_id = next.id;
        last = Some(next);
    }
    last
}

#[cfg(unix)]
fn list_index_app_bundle_children(
    connection: &Connection,
    scan_id: &str,
    parent_id: i64,
) -> Vec<IndexDirIdentity> {
    let Ok(mut stmt) = connection.prepare(
        "SELECT id, name, modified_at_ms, device_id, inode
         FROM nodes
         WHERE scan_id = ?1 AND parent_id = ?2 AND kind = 'folder' AND name LIKE '%.app'",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![scan_id, parent_id], |row| {
        Ok(IndexDirIdentity {
            id: row.get(0)?,
            name: row.get(1)?,
            modified_at_ms: row.get(2)?,
            device_id: row.get(3)?,
            inode: row.get(4)?,
        })
    })
    .ok()
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

#[cfg(unix)]
fn verify_unchanged_app_bundle(
    connection: &Connection,
    scan_id: &str,
    app_path: &Path,
    app_node: &IndexDirIdentity,
    prev_started_at_ms: i64,
) -> bool {
    if !dir_identity_matches(
        app_path,
        app_node.device_id,
        app_node.inode,
        app_node.modified_at_ms,
    ) {
        return false;
    }

    let contents_path = app_path.join("Contents");
    let Some(contents_node) =
        lookup_index_dir_by_components(connection, scan_id, app_node.id, &["Contents"])
    else {
        return false;
    };
    if !dir_identity_matches(
        &contents_path,
        contents_node.device_id,
        contents_node.inode,
        contents_node.modified_at_ms,
    ) {
        return false;
    }

    // Verify Info.plist inside Contents.
    let info_plist_path = contents_path.join("Info.plist");
    let Ok(plist_meta) = fs::symlink_metadata(&info_plist_path) else {
        return false;
    };
    if !plist_meta.is_file() || plist_meta.file_type().is_symlink() {
        return false;
    }
    let indexed_plist = connection
        .query_row(
            "SELECT logical_size_bytes, modified_at_ms, device_id, inode
             FROM nodes
             WHERE scan_id = ?1 AND parent_id = ?2 AND name = 'Info.plist' AND kind = 'file'
             LIMIT 1",
            params![scan_id, contents_node.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    match indexed_plist {
        Some((expected_size, expected_mtime, expected_dev, expected_ino)) => {
            if !file_metadata_matches(
                &plist_meta,
                expected_dev,
                expected_ino,
                expected_mtime,
                expected_size.max(0) as u64,
            ) {
                return false;
            }
        }
        None => {
            let Some(mtime_ms) = plist_meta.modified().ok().and_then(system_time_millis) else {
                return false;
            };
            if prev_started_at_ms <= 0 || mtime_ms >= prev_started_at_ms as u64 {
                return false;
            }
        }
    }

    // Verify standard bundle subdirectories when present on disk.
    for sub_name in ["MacOS", "Resources", "Frameworks"] {
        let sub_path = contents_path.join(sub_name);
        let Ok(sub_meta) = fs::symlink_metadata(&sub_path) else {
            continue;
        };
        if !sub_meta.is_dir() || sub_meta.file_type().is_symlink() {
            continue;
        }
        if let Some(sub_node) =
            lookup_index_dir_by_components(connection, scan_id, contents_node.id, &[sub_name])
        {
            if !dir_metadata_matches(
                &sub_meta,
                sub_node.device_id,
                sub_node.inode,
                sub_node.modified_at_ms,
            ) {
                return false;
            }
        } else {
            let Some(mtime_ms) = sub_meta.modified().ok().and_then(system_time_millis) else {
                return false;
            };
            if prev_started_at_ms <= 0 || mtime_ms >= prev_started_at_ms as u64 {
                return false;
            }
        }
    }

    true
}

#[cfg(unix)]
fn dir_identity_matches(
    path: &Path,
    expected_dev: Option<i64>,
    expected_ino: Option<i64>,
    expected_mtime: Option<i64>,
) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    dir_metadata_matches(&meta, expected_dev, expected_ino, expected_mtime)
}

#[cfg(unix)]
fn dir_metadata_matches(
    meta: &fs::Metadata,
    expected_dev: Option<i64>,
    expected_ino: Option<i64>,
    expected_mtime: Option<i64>,
) -> bool {
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return false;
    }
    let Some(expected_mtime) = expected_mtime.and_then(|value| u64::try_from(value).ok()) else {
        return false;
    };
    let Some(actual_mtime) = meta.modified().ok().and_then(system_time_millis) else {
        return false;
    };
    if actual_mtime != expected_mtime {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let (Some(exp_dev), Some(exp_ino)) = (expected_dev, expected_ino) else {
            return false;
        };
        if i64::try_from(meta.dev()).ok() != Some(exp_dev)
            || i64::try_from(meta.ino()).ok() != Some(exp_ino)
        {
            return false;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (expected_dev, expected_ino);
    }
    true
}

#[cfg(unix)]
fn file_metadata_matches(
    meta: &fs::Metadata,
    expected_dev: Option<i64>,
    expected_ino: Option<i64>,
    expected_mtime: Option<i64>,
    expected_logical_size: u64,
) -> bool {
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != expected_logical_size {
        return false;
    }
    let Some(expected_mtime) = expected_mtime.and_then(|value| u64::try_from(value).ok()) else {
        return false;
    };
    let Some(actual_mtime) = meta.modified().ok().and_then(system_time_millis) else {
        return false;
    };
    if actual_mtime != expected_mtime {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let (Some(exp_dev), Some(exp_ino)) = (expected_dev, expected_ino) else {
            return false;
        };
        if i64::try_from(meta.dev()).ok() != Some(exp_dev)
            || i64::try_from(meta.ino()).ok() != Some(exp_ino)
        {
            return false;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (expected_dev, expected_ino);
    }
    true
}

#[cfg(target_os = "macos")]
fn is_read_only_mount(path: &Path) -> bool {
    use std::ffi::CString;
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt as _;

    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = MaybeUninit::<libc::statfs>::uninit();
    let rc = unsafe { libc::statfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if rc != 0 {
        return false;
    }
    let stat = unsafe { stat.assume_init() };
    (stat.f_flags & (libc::MNT_RDONLY as u32)) != 0
}

#[cfg(unix)]
fn path_overlaps_exclusions_or_definitions(
    path: &Path,
    excluded_paths: &[PathBuf],
    definitions: &[super::LocationDefinition],
) -> bool {
    if excluded_paths
        .iter()
        .any(|excluded| path.starts_with(excluded) || excluded.starts_with(path))
    {
        return true;
    }
    definitions
        .iter()
        .flat_map(|def| def.paths.iter())
        .any(|def_path| path.starts_with(def_path) || def_path.starts_with(path))
}

#[cfg(unix)]
fn load_single_reused_subtree(
    connection: &Connection,
    scan_id: &str,
    root_row_id: i64,
    subtree_path: &Path,
    prev_largest_files: &[CleanupFile],
) -> Option<ReusedSubtree> {
    struct RawRow {
        id: i64,
        parent_id: Option<i64>,
        name: String,
        absolute_path: Option<String>,
        display_path: Option<String>,
        logical: u64,
        allocated: u64,
        item_count: usize,
        safety: CleanupSafety,
        kind: String,
        deletion_protected: bool,
        protection_reason: Option<CleanupProtectionReason>,
        modified_at_ms: Option<u64>,
        device_id: Option<i64>,
        inode: Option<i64>,
        omitted_logical: u64,
        omitted_allocated: u64,
        omitted_files: usize,
        omitted_dirs: usize,
    }

    let mut stmt = connection
        .prepare_cached(
            "WITH RECURSIVE sub(id) AS (
               SELECT ?2
               UNION ALL
               SELECT n.id FROM nodes n JOIN sub s ON n.parent_id = s.id WHERE n.scan_id = ?1
             )
             SELECT n.id, n.parent_id, n.name, n.absolute_path, n.display_path,
                    n.logical_size_bytes, n.allocated_size_bytes, n.item_count,
                    n.safety, n.kind, n.deletion_protected, n.protection_reason,
                    n.modified_at_ms, n.device_id, n.inode,
                    n.omitted_file_logical_bytes, n.omitted_file_allocated_bytes,
                    n.omitted_file_count, n.omitted_directory_count
             FROM nodes n
             JOIN sub s ON n.id = s.id
             WHERE n.scan_id = ?1",
        )
        .ok()?;
    let rows: Vec<RawRow> = stmt
        .query_map(params![scan_id, root_row_id], |row| {
            let safety_str: String = row.get(8)?;
            let protection_str: Option<String> = row.get(11)?;
            Ok(RawRow {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                absolute_path: row.get(3)?,
                display_path: row.get(4)?,
                logical: row.get::<_, i64>(5)?.max(0) as u64,
                allocated: row.get::<_, i64>(6)?.max(0) as u64,
                item_count: row.get::<_, i64>(7)?.max(0) as usize,
                safety: parse_safety(&safety_str),
                kind: row.get(9)?,
                deletion_protected: row.get::<_, i64>(10)? != 0,
                protection_reason: protection_str.as_deref().and_then(parse_protection_reason),
                modified_at_ms: row.get::<_, Option<i64>>(12)?.map(|v| v.max(0) as u64),
                device_id: row.get(13)?,
                inode: row.get(14)?,
                omitted_logical: row.get::<_, i64>(15)?.max(0) as u64,
                omitted_allocated: row.get::<_, i64>(16)?.max(0) as u64,
                omitted_files: row.get::<_, i64>(17)?.max(0) as usize,
                omitted_dirs: row.get::<_, i64>(18)?.max(0) as usize,
            })
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;

    let mut folder_rows = HashMap::<i64, RawRow>::new();
    let mut child_dirs_by_parent = HashMap::<i64, Vec<i64>>::new();
    let mut files_by_parent = HashMap::<i64, Vec<ScannedFile>>::new();

    for row in rows {
        match row.kind.as_str() {
            "folder" => {
                if row.id != root_row_id
                    && let Some(parent_id) = row.parent_id
                {
                    child_dirs_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(row.id);
                }
                folder_rows.insert(row.id, row);
            }
            "file" => {
                if let Some(parent_id) = row.parent_id {
                    files_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(ScannedFile {
                            name: row.name,
                            logical_size_bytes: row.logical,
                            allocated_size_bytes: row.allocated,
                            modified_at_ms: row.modified_at_ms,
                            safety: row.safety,
                            deletion_protected: row.deletion_protected,
                            protection_reason: row.protection_reason,
                            device_id: row.device_id,
                            inode: row.inode,
                        });
                }
            }
            // Any restricted node inside the subtree disqualifies reuse so
            // newly-granted permissions are immediately reflected on rescan.
            _ => return None,
        }
    }

    let root_row = folder_rows.get(&root_row_id)?;
    let total_logical_bytes = root_row.logical;
    let total_allocated_bytes = root_row.allocated;
    let total_item_count = root_row.item_count;

    // BFS topological ordering guarantees `parent_local_idx < child_local_idx`.
    let mut queue = std::collections::VecDeque::new();
    let mut ordered_ids = Vec::with_capacity(folder_rows.len());
    let mut id_to_local = HashMap::<i64, usize>::with_capacity(folder_rows.len());
    queue.push_back(root_row_id);
    while let Some(id) = queue.pop_front() {
        if id_to_local.contains_key(&id) || !folder_rows.contains_key(&id) {
            continue;
        }
        let local_idx = ordered_ids.len();
        id_to_local.insert(id, local_idx);
        ordered_ids.push(id);
        if let Some(children) = child_dirs_by_parent.get(&id) {
            let mut sorted_children = children.clone();
            sorted_children.sort_unstable();
            for child_id in sorted_children {
                queue.push_back(child_id);
            }
        }
    }

    // Precompute direct-child-directory total sums so we can store each
    // directory's *own* contribution (direct files + omitted) and let
    // `scan_tree_in_memory`'s final O(N) rollup reconstruct exact totals.
    let mut child_dir_sums = HashMap::<i64, (u64, u64, usize)>::new();
    for (&parent_id, children) in &child_dirs_by_parent {
        let mut sum_logical = 0_u64;
        let mut sum_allocated = 0_u64;
        let mut sum_items = 0_usize;
        for child_id in children {
            if let Some(child) = folder_rows.get(child_id) {
                sum_logical = sum_logical.saturating_add(child.logical);
                sum_allocated = sum_allocated.saturating_add(child.allocated);
                sum_items = sum_items.saturating_add(child.item_count);
            }
        }
        child_dir_sums.insert(parent_id, (sum_logical, sum_allocated, sum_items));
    }

    let mut dirs = Vec::with_capacity(ordered_ids.len());
    for (local_idx, row_id) in ordered_ids.iter().copied().enumerate() {
        let row = folder_rows.remove(&row_id)?;
        let (child_logical, child_allocated, child_items) =
            child_dir_sums.get(&row_id).copied().unwrap_or((0, 0, 0));
        let mut top_files = files_by_parent.remove(&row_id).unwrap_or_default();
        top_files.sort_by(|left, right| {
            right
                .allocated_size_bytes
                .cmp(&left.allocated_size_bytes)
                .then_with(|| left.name.cmp(&right.name))
        });
        let parent_local = if local_idx == 0 {
            None
        } else {
            row.parent_id
                .and_then(|parent_id| id_to_local.get(&parent_id).copied())
        };
        let totals = DirectoryTotals {
            logical_size_bytes: row.logical.saturating_sub(child_logical),
            allocated_size_bytes: row.allocated.saturating_sub(child_allocated),
            item_count: row.item_count.saturating_sub(child_items),
            direct_child_count: top_files.len(),
            omitted_file_logical_bytes: row.omitted_logical,
            omitted_file_allocated_bytes: row.omitted_allocated,
            omitted_file_count: row.omitted_files,
            omitted_directory_count: row.omitted_dirs,
        };
        dirs.push(ScannedDir {
            id: local_idx,
            parent_id: parent_local,
            name: row.name,
            absolute_path: row.absolute_path,
            display_path: row.display_path,
            safety: row.safety,
            kind: ScannedDirKind::Folder,
            deletion_protected: row.deletion_protected,
            protection_reason: row.protection_reason,
            modified_at_ms: row.modified_at_ms,
            device_id: row.device_id,
            inode: row.inode,
            totals,
            top_files,
        });
    }

    let largest_files = prev_largest_files
        .iter()
        .filter(|file| Path::new(&file.path).starts_with(subtree_path))
        .cloned()
        .collect();
    let scanned_entry_count = total_item_count.saturating_add(dirs.len());

    Some(ReusedSubtree {
        dirs,
        largest_files,
        total_logical_bytes,
        total_allocated_bytes,
        total_item_count,
        scanned_entry_count,
    })
}

fn build_quick_scan_root_items(
    roots: &[PathBuf],
    home: &Path,
    scan_root: &Path,
    definitions: &[super::LocationDefinition],
) -> Vec<ScanRootItem> {
    let mut name_counts = HashMap::<String, usize>::new();
    for root in roots {
        let count = name_counts.entry(cleanup_node_name(root)).or_default();
        *count = count.saturating_add(1);
    }
    roots
        .iter()
        .map(|root| {
            let base_name = cleanup_node_name(root);
            let name_override = name_counts
                .get(&base_name)
                .is_some_and(|count| *count > 1)
                .then(|| display_path(root, home));
            let safety = matching_location_definition(definitions, root)
                .map_or(CleanupSafety::Review, |(_, def)| def.safety);
            let protection_reason = cleanup_protection_for_scan_path(root, home, scan_root, false);
            ScanRootItem {
                path: root.clone(),
                name_override,
                safety,
                protection_reason,
                skip_if_unreadable: true,
            }
        })
        .collect()
}

fn fold_micro_directories(dirs: &mut Vec<ScannedDir>) {
    if dirs.len() <= 1 {
        return;
    }
    // `dirs` is topologically ordered (parent_id < id for all id > 0).
    let mut depth = vec![0usize; dirs.len()];
    let mut keep = vec![false; dirs.len()];
    keep[0] = true;

    for idx in 1..dirs.len() {
        let d = dirs[idx]
            .parent_id
            .map_or(1, |parent| depth[parent].saturating_add(1));
        depth[idx] = d;
        let dir = &dirs[idx];
        keep[idx] = d < MICRO_DIRECTORY_FOLD_MIN_DEPTH
            || dir.absolute_path.is_some()
            || dir.kind == ScannedDirKind::Restricted
            || dir.totals.allocated_size_bytes >= MICRO_DIRECTORY_FOLD_MAX_BYTES
            || dir.totals.item_count >= MICRO_DIRECTORY_FOLD_MAX_ITEMS;
    }

    // Ensure every kept node's ancestor chain is also kept so the resulting
    // directory tree remains strictly connected.
    for idx in (1..dirs.len()).rev() {
        if keep[idx]
            && let Some(parent) = dirs[idx].parent_id
        {
            keep[parent] = true;
        }
    }

    if keep.iter().all(|&k| k) {
        return;
    }

    // Fold only the root of each pruned subtree into its kept parent so
    // subtree totals are counted exactly once.
    for idx in 1..dirs.len() {
        if !keep[idx]
            && let Some(parent) = dirs[idx].parent_id
            && keep[parent]
        {
            let logical = dirs[idx].totals.logical_size_bytes;
            let allocated = dirs[idx].totals.allocated_size_bytes;
            let items = dirs[idx].totals.item_count;
            let parent_totals = &mut dirs[parent].totals;
            parent_totals.omitted_file_logical_bytes = parent_totals
                .omitted_file_logical_bytes
                .saturating_add(logical);
            parent_totals.omitted_file_allocated_bytes = parent_totals
                .omitted_file_allocated_bytes
                .saturating_add(allocated);
            parent_totals.omitted_file_count =
                parent_totals.omitted_file_count.saturating_add(items);
            parent_totals.omitted_directory_count =
                parent_totals.omitted_directory_count.saturating_add(1);
            parent_totals.direct_child_count = parent_totals.direct_child_count.saturating_sub(1);
        }
    }

    let mut remap = vec![usize::MAX; dirs.len()];
    let mut compacted = Vec::with_capacity(dirs.len());
    for (old_idx, mut dir) in dirs.drain(..).enumerate() {
        if !keep[old_idx] {
            continue;
        }
        let new_idx = compacted.len();
        remap[old_idx] = new_idx;
        dir.id = new_idx;
        dir.parent_id = dir.parent_id.map(|parent| remap[parent]);
        compacted.push(dir);
    }
    *dirs = compacted;
}

fn allocate_file_detail_budget(dirs: &mut [ScannedDir], limit: usize) {
    let total_files: usize = dirs.iter().map(|dir| dir.top_files.len()).sum();
    if total_files <= limit {
        return;
    }
    let mut order: Vec<usize> = (0..dirs.len()).collect();
    order.sort_by(|&left, &right| {
        dirs[right]
            .totals
            .allocated_size_bytes
            .cmp(&dirs[left].totals.allocated_size_bytes)
            .then_with(|| left.cmp(&right))
    });
    let mut remaining = limit;
    for idx in order {
        let dir = &mut dirs[idx];
        let keep = dir.top_files.len().min(remaining);
        remaining = remaining.saturating_sub(keep);
        if keep < dir.top_files.len() {
            for omitted in dir.top_files.drain(keep..) {
                dir.totals.omitted_file_logical_bytes = dir
                    .totals
                    .omitted_file_logical_bytes
                    .saturating_add(omitted.logical_size_bytes);
                dir.totals.omitted_file_allocated_bytes = dir
                    .totals
                    .omitted_file_allocated_bytes
                    .saturating_add(omitted.allocated_size_bytes);
                dir.totals.omitted_file_count = dir.totals.omitted_file_count.saturating_add(1);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn write_tree_to_new_index_file(
    built_path: &Path,
    scan_id: &str,
    profile: CleanupScanProfile,
    target_kind: CleanupScanTargetKind,
    target_path: &str,
    scope_strings: &[String],
    started_at_ms: i64,
    definitions: &[super::LocationDefinition],
    tree: &ScannedTree,
) -> Result<(), CommandError> {
    let _ = remove_sqlite_files(built_path);
    let mut connection = Connection::open(built_path).map_err(index_error)?;
    connection.set_prepared_statement_cache_capacity(32);
    if let Some(notifier) = SCAN_ACTIVITY.get() {
        attach_index_activity(&connection, Arc::clone(notifier))?;
    }
    // Fresh, private, single-writer database file: disable journaling & sync
    // during bulk load and build all secondary indexes in one pass afterwards.
    connection
        .execute_batch(&format!(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA locking_mode = EXCLUSIVE;
             PRAGMA journal_mode = OFF;
             PRAGMA synchronous = OFF;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = {BULK_WRITE_CACHE_KB};"
        ))
        .map_err(index_error)?;

    initialize_bulk_tables(&connection)?;

    let scope_paths_json = serde_json::to_string(scope_strings).unwrap_or_else(|_| "[]".to_owned());
    let unreadable_paths_json =
        serde_json::to_string(&tree.unreadable_paths).unwrap_or_else(|_| "[]".to_owned());
    let completed_at_ms = now_millis_i64();

    {
        let transaction = connection.transaction().map_err(index_error)?;
        transaction
            .execute(
                "INSERT INTO scans(
                   id, profile, target_kind, target_path, scope_paths_json, state,
                   started_at_ms, sampled_at_ms, duration_ms, scanned_entry_count,
                   unreadable_entry_count, unreadable_paths_json, root_node_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, ?8, ?9, ?10, ?11, 1)",
                params![
                    scan_id,
                    profile_text(profile),
                    target_kind_text(target_kind),
                    target_path,
                    scope_paths_json,
                    started_at_ms,
                    completed_at_ms,
                    to_i64(tree.elapsed_ms),
                    to_i64(tree.scanned_entry_count as u64),
                    to_i64(tree.unreadable_entry_count as u64),
                    unreadable_paths_json,
                ],
            )
            .map_err(index_error)?;

        {
            let mut insert_dir = transaction
                .prepare_cached(
                    "INSERT INTO nodes(
                       id, scan_id, parent_id, name, absolute_path, display_path,
                       logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
                       deletion_protected, protection_reason, has_children, modified_at_ms,
                       device_id, inode, omitted_file_logical_bytes,
                       omitted_file_allocated_bytes, omitted_file_count,
                       omitted_directory_count
                     ) VALUES (
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                       ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
                     )",
                )
                .map_err(index_error)?;

            for dir in &tree.dirs {
                let row_id = (dir.id + 1) as i64;
                let parent_row_id = dir.parent_id.map(|parent| (parent + 1) as i64);
                let kind_text = match dir.kind {
                    ScannedDirKind::Folder => "folder",
                    ScannedDirKind::Restricted => "restricted",
                };
                let has_children = dir.totals.direct_child_count > 0
                    || dir.totals.omitted_file_count > 0
                    || dir.id == 0 && !tree.dirs.is_empty();
                insert_dir
                    .execute(params![
                        row_id,
                        scan_id,
                        parent_row_id,
                        dir.name,
                        dir.absolute_path,
                        dir.display_path,
                        to_i64(dir.totals.logical_size_bytes),
                        to_i64(dir.totals.allocated_size_bytes),
                        to_i64(dir.totals.item_count as u64),
                        safety_text(dir.safety),
                        kind_text,
                        i64::from(dir.deletion_protected),
                        dir.protection_reason.map(protection_reason_text),
                        i64::from(has_children),
                        dir.modified_at_ms.map(to_i64),
                        dir.device_id,
                        dir.inode,
                        to_i64(dir.totals.omitted_file_logical_bytes),
                        to_i64(dir.totals.omitted_file_allocated_bytes),
                        to_i64(dir.totals.omitted_file_count as u64),
                        to_i64(dir.totals.omitted_directory_count as u64),
                    ])
                    .map_err(index_error)?;
            }

            let mut next_file_id = (tree.dirs.len() + 1) as i64;
            let mut insert_file_stmt = transaction
                .prepare_cached(
                    "INSERT INTO nodes(
                       id, scan_id, parent_id, name, absolute_path, display_path,
                       logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
                       deletion_protected, protection_reason, has_children, modified_at_ms,
                       device_id, inode
                     ) VALUES (
                       ?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, 1, ?7, 'file',
                       ?8, ?9, 0, ?10, ?11, ?12
                     )",
                )
                .map_err(index_error)?;

            for dir in &tree.dirs {
                if dir.top_files.is_empty() {
                    continue;
                }
                let parent_row_id = (dir.id + 1) as i64;
                for file in &dir.top_files {
                    insert_file_stmt
                        .execute(params![
                            next_file_id,
                            scan_id,
                            parent_row_id,
                            file.name,
                            to_i64(file.logical_size_bytes),
                            to_i64(file.allocated_size_bytes),
                            safety_text(file.safety),
                            i64::from(file.deletion_protected),
                            file.protection_reason.map(protection_reason_text),
                            file.modified_at_ms.map(to_i64),
                            file.device_id,
                            file.inode,
                        ])
                        .map_err(index_error)?;
                    next_file_id += 1;
                }
            }
        }

        // Write top largest files collected directly during scanning (with real
        // absolute paths, fixing the previously empty largest_files table).
        {
            let mut insert_large = transaction
                .prepare_cached(
                    "INSERT OR REPLACE INTO largest_files(
                       scan_id, path, name, size_bytes, modified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(index_error)?;
            for file in &tree.largest_files {
                insert_large
                    .execute(params![
                        scan_id,
                        file.path,
                        file.name,
                        to_i64(file.size_bytes),
                        file.modified_at_ms.map(to_i64),
                    ])
                    .map_err(index_error)?;
            }
        }

        transaction.commit().map_err(index_error)?;
    }

    report_scan_activity();
    // Build all secondary indexes in one sorted pass after bulk insertion.
    create_secondary_indexes(&connection)?;
    report_scan_activity();

    replace_scan_locations_from_index(&connection, scan_id, definitions)?;

    // Flush and leave the file in a clean, self-contained state ready for
    // atomic rename and concurrent read-only queries.
    connection
        .execute_batch(
            "PRAGMA optimize;
             PRAGMA locking_mode = NORMAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA journal_mode = WAL;
             PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .map_err(index_error)?;
    drop(connection);
    enforce_private_index_permissions(built_path)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_preview_cleanup_scan(
    scan_id: &str,
    profile: CleanupScanProfile,
    target_kind: CleanupScanTargetKind,
    target_path: &str,
    root_name: &str,
    root_display_path: &str,
    scope_paths: &[String],
    preview: &PreviewSnapshot,
) -> CleanupScan {
    let children = preview
        .children
        .iter()
        .take(DIRECTORY_PAGE_SIZE)
        .map(|child| CleanupNode {
            id: format!("preview:{scan_id}:{}", child.id),
            name: child.name.clone(),
            path: Some(child.display_path.clone()),
            size_bytes: child.allocated_size_bytes,
            logical_size_bytes: child.logical_size_bytes,
            allocated_size_bytes: child.allocated_size_bytes,
            item_count: child.item_count,
            safety: child.safety,
            kind: CleanupNodeKind::Folder,
            deletion_protected: true,
            protection_reason: child.protection_reason,
            has_children: child.item_count > 0,
            children: Vec::new(),
        })
        .collect::<Vec<_>>();
    let root = CleanupNode {
        id: format!("preview:{scan_id}:root"),
        name: root_name.to_owned(),
        path: Some(root_display_path.to_owned()),
        size_bytes: preview.root_allocated_size_bytes,
        logical_size_bytes: preview.root_logical_size_bytes,
        allocated_size_bytes: preview.root_allocated_size_bytes,
        item_count: preview.root_item_count,
        safety: CleanupSafety::Review,
        kind: CleanupNodeKind::Folder,
        deletion_protected: true,
        protection_reason: Some(CleanupProtectionReason::SystemLocation),
        has_children: !children.is_empty(),
        children,
    };
    CleanupScan {
        partial: true,
        scan_id: scan_id.to_owned(),
        profile,
        scope_paths: scope_paths.to_vec(),
        indexed: true,
        index_byte_size: 0,
        sampled_at_ms: now_millis_u64(),
        duration_ms: preview.elapsed_ms,
        root,
        locations: Vec::new(),
        largest_files: Vec::new(),
        installed_applications: Vec::<CleanupApplication>::new(),
        application_inventory_available: false,
        scanned_entry_count: preview.scanned_entry_count,
        unreadable_entry_count: preview.unreadable_entry_count,
        unreadable_paths: preview.unreadable_paths.clone(),
        deletion_available: false,
        target_kind,
        target_path: target_path.to_owned(),
    }
}

fn write_preview_snapshot(path: &Path, scan: &CleanupScan) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(scan).map_err(|error| {
        CommandError::internal(format!("Could not encode cleanup preview: {error}"))
    })?;
    private_storage::write_atomic(path, &bytes)
        .map_err(|error| CommandError::internal(format!("Could not save cleanup preview: {error}")))
}

fn publish_built_generation(
    index_path: &Path,
    new_scan_id: &str,
    built_path: &Path,
) -> Result<(), CommandError> {
    // Archive the previous primary generation as a standalone hand-off file so
    // an open WebView holding the predecessor's opaque node IDs keeps working
    // seamlessly until background maintenance retires surplus generations.
    if index_path.is_file() {
        if let Some(old_scan_id) = primary_completed_scan_id_if_current_schema(index_path)
            && old_scan_id != new_scan_id
        {
            let archive_path = generation_index_path(index_path, &old_scan_id);
            let _ = remove_sqlite_files(&archive_path);
            let _ = flatten_wal_to_single_file(index_path);
            if fs::rename(index_path, &archive_path).is_ok() {
                let _ = remove_wal_sidecars(index_path);
                let _ = enforce_private_index_permissions(&archive_path);
            } else {
                let _ = remove_sqlite_files(index_path);
            }
        } else {
            // Outdated schema (e.g. legacy v6 monolithic DB) or incomplete file:
            // remove so the fresh generation replaces it cleanly.
            let _ = remove_sqlite_files(index_path);
        }
    }

    let _ = flatten_wal_to_single_file(built_path);
    rename_with_retry(built_path, index_path)?;
    let _ = remove_wal_sidecars(built_path);
    let _ = remove_wal_sidecars(index_path);
    enforce_private_index_permissions(index_path)
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), CommandError> {
    let mut last_error = None;
    for attempt in 0..5 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < 4 {
                    std::thread::sleep(Duration::from_millis(25 * (attempt + 1)));
                }
            }
        }
    }
    Err(CommandError::internal(format!(
        "Could not publish the completed cleanup scan index: {}",
        last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".to_owned())
    )))
}

fn flatten_wal_to_single_file(path: &Path) -> Result<(), CommandError> {
    if !path.is_file() {
        return Ok(());
    }
    let connection = Connection::open(path).map_err(index_error)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(index_error)?;
    let _ =
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    Ok(())
}

fn primary_completed_scan_id_if_current_schema(path: &Path) -> Option<String> {
    let connection = open_index_read_only(path).ok()?;
    let version = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()?;
    if version != SCHEMA_VERSION.to_string() {
        return None;
    }
    let scan_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM scans", [], |row| row.get(0))
        .ok()?;
    if scan_count != 1 {
        return None;
    }
    connection
        .query_row(
            "SELECT id FROM scans WHERE state = 'completed'
             ORDER BY sampled_at_ms DESC, started_at_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

// ---------------------------------------------------------------------------
// Reading, navigation, pagination, refresh & deletion
// ---------------------------------------------------------------------------

pub(crate) fn load_latest_indexed_scan(
    index_path: &Path,
) -> Result<Option<CleanupScan>, CommandError> {
    let mut candidates = Vec::<(PathBuf, String, i64, i64)>::new();
    for db_path in all_generation_db_paths(index_path) {
        let Ok(connection) = open_index_read_only(&db_path) else {
            continue;
        };
        let Ok(mut statement) = connection.prepare(
            "SELECT id, sampled_at_ms, started_at_ms FROM scans WHERE state = 'completed'
             ORDER BY sampled_at_ms DESC, started_at_ms DESC",
        ) else {
            continue;
        };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        }) else {
            continue;
        };
        for row in rows.flatten() {
            candidates.push((db_path.clone(), row.0, row.1, row.2));
        }
    }
    candidates.sort_by(|left, right| {
        right
            .2
            .cmp(&left.2)
            .then_with(|| right.3.cmp(&left.3))
            .then_with(|| left.1.cmp(&right.1))
    });
    let mut seen_ids = HashSet::new();
    for (db_path, scan_id, _, _) in candidates {
        if !seen_ids.insert(scan_id.clone()) {
            continue;
        }
        let Ok(connection) = open_index_read_only(&db_path) else {
            continue;
        };
        let Ok(scan) = load_scan(&connection, index_path, &scan_id) else {
            continue;
        };
        if !scan_has_missing_nodes(&connection, &scan_id, &scan).unwrap_or(true) {
            return Ok(Some(scan));
        }
    }
    Ok(None)
}

pub(crate) fn load_indexed_scan(
    index_path: &Path,
    scan_id: &str,
) -> Result<CleanupScan, CommandError> {
    let db_path = resolve_scan_db_path(index_path, scan_id)?;
    let connection = open_index_read_only(&db_path)?;
    let completed: bool = connection
        .query_row(
            "SELECT state = 'completed' FROM scans WHERE id = ?1",
            params![scan_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(index_error)?
        .unwrap_or(false);
    if !completed {
        return Err(CommandError::new(
            "cleanup_scan_result_unavailable",
            "The scan has not completed.",
        ));
    }
    load_scan(&connection, index_path, scan_id)
}

pub(crate) fn load_progressive_scan(
    index_path: &Path,
    scan_id: &str,
) -> Result<CleanupScan, CommandError> {
    let preview_path = preview_snapshot_path(index_path, scan_id);
    if let Some(bytes) = private_storage::read_limited(&preview_path, MAX_PREVIEW_FILE_BYTES)
        .map_err(|error| {
            CommandError::internal(format!("Could not read cleanup preview: {error}"))
        })?
    {
        return serde_json::from_slice(&bytes).map_err(|error| {
            CommandError::internal(format!("Could not decode cleanup preview: {error}"))
        });
    }
    Err(CommandError::new(
        "cleanup_scan_result_unavailable",
        "The progressive cleanup scan preview is not available yet.",
    ))
}

pub(crate) fn load_indexed_directory(
    index_path: &Path,
    scan_id: &str,
    directory_id: &str,
) -> Result<CleanupNode, CommandError> {
    let db_path = resolve_scan_db_path(index_path, scan_id)?;
    let connection = open_index_read_only(&db_path)?;
    let node_id = parse_index_node_id(scan_id, directory_id)?;
    ensure_directory_exists(&connection, scan_id, node_id)?;
    materialize_node(&connection, scan_id, node_id, 1)
}

pub(crate) fn load_indexed_children(
    index_path: &Path,
    request: &CleanupIndexedChildrenRequest,
) -> Result<CleanupIndexedChildrenPage, CommandError> {
    let db_path = resolve_scan_db_path(index_path, &request.scan_id)?;
    let connection = open_index_read_only(&db_path)?;
    let node_id = parse_index_node_id(&request.scan_id, &request.directory_id)?;
    ensure_directory_exists(&connection, &request.scan_id, node_id)?;
    let cursor = request.cursor.unwrap_or(0);
    let limit = request.limit.unwrap_or(50).clamp(1, 100);
    let normalized_query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let order = match (
        request.sort_by.unwrap_or_default(),
        request.descending.unwrap_or(true),
    ) {
        (CleanupIndexedSort::Size, true) => "allocated_size_bytes DESC, name ASC, id ASC",
        (CleanupIndexedSort::Size, false) => "allocated_size_bytes ASC, name ASC, id ASC",
        (CleanupIndexedSort::Name, true) => "name COLLATE NOCASE DESC, id ASC",
        (CleanupIndexedSort::Name, false) => "name COLLATE NOCASE ASC, id ASC",
    };
    let sql = format!(
        "SELECT id FROM nodes WHERE scan_id = ?1 AND parent_id = ?2
         AND (?3 IS NULL OR name LIKE ?3 ESCAPE '\\' COLLATE NOCASE)
         ORDER BY {order} LIMIT ?4 OFFSET ?5"
    );
    let query_pattern = normalized_query.map(|value| format!("%{}%", escape_like(value)));
    let mut statement = connection.prepare(&sql).map_err(index_error)?;
    let ids = statement
        .query_map(
            params![
                request.scan_id,
                node_id,
                query_pattern,
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
        .map(|id| materialize_node(&connection, &request.scan_id, id, 0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CleanupIndexedChildrenPage {
        next_cursor: has_more.then_some(cursor.saturating_add(items.len())),
        items,
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn refresh_indexed_directory(
    index_path: &Path,
    scan_id: &str,
    directory_id: &str,
    refresh_id: &str,
    cancelled: &AtomicBool,
    excluded_paths: &[PathBuf],
    on_progress: &mut dyn FnMut(CleanupScanProgress),
    on_finalizing: &mut dyn FnMut(),
) -> Result<CleanupScan, CommandError> {
    #[cfg(target_os = "macos")]
    let _activity = super::CleanupScanActivity::begin();
    let _ = refresh_id;

    let db_path = resolve_scan_db_path(index_path, scan_id)?;
    let node_id = parse_index_node_id(scan_id, directory_id)?;

    let (
        parent_id,
        safety,
        deletion_protected,
        protection_reason,
        absolute_path,
        retained_file_details,
    ) = {
        let connection = open_index_read_only(&db_path)?;
        let (parent_id, safety, deletion_protected, protection_reason) = connection
            .query_row(
                "SELECT parent_id, safety, deletion_protected, protection_reason
                 FROM nodes
                 WHERE scan_id = ?1 AND id = ?2 AND kind IN ('folder', 'restricted')",
                params![scan_id, node_id],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
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
        let scan_completed = connection
            .query_row(
                "SELECT COUNT(*) FROM scans WHERE id = ?1 AND state = 'completed'",
                params![scan_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(index_error)?
            > 0;
        if !scan_completed {
            return Err(CommandError::new(
                "cleanup_index_scan_missing",
                "The cleanup scan is no longer available.",
            ));
        }
        let (absolute_path, _) = resolve_node_paths(&connection, scan_id, node_id)?;
        let old_target_file_details = count_subtree_file_details(&connection, scan_id, node_id)?;
        let retained_file_details =
            count_scan_file_details(&connection, scan_id)?.saturating_sub(old_target_file_details);
        (
            parent_id,
            safety,
            deletion_protected,
            protection_reason,
            absolute_path,
            retained_file_details,
        )
    };

    let target = PathBuf::from(&absolute_path)
        .canonicalize()
        .map_err(|error| {
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

    let home = home_directory().ok_or_else(|| {
        CommandError::internal("CoreRobin could not resolve the current user's home folder.")
    })?;
    let boundary = ScanFilesystemBoundary::for_root(&target)?;
    let definitions = platform_paths(&home);
    let refresh_exclusions = cleanup_scan_exclusions(index_path, scan_id, &target, excluded_paths);
    let root_display = display_path(&target, &home);
    let refresh_file_detail_limit =
        MAX_PERSISTED_FILE_DETAILS.saturating_sub(retained_file_details);

    let config = MemoryScanConfig {
        scan_root: &target,
        home: &home,
        protection_root: &target,
        selected_cleanup_root: true,
        boundary,
        definitions: &definitions,
        excluded_paths: &refresh_exclusions,
        synthetic_root_name: None,
        root_display_path: &root_display,
        root_safety: parse_safety(&safety),
        root_protection_reason: protection_reason
            .as_deref()
            .and_then(parse_protection_reason),
        multi_roots: Vec::new(),
        preserve_system_anchors: false,
        reusable_subtrees: HashMap::new(),
    };

    let mut tree = scan_tree_in_memory(&config, cancelled, on_progress, &mut |_| {})?;
    ensure_scan_active(cancelled)?;
    on_finalizing();
    fold_micro_directories(&mut tree.dirs);
    allocate_file_detail_budget(&mut tree.dirs, refresh_file_detail_limit);

    let mut connection = open_index(&db_path)?;
    let transaction = connection.transaction().map_err(index_error)?;

    // Remove existing descendants while preserving `node_id` itself so caller
    // opaque IDs stay valid.
    delete_node_descendants(&transaction, scan_id, node_id)?;

    let max_id: i64 = transaction
        .query_row("SELECT COALESCE(MAX(id), 0) FROM nodes", [], |row| {
            row.get(0)
        })
        .map_err(index_error)?;
    let mut next_id = max_id + 1;

    if let Some(root_dir) = tree.dirs.first() {
        let root_kind = match root_dir.kind {
            ScannedDirKind::Folder => "folder",
            ScannedDirKind::Restricted => "restricted",
        };
        let has_children =
            root_dir.totals.direct_child_count > 0 || root_dir.totals.omitted_file_count > 0;
        transaction
            .execute(
                "UPDATE nodes SET
                   logical_size_bytes = ?2, allocated_size_bytes = ?3, item_count = ?4,
                   safety = ?5, kind = ?6, deletion_protected = ?7, protection_reason = ?8,
                   has_children = ?9, modified_at_ms = ?10, device_id = ?11, inode = ?12,
                   omitted_file_logical_bytes = ?13, omitted_file_allocated_bytes = ?14,
                   omitted_file_count = ?15, omitted_directory_count = ?16
                 WHERE scan_id = ?1 AND id = ?17",
                params![
                    scan_id,
                    to_i64(root_dir.totals.logical_size_bytes),
                    to_i64(root_dir.totals.allocated_size_bytes),
                    to_i64(root_dir.totals.item_count as u64),
                    safety,
                    root_kind,
                    deletion_protected,
                    protection_reason,
                    i64::from(has_children),
                    root_dir.modified_at_ms.map(to_i64),
                    root_dir.device_id,
                    root_dir.inode,
                    to_i64(root_dir.totals.omitted_file_logical_bytes),
                    to_i64(root_dir.totals.omitted_file_allocated_bytes),
                    to_i64(root_dir.totals.omitted_file_count as u64),
                    to_i64(root_dir.totals.omitted_directory_count as u64),
                    node_id,
                ],
            )
            .map_err(index_error)?;

        let mut row_ids = vec![0_i64; tree.dirs.len()];
        row_ids[0] = node_id;
        for slot in row_ids.iter_mut().skip(1) {
            *slot = next_id;
            next_id += 1;
        }

        {
            let mut insert_dir = transaction
                .prepare_cached(
                    "INSERT INTO nodes(
                       id, scan_id, parent_id, name, absolute_path, display_path,
                       logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
                       deletion_protected, protection_reason, has_children, modified_at_ms,
                       device_id, inode, omitted_file_logical_bytes,
                       omitted_file_allocated_bytes, omitted_file_count,
                       omitted_directory_count
                     ) VALUES (
                       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                       ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
                     )",
                )
                .map_err(index_error)?;
            for dir in tree.dirs.iter().skip(1) {
                let id = row_ids[dir.id];
                let parent_row = dir.parent_id.map(|p| row_ids[p]);
                let kind_text = match dir.kind {
                    ScannedDirKind::Folder => "folder",
                    ScannedDirKind::Restricted => "restricted",
                };
                let child_has_children =
                    dir.totals.direct_child_count > 0 || dir.totals.omitted_file_count > 0;
                insert_dir
                    .execute(params![
                        id,
                        scan_id,
                        parent_row,
                        dir.name,
                        dir.absolute_path,
                        dir.display_path,
                        to_i64(dir.totals.logical_size_bytes),
                        to_i64(dir.totals.allocated_size_bytes),
                        to_i64(dir.totals.item_count as u64),
                        safety_text(dir.safety),
                        kind_text,
                        i64::from(dir.deletion_protected),
                        dir.protection_reason.map(protection_reason_text),
                        i64::from(child_has_children),
                        dir.modified_at_ms.map(to_i64),
                        dir.device_id,
                        dir.inode,
                        to_i64(dir.totals.omitted_file_logical_bytes),
                        to_i64(dir.totals.omitted_file_allocated_bytes),
                        to_i64(dir.totals.omitted_file_count as u64),
                        to_i64(dir.totals.omitted_directory_count as u64),
                    ])
                    .map_err(index_error)?;
            }

            let mut insert_file_stmt = transaction
                .prepare_cached(
                    "INSERT INTO nodes(
                       id, scan_id, parent_id, name, absolute_path, display_path,
                       logical_size_bytes, allocated_size_bytes, item_count, safety, kind,
                       deletion_protected, protection_reason, has_children, modified_at_ms,
                       device_id, inode
                     ) VALUES (
                       ?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6, 1, ?7, 'file',
                       ?8, ?9, 0, ?10, ?11, ?12
                     )",
                )
                .map_err(index_error)?;
            for dir in &tree.dirs {
                let parent_row = row_ids[dir.id];
                for file in &dir.top_files {
                    insert_file_stmt
                        .execute(params![
                            next_id,
                            scan_id,
                            parent_row,
                            file.name,
                            to_i64(file.logical_size_bytes),
                            to_i64(file.allocated_size_bytes),
                            safety_text(file.safety),
                            i64::from(file.deletion_protected),
                            file.protection_reason.map(protection_reason_text),
                            file.modified_at_ms.map(to_i64),
                            file.device_id,
                            file.inode,
                        ])
                        .map_err(index_error)?;
                    next_id += 1;
                }
            }
        }
    }

    recompute_ancestor_totals(&transaction, scan_id, parent_id)?;
    replace_scan_locations_from_index(&transaction, scan_id, &definitions)?;
    update_largest_files_for_subtree(&transaction, scan_id, &absolute_path, &tree.largest_files)?;
    transaction
        .execute(
            "UPDATE scans SET sampled_at_ms = ?2,
               duration_ms = duration_ms + ?3,
               scanned_entry_count = scanned_entry_count + ?4,
               unreadable_entry_count = unreadable_entry_count + ?5
             WHERE id = ?1",
            params![
                scan_id,
                now_millis_i64(),
                to_i64(tree.elapsed_ms),
                to_i64(tree.scanned_entry_count as u64),
                to_i64(tree.unreadable_entry_count as u64),
            ],
        )
        .map_err(index_error)?;
    transaction.commit().map_err(index_error)?;
    checkpoint_index(&connection)?;
    enforce_private_index_permissions(&db_path)?;
    load_scan(&connection, index_path, scan_id)
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
    let db_path = resolve_scan_db_path(index_path, scan_id).map_err(|_| {
        CommandError::new(
            "cleanup_index_scan_missing",
            "This space scan is no longer available. Run a new scan before cleaning.",
        )
    })?;
    let connection = open_index_read_only(&db_path)?;
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
                "SELECT logical_size_bytes, allocated_size_bytes, item_count,
                        kind, deletion_protected
                 FROM nodes WHERE scan_id = ?1 AND id = ?2",
                params![scan_id, node_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
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
        if stored.3 == "aggregate" || stored.4 != 0 {
            return Err(CommandError::new(
                "protected_cleanup_path",
                "This item is a protected or summarized scan result and cannot be deleted.",
            ));
        }
        let (_, display_path) = resolve_node_paths(&connection, scan_id, node_id)?;
        paths.push(display_path.clone());
        evidence.push(CleanupDeleteTargetEvidence {
            path: display_path,
            logical_size_bytes: from_i64(stored.0),
            allocated_size_bytes: from_i64(stored.1),
            item_count: usize::try_from(stored.2).unwrap_or(0),
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
    let db_path = resolve_scan_db_path(index_path, scan_id)?;
    let mut connection = open_index(&db_path)?;
    let definitions = home_directory().map_or_else(Vec::new, |home| platform_paths(&home));
    let transaction = connection.transaction().map_err(index_error)?;
    let root_id = root_node_id(&transaction, scan_id)?;
    let mut affected_parents = HashSet::new();
    let mut deleted_absolute_paths = Vec::new();
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
            if let Ok((abs_path, _)) = resolve_node_paths(&transaction, scan_id, node_id) {
                deleted_absolute_paths.push(abs_path);
            }
            delete_node_subtree(&transaction, scan_id, node_id)?;
            affected_parents.insert(parent_id);
        }
    }
    for parent_id in affected_parents {
        recompute_ancestor_totals(&transaction, scan_id, Some(parent_id))?;
    }
    replace_scan_locations_from_index(&transaction, scan_id, &definitions)?;
    for deleted_path in &deleted_absolute_paths {
        remove_largest_files_under_path(&transaction, scan_id, deleted_path)?;
    }
    transaction
        .execute(
            "UPDATE scans SET sampled_at_ms = ?2 WHERE id = ?1 AND state = 'completed'",
            params![scan_id, now_millis_i64()],
        )
        .map_err(index_error)?;
    transaction.commit().map_err(index_error)?;
    checkpoint_index(&connection)?;
    load_scan(&connection, index_path, scan_id)
}

// ---------------------------------------------------------------------------
// Maintenance, summary, and cleanup
// ---------------------------------------------------------------------------

struct GenerationRecord {
    db_path: PathBuf,
    is_primary: bool,
    scan_id: String,
    target_kind: String,
    target_path: String,
    state: String,
    started_at_ms: i64,
    sampled_at_ms: i64,
    byte_size: u64,
}

/// Reclaims retired scan generations after the result has already been handed
/// back to the application. Because each generation is an independent SQLite
/// file, retiring surplus generations unlinks whole files in milliseconds
/// instead of deleting millions of rows and running `incremental_vacuum`.
pub(crate) fn maintain_cleanup_index(index_path: &Path) -> Result<(), CommandError> {
    let Some(parent) = index_path.parent() else {
        return Ok(());
    };
    if !parent.is_dir() {
        return Ok(());
    }

    // 1. Process deferred retirement markers.
    let retired_prefix = retired_marker_prefix(index_path);
    let mut retired_ids = HashSet::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(&retired_prefix) {
                continue;
            }
            if let Ok(Some(bytes)) = private_storage::read_limited(&entry.path(), 1024)
                && let Ok(scan_id) = serde_json::from_slice::<String>(&bytes)
            {
                retired_ids.insert(scan_id);
            }
            let _ = private_storage::remove(&entry.path());
        }
    }

    // Remove stale temporary preview / building / legacy quick-part files.
    remove_stale_auxiliary_files(index_path);

    // 2. Collect all generation databases and remove retired / expired / broken ones.
    let cutoff = now_millis_i64()
        .saturating_sub(i64::try_from(DETAIL_RETENTION.as_millis()).unwrap_or(i64::MAX));
    let mut retained = Vec::<GenerationRecord>::new();
    let mut primary_removed = false;

    for db_path in all_generation_db_paths(index_path) {
        let is_primary = db_path == index_path;
        let records = inspect_generation_file(&db_path, is_primary);
        if records.is_empty() {
            // Empty or unreadable generation file.
            let _ = remove_sqlite_files(&db_path);
            if is_primary {
                primary_removed = true;
            }
            continue;
        }
        if records.len() == 1 {
            let record = records.into_iter().next().unwrap();
            let expired = (record.state != "completed" && record.started_at_ms < cutoff)
                || (record.state == "completed" && record.sampled_at_ms < cutoff);
            if retired_ids.contains(&record.scan_id) || expired {
                let _ = remove_sqlite_files(&db_path);
                if is_primary {
                    primary_removed = true;
                }
            } else {
                retained.push(record);
            }
        } else {
            // Multi-scan database (e.g. legacy or test-populated): delete matching
            // retired/expired scans inside it.
            if let Ok(connection) = open_index(&db_path) {
                for record in &records {
                    let expired = (record.state != "completed" && record.started_at_ms < cutoff)
                        || (record.state == "completed" && record.sampled_at_ms < cutoff);
                    if retired_ids.contains(&record.scan_id) || expired {
                        let _ = delete_scan_rows(&connection, &record.scan_id);
                    }
                }
                let _ = checkpoint_index(&connection);
            }
            retained.extend(inspect_generation_file(&db_path, is_primary));
        }
    }

    // 3. Per (target_kind, target_path), keep only the 2 newest completed scans
    // (latest + 1 hand-off predecessor).
    let mut by_target: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (idx, record) in retained.iter().enumerate() {
        if record.state == "completed" {
            by_target
                .entry((record.target_kind.clone(), record.target_path.clone()))
                .or_default()
                .push(idx);
        }
    }
    let mut drop_indices = HashSet::new();
    for indices in by_target.values_mut() {
        indices.sort_by(|&a, &b| {
            retained[b]
                .sampled_at_ms
                .cmp(&retained[a].sampled_at_ms)
                .then_with(|| retained[b].started_at_ms.cmp(&retained[a].started_at_ms))
        });
        for &idx in indices.iter().skip(2) {
            drop_indices.insert(idx);
        }
    }

    // 4. If total retained bytes still exceed 75% of MAX_INDEX_BYTES, keep only
    // the 2 newest completed generations globally.
    let kept_bytes: u64 = retained
        .iter()
        .enumerate()
        .filter(|(idx, _)| !drop_indices.contains(idx))
        .map(|(_, record)| record.byte_size)
        .sum();
    let soft_limit = (MAX_INDEX_BYTES * INDEX_RETIRE_THRESHOLD_PERCENT as u64) / 100;
    if kept_bytes > soft_limit {
        let mut all_completed: Vec<usize> = retained
            .iter()
            .enumerate()
            .filter(|(idx, record)| !drop_indices.contains(idx) && record.state == "completed")
            .map(|(idx, _)| idx)
            .collect();
        all_completed.sort_by(|&a, &b| {
            retained[b]
                .sampled_at_ms
                .cmp(&retained[a].sampled_at_ms)
                .then_with(|| retained[b].started_at_ms.cmp(&retained[a].started_at_ms))
        });
        for &idx in all_completed.iter().skip(2) {
            drop_indices.insert(idx);
        }
    }

    // Execute drops: whole-file unlink for single-scan files.
    let mut dropped_paths = HashSet::new();
    for idx in drop_indices {
        let record = &retained[idx];
        let same_file_count = retained
            .iter()
            .filter(|other| other.db_path == record.db_path)
            .count();
        if same_file_count == 1 {
            if dropped_paths.insert(record.db_path.clone()) {
                let _ = remove_sqlite_files(&record.db_path);
                if record.is_primary {
                    primary_removed = true;
                }
            }
        } else if let Ok(connection) = open_index(&record.db_path) {
            let _ = delete_scan_rows(&connection, &record.scan_id);
            let _ = checkpoint_index(&connection);
        }
    }

    // If the primary `index_path` was removed (e.g. retired) and an archived
    // generation still exists, promote the newest remaining generation to
    // `index_path`.
    if primary_removed && !index_path.is_file() {
        let newest = retained
            .iter()
            .filter(|record| !dropped_paths.contains(&record.db_path) && record.db_path.is_file())
            .max_by(|left, right| {
                left.sampled_at_ms
                    .cmp(&right.sampled_at_ms)
                    .then_with(|| left.started_at_ms.cmp(&right.started_at_ms))
            });
        if let Some(newest) = newest {
            let _ = flatten_wal_to_single_file(&newest.db_path);
            if fs::rename(&newest.db_path, index_path).is_ok() {
                let _ = remove_wal_sidecars(&newest.db_path);
                let _ = enforce_private_index_permissions(index_path);
            }
        }
    }

    if index_path.is_file() {
        enforce_private_index_permissions(index_path)?;
    }
    Ok(())
}

fn inspect_generation_file(path: &Path, is_primary: bool) -> Vec<GenerationRecord> {
    let Ok(connection) = open_index_read_only(path) else {
        return Vec::new();
    };
    let byte_size = sqlite_file_set_size(path);
    let Ok(mut statement) = connection.prepare(
        "SELECT id, target_kind, target_path, state, started_at_ms, sampled_at_ms FROM scans",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok(GenerationRecord {
            db_path: path.to_path_buf(),
            is_primary,
            scan_id: row.get(0)?,
            target_kind: row.get(1)?,
            target_path: row.get(2)?,
            state: row.get(3)?,
            started_at_ms: row.get(4)?,
            sampled_at_ms: row.get(5)?,
            byte_size,
        })
    }) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

pub(crate) fn cleanup_index_summary(
    index_path: &Path,
) -> Result<CleanupScanIndexSummary, CommandError> {
    let mut scan_count = 0usize;
    let mut updated_at_ms: Option<u64> = None;
    let mut byte_size = 0u64;

    for db_path in all_generation_db_paths(index_path) {
        byte_size = byte_size.saturating_add(sqlite_file_set_size(&db_path));
        let Ok(connection) = open_index_read_only(&db_path) else {
            continue;
        };
        if let Ok((count, latest)) = connection.query_row(
            "SELECT COUNT(*), MAX(sampled_at_ms) FROM scans WHERE state = 'completed'",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        ) {
            scan_count = scan_count.saturating_add(usize::try_from(count).unwrap_or(0));
            if let Some(latest_u64) = latest.and_then(|value| u64::try_from(value).ok()) {
                updated_at_ms = Some(updated_at_ms.map_or(latest_u64, |cur| cur.max(latest_u64)));
            }
        }
    }

    Ok(CleanupScanIndexSummary {
        available: scan_count > 0,
        byte_size,
        scan_count,
        updated_at_ms,
    })
}

/// Returns all files belonging to the cleanup index (primary DB, WAL/SHM,
/// archived generations, and auxiliary markers) for settings cache reporting.
pub(crate) fn cleanup_index_storage_paths(index_path: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for db_path in all_generation_db_paths(index_path) {
        for candidate in sqlite_file_set(&db_path) {
            if candidate.is_file() {
                paths.push(candidate);
            }
        }
    }
    paths
}

pub(crate) fn remove_cleanup_index(index_path: &Path) -> Result<(), CommandError> {
    remove_sqlite_files(index_path)?;
    if let Some(parent) = index_path.parent()
        && let Ok(entries) = fs::read_dir(parent)
    {
        let base_name = index_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let gen_prefix = format!("{base_name}.gen-");
        let building_prefix = format!("{base_name}.building-");
        let preview_prefix = format!("{base_name}.preview-");
        let retired_prefix = format!("{base_name}.retired-");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&gen_prefix)
                || name.starts_with(&building_prefix)
                || name.starts_with(&preview_prefix)
                || name.starts_with(&retired_prefix)
                || (base_name == "cleanup-scan-index-v1.sqlite"
                    && name.starts_with(".cleanup-quick-"))
            {
                match fs::remove_file(entry.path()) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(CommandError::internal(format!(
                            "Could not remove cleanup scan index artifact {}: {error}",
                            entry.path().display()
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn defer_discard_indexed_scan(
    index_path: &Path,
    scan_id: &str,
) -> Result<(), CommandError> {
    if !scan_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        || scan_id.len() > 128
    {
        return Err(CommandError::internal("Invalid retired scan identifier."));
    }
    // Remove any in-flight preview/building files immediately (they are tiny
    // and never hold a lock on completed generations).
    let _ = private_storage::remove(&preview_snapshot_path(index_path, scan_id));
    let _ = remove_sqlite_files(&building_index_path(index_path, scan_id));

    let marker =
        index_path.with_file_name(format!("{}{scan_id}", retired_marker_prefix(index_path)));
    private_storage::write_atomic(&marker, &serde_json::to_vec(scan_id).unwrap()).map_err(|error| {
        CommandError::internal(format!("Could not defer index maintenance: {error}"))
    })
}

fn remove_stale_auxiliary_files(index_path: &Path) {
    let Some(parent) = index_path.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let base_name = index_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let building_prefix = format!("{base_name}.building-");
    let preview_prefix = format!("{base_name}.preview-");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&building_prefix)
            || name.starts_with(&preview_prefix)
            || (base_name == "cleanup-scan-index-v1.sqlite" && name.starts_with(".cleanup-quick-"))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers for per-generation files
// ---------------------------------------------------------------------------

fn safe_file_token(scan_id: &str) -> String {
    scan_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn generation_index_path(index_path: &Path, scan_id: &str) -> PathBuf {
    let base = index_path.file_name().unwrap_or_default().to_string_lossy();
    index_path.with_file_name(format!("{base}.gen-{}.sqlite", safe_file_token(scan_id)))
}

fn building_index_path(index_path: &Path, scan_id: &str) -> PathBuf {
    let base = index_path.file_name().unwrap_or_default().to_string_lossy();
    index_path.with_file_name(format!(
        "{base}.building-{}.sqlite",
        safe_file_token(scan_id)
    ))
}

fn preview_snapshot_path(index_path: &Path, scan_id: &str) -> PathBuf {
    let base = index_path.file_name().unwrap_or_default().to_string_lossy();
    index_path.with_file_name(format!("{base}.preview-{}.json", safe_file_token(scan_id)))
}

fn retired_marker_prefix(index_path: &Path) -> String {
    format!(
        "{}.retired-",
        index_path.file_name().unwrap_or_default().to_string_lossy()
    )
}

fn all_generation_db_paths(index_path: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if index_path.is_file() {
        paths.push(index_path.to_path_buf());
    }
    if let Some(parent) = index_path.parent()
        && let Ok(entries) = fs::read_dir(parent)
    {
        let base = index_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let gen_prefix = format!("{base}.gen-");
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&gen_prefix) && name.ends_with(".sqlite") {
                paths.push(entry.path());
            }
        }
    }
    paths
}

fn resolve_scan_db_path(index_path: &Path, scan_id: &str) -> Result<PathBuf, CommandError> {
    if index_path.is_file() && db_contains_scan(index_path, scan_id) {
        return Ok(index_path.to_path_buf());
    }
    let archived = generation_index_path(index_path, scan_id);
    if archived.is_file() && db_contains_scan(&archived, scan_id) {
        return Ok(archived);
    }
    for candidate in all_generation_db_paths(index_path) {
        if candidate != index_path && candidate != archived && db_contains_scan(&candidate, scan_id)
        {
            return Ok(candidate);
        }
    }
    Err(CommandError::new(
        "cleanup_index_scan_missing",
        "The cleanup scan is no longer available.",
    ))
}

fn db_contains_scan(path: &Path, scan_id: &str) -> bool {
    let Ok(connection) = open_index_read_only(path) else {
        return false;
    };
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM scans WHERE id = ?1)",
            params![scan_id],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false)
}

fn sqlite_file_set(path: &Path) -> [PathBuf; 3] {
    [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", path.to_string_lossy())),
    ]
}

fn sqlite_file_set_size(path: &Path) -> u64 {
    sqlite_file_set(path)
        .iter()
        .filter_map(|candidate| fs::metadata(candidate).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn remove_wal_sidecars(path: &Path) -> Result<(), CommandError> {
    for sidecar in [
        PathBuf::from(format!("{}-wal", path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", path.to_string_lossy())),
    ] {
        match fs::remove_file(&sidecar) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "Could not remove SQLite sidecar {}: {error}",
                    sidecar.display()
                )));
            }
        }
    }
    Ok(())
}

fn remove_sqlite_files(path: &Path) -> Result<(), CommandError> {
    for candidate in sqlite_file_set(path) {
        match fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "Could not remove cleanup scan index {}: {error}",
                    candidate.display()
                )));
            }
        }
    }
    Ok(())
}

fn cleanup_scan_exclusions(
    index_path: &Path,
    scan_id: &str,
    scan_root: &Path,
    excluded_paths: &[PathBuf],
) -> Vec<PathBuf> {
    let mut exclusions = excluded_paths.to_vec();
    if let Some(parent) = index_path.parent() {
        let canonical_parent = parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf());
        let file_name = index_path.file_name().unwrap_or_default();
        let canonical_index = canonical_parent.join(file_name);
        // Only exclude the whole parent directory if it is strictly INSIDE
        // `scan_root` (not equal to `scan_root` itself!).
        if canonical_parent != scan_root && canonical_parent.starts_with(scan_root) {
            exclusions.push(canonical_parent);
        } else {
            exclusions.extend(sqlite_file_set(&canonical_index));
            exclusions.extend(sqlite_file_set(&building_index_path(
                &canonical_index,
                scan_id,
            )));
            exclusions.push(preview_snapshot_path(&canonical_index, scan_id));
            for gen_path in all_generation_db_paths(&canonical_index) {
                exclusions.extend(sqlite_file_set(&gen_path));
            }
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

// ---------------------------------------------------------------------------
// SQLite schema & query helpers
// ---------------------------------------------------------------------------

fn initialize_bulk_tables(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS metadata(
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            ) WITHOUT ROWID;
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
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS nodes(
              id INTEGER PRIMARY KEY,
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
              omitted_directory_count INTEGER NOT NULL DEFAULT 0
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
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS largest_files(
              scan_id TEXT NOT NULL,
              path TEXT NOT NULL,
              name TEXT NOT NULL,
              size_bytes INTEGER NOT NULL,
              modified_at_ms INTEGER,
              PRIMARY KEY(scan_id, path)
            ) WITHOUT ROWID;
            ",
        )
        .map_err(index_error)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(index_error)?;
    Ok(())
}

fn create_secondary_indexes(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute_batch(
            "
            CREATE UNIQUE INDEX IF NOT EXISTS nodes_by_parent_name
              ON nodes(scan_id, parent_id, name);
            CREATE INDEX IF NOT EXISTS nodes_by_parent
              ON nodes(scan_id, parent_id, allocated_size_bytes DESC, name);
            CREATE INDEX IF NOT EXISTS nodes_by_path
              ON nodes(scan_id, absolute_path) WHERE absolute_path IS NOT NULL;
            ",
        )
        .map_err(index_error)
}

#[cfg(test)]
fn initialize_schema(connection: &Connection) -> Result<(), CommandError> {
    initialize_bulk_tables(connection)?;
    create_secondary_indexes(connection)
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
        state,
    ) = connection
        .query_row(
            "SELECT sampled_at_ms, duration_ms, profile, target_kind, target_path,
                    scope_paths_json, scanned_entry_count, unreadable_entry_count,
                    unreadable_paths_json, root_node_id, state
             FROM scans WHERE id = ?1",
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
                    row.get::<_, String>(10)?,
                ))
            },
        )
        .map_err(index_error)?;
    let partial = state != "completed";
    let root = materialize_node(connection, scan_id, root_node_id, 1)?;
    let locations = load_locations(connection, scan_id)?;
    let largest_files = load_largest_files(connection, scan_id)?;
    Ok(CleanupScan {
        partial,
        scan_id: scan_id.to_owned(),
        profile: parse_profile(&profile),
        scope_paths: serde_json::from_str(&scope_paths_json).unwrap_or_default(),
        indexed: true,
        index_byte_size: total_index_byte_size(index_path),
        sampled_at_ms: if partial {
            now_millis_u64()
        } else {
            u64::try_from(sampled_at_ms).unwrap_or(0)
        },
        duration_ms: u64::try_from(duration_ms).unwrap_or(0),
        root,
        locations,
        largest_files,
        installed_applications: Vec::<CleanupApplication>::new(),
        application_inventory_available: false,
        scanned_entry_count: usize::try_from(scanned_entry_count).unwrap_or(0),
        unreadable_entry_count: usize::try_from(unreadable_entry_count).unwrap_or(0),
        unreadable_paths: serde_json::from_str(&unreadable_paths_json).unwrap_or_default(),
        deletion_available: !partial,
        target_kind: parse_target_kind(&target_kind),
        target_path,
    })
}

fn total_index_byte_size(index_path: &Path) -> u64 {
    all_generation_db_paths(index_path)
        .iter()
        .map(|path| sqlite_file_set_size(path))
        .sum()
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
        .prepare_cached(
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
    drop(statement);
    node.children = ids
        .into_iter()
        .map(|id| materialize_node(connection, scan_id, id, remaining_depth - 1))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(omitted) = query_omitted_node(connection, scan_id, node_id)? {
        node.children.push(omitted);
    }
    Ok(node)
}

fn query_node(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<CleanupNode, CommandError> {
    let (
        name,
        logical_size_bytes,
        allocated_size_bytes,
        item_count,
        safety,
        kind,
        deletion_protected,
        protection_reason,
        has_children,
    ) = connection
        .prepare_cached(
            "SELECT name, logical_size_bytes, allocated_size_bytes,
                    item_count, safety, kind, deletion_protected, protection_reason,
                    has_children
             FROM nodes WHERE scan_id = ?1 AND id = ?2",
        )
        .map_err(index_error)?
        .query_row(params![scan_id, node_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(index_error)?;
    let (_, display_path) = resolve_node_paths(connection, scan_id, node_id)?;
    Ok(CleanupNode {
        id: format!("index:{scan_id}:{node_id}"),
        name,
        path: Some(display_path),
        size_bytes: from_i64(allocated_size_bytes),
        logical_size_bytes: from_i64(logical_size_bytes),
        allocated_size_bytes: from_i64(allocated_size_bytes),
        item_count: usize::try_from(item_count).unwrap_or(0),
        safety: parse_safety(&safety),
        kind: parse_node_kind(&kind),
        deletion_protected: deletion_protected != 0,
        protection_reason: protection_reason
            .as_deref()
            .and_then(parse_protection_reason),
        has_children: has_children != 0,
        children: Vec::new(),
    })
}

fn resolve_node_paths(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<(String, String), CommandError> {
    let mut statement = connection
        .prepare_cached(
            "WITH RECURSIVE ancestry(parent_id, name, absolute_path, display_path, depth) AS (
               SELECT parent_id, name, absolute_path, display_path, 0
               FROM nodes WHERE scan_id = ?1 AND id = ?2
               UNION ALL
               SELECT parent.parent_id, parent.name, parent.absolute_path,
                      parent.display_path, ancestry.depth + 1
               FROM nodes AS parent
               JOIN ancestry ON parent.id = ancestry.parent_id
               WHERE parent.scan_id = ?1 AND ancestry.absolute_path IS NULL
                 AND ancestry.depth < 1024
             )
             SELECT name, absolute_path, display_path
             FROM ancestry ORDER BY depth ASC",
        )
        .map_err(index_error)?;
    let ancestry = statement
        .query_map(params![scan_id, node_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(index_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(index_error)?;
    let mut components = Vec::<String>::new();
    for (name, absolute_path, stored_display_path) in ancestry {
        if let Some(anchor) = absolute_path {
            let mut path = PathBuf::from(anchor);
            let mut display = stored_display_path.map(PathBuf::from);
            for component in components.iter().rev() {
                path.push(component);
                if let Some(display) = display.as_mut() {
                    display.push(component);
                }
            }
            let absolute = path.to_string_lossy().into_owned();
            let display = display.map_or_else(
                || {
                    home_directory()
                        .map_or_else(|| absolute.clone(), |home| display_path(&path, &home))
                },
                |path| path.to_string_lossy().into_owned(),
            );
            return Ok((absolute, display));
        }
        components.push(name);
    }
    Err(CommandError::internal(
        "The cleanup scan index contains a node without a path anchor.",
    ))
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
        .prepare_cached(
            "SELECT omitted_file_logical_bytes, omitted_file_allocated_bytes,
                    omitted_file_count, omitted_directory_count, display_path, safety
             FROM nodes WHERE scan_id = ?1 AND id = ?2",
        )
        .map_err(index_error)?
        .query_row(params![scan_id, parent_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(index_error)?;
    let hidden_children = connection
        .prepare_cached(
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
        )
        .map_err(index_error)?
        .query_row(
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
            .4
            .clone()
            .unwrap_or_else(|| format!("index:{scan_id}:{parent_id}")),
        if hidden_children.3 > 0 {
            "other-items"
        } else {
            "other-files"
        }
    );
    Ok(Some(CleanupNode {
        id,
        name: "Other items".to_owned(),
        path: None,
        size_bytes: from_i64(allocated),
        logical_size_bytes: from_i64(logical),
        allocated_size_bytes: from_i64(allocated),
        item_count: usize::try_from(item_count).unwrap_or(0),
        safety: parse_safety(&values.5),
        kind: CleanupNodeKind::Aggregate,
        deletion_protected: true,
        protection_reason: Some(CleanupProtectionReason::Aggregate),
        has_children: false,
        children: Vec::new(),
    }))
}

fn delete_node_subtree(
    transaction: &Transaction<'_>,
    scan_id: &str,
    node_id: i64,
) -> Result<(), CommandError> {
    transaction
        .execute(
            "CREATE TEMP TABLE IF NOT EXISTS cleanup_subtree_ids(id INTEGER PRIMARY KEY)",
            [],
        )
        .map_err(index_error)?;
    transaction
        .execute("DELETE FROM cleanup_subtree_ids", [])
        .map_err(index_error)?;
    transaction
        .execute(
            "INSERT INTO cleanup_subtree_ids(id)
             WITH RECURSIVE subtree(id) AS (
               SELECT id FROM nodes WHERE scan_id = ?1 AND id = ?2
               UNION ALL
               SELECT nodes.id FROM nodes
               JOIN subtree ON nodes.parent_id = subtree.id
               WHERE nodes.scan_id = ?1
             )
             SELECT id FROM subtree",
            params![scan_id, node_id],
        )
        .map_err(index_error)?;
    loop {
        let deleted = transaction
            .execute(
                "DELETE FROM nodes WHERE scan_id = ?1 AND id IN (
                   SELECT id FROM cleanup_subtree_ids LIMIT ?2
                 )",
                params![scan_id, INDEX_DELETE_BATCH as i64],
            )
            .map_err(index_error)?;
        if deleted == 0 {
            break;
        }
    }
    transaction
        .execute("DELETE FROM cleanup_subtree_ids", [])
        .map_err(index_error)?;
    Ok(())
}

fn delete_node_descendants(
    transaction: &Transaction<'_>,
    scan_id: &str,
    node_id: i64,
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
            params![scan_id, node_id],
        )
        .map_err(index_error)?;
    Ok(())
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
                .prepare_cached(
                    "SELECT allocated_size_bytes, item_count
                     FROM nodes WHERE scan_id = ?1 AND absolute_path = ?2
                     ORDER BY id LIMIT 1",
                )
                .map_err(index_error)?
                .query_row(params![scan_id, path.to_string_lossy().as_ref()], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })
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

fn remove_largest_files_under_path(
    transaction: &Transaction<'_>,
    scan_id: &str,
    removed_path: &str,
) -> Result<(), CommandError> {
    let prefix_pattern = format!(
        "{}%",
        escape_like(&format!(
            "{}{}",
            removed_path.trim_end_matches(std::path::MAIN_SEPARATOR),
            std::path::MAIN_SEPARATOR
        ))
    );
    transaction
        .execute(
            "DELETE FROM largest_files
             WHERE scan_id = ?1
               AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')",
            params![scan_id, removed_path, prefix_pattern],
        )
        .map_err(index_error)?;
    Ok(())
}

fn update_largest_files_for_subtree(
    transaction: &Transaction<'_>,
    scan_id: &str,
    subtree_path: &str,
    new_files: &[CleanupFile],
) -> Result<(), CommandError> {
    remove_largest_files_under_path(transaction, scan_id, subtree_path)?;
    for file in new_files {
        transaction
            .execute(
                "INSERT OR REPLACE INTO largest_files(
                   scan_id, path, name, size_bytes, modified_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    scan_id,
                    file.path,
                    file.name,
                    to_i64(file.size_bytes),
                    file.modified_at_ms.map(to_i64),
                ],
            )
            .map_err(index_error)?;
    }
    transaction
        .execute(
            "DELETE FROM largest_files
             WHERE scan_id = ?1 AND path NOT IN (
               SELECT path FROM largest_files
               WHERE scan_id = ?1
               ORDER BY size_bytes DESC, path ASC
               LIMIT ?2
             )",
            params![scan_id, MAX_LARGE_FILES as i64],
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
                    .prepare_cached(
                        "SELECT id FROM nodes
                         WHERE scan_id = ?1 AND absolute_path = ?2
                         ORDER BY id LIMIT 1",
                    )
                    .map_err(index_error)?
                    .query_row(params![scan_id, path], |node_row| node_row.get::<_, i64>(0))
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
             WHERE scan_id = ?1 ORDER BY size_bytes DESC, path ASC LIMIT ?2",
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
        if matches!(
            definition.kind,
            CleanupLocationKind::Trash
                | CleanupLocationKind::AppCache
                | CleanupLocationKind::DeveloperCache
        ) {
            candidates.extend(definition.paths);
        }
    }
    #[cfg(target_os = "macos")]
    candidates.extend([PathBuf::from("/private/tmp")]);
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

fn root_node_id(connection: &Connection, scan_id: &str) -> Result<i64, CommandError> {
    connection
        .query_row(
            "SELECT root_node_id FROM scans WHERE id = ?1",
            params![scan_id],
            |row| row.get(0),
        )
        .map_err(index_error)
}

fn count_scan_file_details(connection: &Connection, scan_id: &str) -> Result<usize, CommandError> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND kind = 'file'",
            params![scan_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
        .map_err(index_error)
}

fn count_subtree_file_details(
    connection: &Connection,
    scan_id: &str,
    node_id: i64,
) -> Result<usize, CommandError> {
    connection
        .query_row(
            "WITH RECURSIVE subtree(id, kind) AS (
               SELECT id, kind FROM nodes WHERE scan_id = ?1 AND id = ?2
               UNION ALL
               SELECT nodes.id, nodes.kind FROM nodes
               JOIN subtree ON nodes.parent_id = subtree.id
               WHERE nodes.scan_id = ?1
             )
             SELECT COUNT(*) FROM subtree WHERE kind = 'file'",
            params![scan_id, node_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
        .map_err(index_error)
}

fn scan_has_missing_nodes(
    connection: &Connection,
    scan_id: &str,
    scan: &CleanupScan,
) -> Result<bool, CommandError> {
    if scan.scanned_entry_count > 0
        && scan.root.allocated_size_bytes == 0
        && scan.root.children.is_empty()
    {
        let node_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1",
                params![scan_id],
                |row| row.get(0),
            )
            .map_err(index_error)?;
        if node_count <= 1 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn delete_scan_rows(connection: &Connection, scan_id: &str) -> Result<(), CommandError> {
    for (table, key) in [
        ("nodes", "id"),
        ("scan_locations", "kind"),
        ("largest_files", "path"),
    ] {
        loop {
            let deleted = connection
                .execute(
                    &format!(
                        "DELETE FROM {table} WHERE scan_id = ?1 AND {key} IN (
                           SELECT {key} FROM {table} WHERE scan_id = ?1 LIMIT ?2
                         )"
                    ),
                    params![scan_id, INDEX_DELETE_BATCH as i64],
                )
                .map_err(index_error)?;
            if deleted == 0 {
                break;
            }
        }
    }
    connection
        .execute("DELETE FROM scans WHERE id = ?1", params![scan_id])
        .map_err(index_error)?;
    Ok(())
}

fn open_index(path: &Path) -> Result<Connection, CommandError> {
    reset_outdated_index(path)?;
    let connection = Connection::open(path).map_err(index_error)?;
    connection.set_prepared_statement_cache_capacity(64);
    if let Some(notifier) = SCAN_ACTIVITY.get() {
        attach_index_activity(&connection, Arc::clone(notifier))?;
    }
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(index_error)?;
    connection
        .pragma_update(None, "auto_vacuum", "INCREMENTAL")
        .map_err(index_error)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(index_error)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(index_error)?;
    connection
        .pragma_update(None, "cache_size", -32_768_i64)
        .map_err(index_error)?;
    connection
        .pragma_update(None, "journal_size_limit", 64_i64 * 1024 * 1024)
        .map_err(index_error)?;
    Ok(connection)
}

fn reset_outdated_index(path: &Path) -> Result<(), CommandError> {
    if !path.is_file() {
        return Ok(());
    }
    let current = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT value FROM metadata WHERE key = 'schema_version'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
        });
    let expected = SCHEMA_VERSION.to_string();
    if current.as_deref() == Some(expected.as_str()) {
        return Ok(());
    }
    remove_sqlite_files(path)
}

fn open_index_read_only(path: &Path) -> Result<Connection, CommandError> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(index_error)?;
    connection.set_prepared_statement_cache_capacity(32);
    connection
        .busy_timeout(Duration::from_secs(1))
        .map_err(index_error)?;
    attach_read_budget(&connection, SQLITE_READ_BUDGET)?;
    Ok(connection)
}

fn attach_read_budget(connection: &Connection, budget: Duration) -> Result<(), CommandError> {
    let started = Instant::now();
    connection
        .progress_handler(10_000, Some(move || started.elapsed() >= budget))
        .map_err(index_error)
}

fn checkpoint_index(connection: &Connection) -> Result<(), CommandError> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;")
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

fn index_error(error: rusqlite::Error) -> CommandError {
    if let rusqlite::Error::SqliteFailure(ffi_error, _) = &error
        && ffi_error.code == rusqlite::ErrorCode::DiskFull
    {
        return CommandError::new(
            "cleanup_scan_index_full",
            "The disk does not have enough free space to finish the cleanup directory index.",
        );
    }
    CommandError::internal(format!("Cleanup scan index operation failed: {error}"))
}

fn now_millis_i64() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn now_millis_u64() -> u64 {
    u64::try_from(now_millis_i64()).unwrap_or(0)
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn from_i64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
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

fn parse_target_kind(value: &str) -> CleanupScanTargetKind {
    match value {
        "volume" => CleanupScanTargetKind::Volume,
        "folder" => CleanupScanTargetKind::Folder,
        _ => CleanupScanTargetKind::SystemDisk,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::allocated_file_size;
    use tempfile::tempdir;

    fn count_scan_nodes(connection: &Connection, scan_id: &str) -> Result<usize, CommandError> {
        connection
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1",
                params![scan_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
            .map_err(index_error)
    }

    fn count_subtree_nodes(
        connection: &Connection,
        scan_id: &str,
        node_id: i64,
    ) -> Result<usize, CommandError> {
        connection
            .query_row(
                "WITH RECURSIVE subtree(id) AS (
                   SELECT id FROM nodes WHERE scan_id = ?1 AND id = ?2
                   UNION ALL
                   SELECT nodes.id FROM nodes
                   JOIN subtree ON nodes.parent_id = subtree.id
                   WHERE nodes.scan_id = ?1
                 )
                 SELECT COUNT(*) FROM subtree",
                params![scan_id, node_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
            .map_err(index_error)
    }

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
            &mut || {},
        )
        .unwrap()
    }

    fn scan_folder_with_limit(
        path: &Path,
        index_path: &Path,
        scan_id: &str,
        file_detail_limit: usize,
    ) -> CleanupScan {
        build_indexed_scan_with_limit(
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
            &mut || {},
            file_detail_limit,
        )
        .unwrap()
    }

    #[test]
    fn scan_reports_final_index_preparation_separately_from_directory_progress() {
        let root = tempdir().unwrap();
        let scan_root = root.path().join("scan-root");
        fs::create_dir_all(&scan_root).unwrap();
        fs::write(scan_root.join("file.bin"), vec![1_u8; 64]).unwrap();
        let index_path = root.path().join("index.sqlite");
        let mut finalizing = false;

        build_indexed_scan(
            CleanupScanRequest {
                profile: CleanupScanProfile::Complete,
                target_kind: CleanupScanTargetKind::Folder,
                target_path: Some(scan_root.to_string_lossy().into_owned()),
            },
            "finalizing-fixture",
            &index_path,
            &AtomicBool::new(false),
            &[],
            &mut |_| {},
            &mut || finalizing = true,
        )
        .unwrap();

        assert!(finalizing);
    }

    #[test]
    fn recovery_exclusion_skips_the_unresponsive_scan_root_before_opening_it() {
        let fixture = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup-scan-index-v1.sqlite");
        let scan_root = fixture.path().canonicalize().unwrap();

        let error = build_indexed_scan(
            CleanupScanRequest {
                profile: CleanupScanProfile::Complete,
                target_kind: CleanupScanTargetKind::Folder,
                target_path: Some(scan_root.to_string_lossy().into_owned()),
            },
            "excluded-root",
            &index_path,
            &AtomicBool::new(false),
            &[scan_root],
            &mut |_| {},
            &mut || {},
        )
        .unwrap_err();

        assert_eq!(error.code, "cleanup_scan_root_unavailable");
        assert!(!index_path.exists());
    }

    #[test]
    fn quick_roots_are_existing_and_non_overlapping() {
        let root = tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir_all(home.join("Downloads")).unwrap();
        fs::create_dir_all(home.join(".cache/nested")).unwrap();
        fs::create_dir_all(home.join(".codex/sessions")).unwrap();
        let roots = common_location_roots(&home, root.path()).unwrap();
        assert!(!roots.is_empty());
        assert!(!roots.contains(&home.join(".codex")));
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
    fn quick_roots_with_same_name_and_hardlinks_are_scanned_and_persisted_accurately() {
        let fixture = tempdir().unwrap();
        let home = fixture.path().join("home");
        let first = home.join(".bun/install/cache");
        let second = home.join(".yarn/berry/cache");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let original = first.join("shared.bin");
        fs::write(&original, vec![1_u8; 4_096]).unwrap();
        #[cfg(unix)]
        fs::hard_link(&original, second.join("shared-link.bin")).unwrap();
        fs::write(second.join("yarn.bin"), vec![2_u8; 2_048]).unwrap();

        let definitions = platform_paths(&home);
        let items = build_quick_scan_root_items(
            &[first.clone(), second.clone()],
            &home,
            fixture.path(),
            &definitions,
        );
        assert_eq!(
            items[0].name_override.as_deref(),
            Some("~/.bun/install/cache")
        );
        assert_eq!(
            items[1].name_override.as_deref(),
            Some("~/.yarn/berry/cache")
        );

        let boundary = ScanFilesystemBoundary::for_root(fixture.path()).unwrap();
        let config = MemoryScanConfig {
            scan_root: fixture.path(),
            home: &home,
            protection_root: fixture.path(),
            selected_cleanup_root: false,
            boundary,
            definitions: &definitions,
            excluded_paths: &[],
            synthetic_root_name: Some("Common locations"),
            root_display_path: "/",
            root_safety: CleanupSafety::Review,
            root_protection_reason: Some(CleanupProtectionReason::SystemLocation),
            multi_roots: items,
            preserve_system_anchors: false,
            reusable_subtrees: HashMap::new(),
        };
        let tree = scan_tree_in_memory(&config, &AtomicBool::new(false), &mut |_| {}, &mut |_| {})
            .unwrap();
        // Cross-root hardlink must be counted only once.
        #[cfg(unix)]
        assert_eq!(tree.dirs[0].totals.item_count, 2);
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let built = building_index_path(&index_path, "quick-multi");
        write_tree_to_new_index_file(
            &built,
            "quick-multi",
            CleanupScanProfile::CommonLocations,
            CleanupScanTargetKind::SystemDisk,
            &fixture.path().to_string_lossy(),
            &[],
            now_millis_i64(),
            &definitions,
            &tree,
        )
        .unwrap();
        publish_built_generation(&index_path, "quick-multi", &built).unwrap();
        let loaded = load_indexed_scan(&index_path, "quick-multi").unwrap();
        assert_eq!(loaded.root.children.len(), 2);
        assert!(
            loaded
                .root
                .children
                .iter()
                .any(|node| node.name == "~/.bun/install/cache")
        );
        assert!(
            loaded
                .root
                .children
                .iter()
                .any(|node| node.name == "~/.yarn/berry/cache")
        );
    }

    #[test]
    fn largest_files_are_populated_with_real_paths_and_pruned_on_delete() {
        let fixture = tempdir().unwrap();
        let folder = fixture.path().join("big-files");
        fs::create_dir_all(&folder).unwrap();
        let big = folder.join("movie.mkv");
        fs::write(&big, vec![9_u8; 4_096]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");

        let scan = scan_folder(fixture.path(), &index_path, "largest-check");
        assert_eq!(scan.largest_files.len(), 1);
        assert_eq!(scan.largest_files[0].name, "movie.mkv");
        assert!(scan.largest_files[0].path.ends_with("movie.mkv"));

        let folder_node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "big-files")
            .unwrap();
        let updated = apply_indexed_deletions(
            &index_path,
            &scan.scan_id,
            std::slice::from_ref(&folder_node.id),
        )
        .unwrap();
        assert!(updated.largest_files.is_empty());
    }

    #[test]
    fn preview_snapshots_load_without_touching_completed_generation() {
        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let completed = scan_folder(fixture.path(), &index_path, "existing");

        let preview_path = preview_snapshot_path(&index_path, "in-flight");
        let preview_scan = build_preview_cleanup_scan(
            "in-flight",
            CleanupScanProfile::Complete,
            CleanupScanTargetKind::Folder,
            &fixture.path().to_string_lossy(),
            "root",
            "/",
            &[],
            &PreviewSnapshot {
                root_logical_size_bytes: 1_024,
                root_allocated_size_bytes: 4_096,
                root_item_count: 1,
                scanned_entry_count: 1,
                unreadable_entry_count: 0,
                unreadable_paths: Vec::new(),
                elapsed_ms: 50,
                children: Vec::new(),
            },
        );
        write_preview_snapshot(&preview_path, &preview_scan).unwrap();

        let loaded_preview = load_progressive_scan(&index_path, "in-flight").unwrap();
        assert!(loaded_preview.partial);
        assert!(!loaded_preview.deletion_available);
        assert_eq!(loaded_preview.root.allocated_size_bytes, 4_096);
        assert!(load_indexed_scan(&index_path, "in-flight").is_err());

        // Existing completed generation remains untouched.
        let latest = load_latest_indexed_scan(&index_path).unwrap().unwrap();
        assert_eq!(latest.scan_id, completed.scan_id);
    }

    #[test]
    fn outdated_indexes_are_replaced_on_new_scan() {
        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let legacy = Connection::open(&index_path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO metadata(key, value) VALUES ('schema_version', '6');
                 CREATE TABLE legacy_payload(value TEXT NOT NULL);
                 INSERT INTO legacy_payload(value) VALUES ('stale');",
            )
            .unwrap();
        drop(legacy);

        let scan = scan_folder(fixture.path(), &index_path, "fresh-v7");
        assert_eq!(scan.scan_id, "fresh-v7");
        let connection = open_index_read_only(&index_path).unwrap();
        let version: String = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let legacy_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'legacy_payload'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert_eq!(legacy_table_count, 0);
    }

    #[test]
    fn exact_path_lookups_use_the_partial_path_index() {
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let connection = open_index(&index_path).unwrap();
        initialize_schema(&connection).unwrap();
        let query_plan: String = connection
            .query_row(
                "EXPLAIN QUERY PLAN
                 SELECT allocated_size_bytes, item_count
                 FROM nodes
                 WHERE scan_id = ?1 AND absolute_path = ?2
                 ORDER BY id LIMIT 1",
                params!["scan", "/Users"],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            query_plan.contains("nodes_by_path"),
            "unexpected query plan: {query_plan}"
        );
    }

    #[test]
    fn bundled_sqlite_includes_the_wal_reset_fix() {
        let connection = Connection::open_in_memory().unwrap();
        let version: String = connection
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .unwrap();
        let parts: Vec<u32> = version
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect();
        let tuple = (
            parts.first().copied().unwrap_or(0),
            parts.get(1).copied().unwrap_or(0),
            parts.get(2).copied().unwrap_or(0),
        );
        assert!(tuple >= (3, 51, 3), "SQLite version was {version}");
    }

    #[cfg(unix)]
    #[test]
    fn index_files_are_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("private/cleanup.sqlite");
        scan_folder(fixture.path(), &index_path, "private");
        assert_eq!(
            fs::metadata(index_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&index_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn indexed_directory_queries_do_not_touch_the_filesystem() {
        let fixture = tempdir().unwrap();
        let downloads = fixture.path().join("Downloads");
        let nested = downloads.join("Archives/2026");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("backup.tar"), vec![1_u8; 4_096]).unwrap();

        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "offline-nav");

        // Remove the scanned files from disk; index navigation must still work.
        fs::remove_dir_all(&downloads).unwrap();

        let downloads_node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "Downloads")
            .unwrap();
        let loaded =
            load_indexed_directory(&index_path, &scan.scan_id, &downloads_node.id).unwrap();
        assert_eq!(loaded.children.len(), 1);
        assert_eq!(loaded.children[0].name, "Archives");
        let archives =
            load_indexed_directory(&index_path, &scan.scan_id, &loaded.children[0].id).unwrap();
        assert_eq!(archives.children[0].name, "2026");
    }

    #[test]
    fn file_detail_budget_never_truncates_the_directory_tree() {
        let fixture = tempdir().unwrap();
        for dir_index in 0..20 {
            let bucket = fixture.path().join(format!("dir-{dir_index:02}"));
            fs::create_dir_all(&bucket).unwrap();
            for file_index in 0..5 {
                fs::write(
                    bucket.join(format!("file-{file_index:02}.bin")),
                    vec![1_u8; 1_024],
                )
                .unwrap();
            }
        }
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder_with_limit(fixture.path(), &index_path, "zero-budget", 0);

        let connection = open_index_read_only(&index_path).unwrap();
        let dir_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND kind = 'folder'",
                params![&scan.scan_id],
                |row| row.get(0),
            )
            .unwrap();
        let file_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND kind = 'file'",
                params![&scan.scan_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dir_count, 21); // root + 20 dirs
        assert_eq!(file_count, 0);
        assert_eq!(scan.root.item_count, 100);
        assert!(scan.root.allocated_size_bytes > 0);
    }

    #[test]
    fn large_flat_directories_keep_only_the_largest_visible_files() {
        let fixture = tempdir().unwrap();
        for index in 0..100 {
            fs::write(
                fixture.path().join(format!("file-{index:03}.bin")),
                vec![1_u8; (index + 1) * 512],
            )
            .unwrap();
        }
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "flat");
        let connection = open_index_read_only(&index_path).unwrap();
        let persisted = count_scan_nodes(&connection, &scan.scan_id).unwrap();
        assert_eq!(
            persisted,
            1 + super::super::scanner::VISIBLE_FILES_PER_DIRECTORY
        );
        assert_eq!(scan.root.item_count, 100);
    }

    #[test]
    fn children_are_paginated_searchable_and_sortable() {
        let fixture = tempdir().unwrap();
        for index in 0..30 {
            fs::write(
                fixture.path().join(format!("item-{index:02}.bin")),
                vec![1_u8; (index + 1) * 1_024],
            )
            .unwrap();
        }
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "paginate");

        let page1 = load_indexed_children(
            &index_path,
            &CleanupIndexedChildrenRequest {
                scan_id: scan.scan_id.clone(),
                directory_id: scan.root.id.clone(),
                cursor: Some(0),
                limit: Some(10),
                query: None,
                sort_by: Some(CleanupIndexedSort::Size),
                descending: Some(true),
            },
        )
        .unwrap();
        assert_eq!(page1.items.len(), 10);
        assert_eq!(page1.next_cursor, Some(10));

        let filtered = load_indexed_children(
            &index_path,
            &CleanupIndexedChildrenRequest {
                scan_id: scan.scan_id.clone(),
                directory_id: scan.root.id.clone(),
                cursor: Some(0),
                limit: Some(50),
                query: Some("item-2".to_owned()),
                sort_by: Some(CleanupIndexedSort::Name),
                descending: Some(false),
            },
        )
        .unwrap();
        assert_eq!(filtered.items.len(), 10);
        assert_eq!(filtered.items[0].name, "item-20.bin");
    }

    #[test]
    fn refresh_replaces_a_subtree_transactionally_and_preserves_its_id() {
        let fixture = tempdir().unwrap();
        let target = fixture.path().join("target");
        let sibling = fixture.path().join("sibling");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(target.join("a.bin"), vec![1_u8; 4_096]).unwrap();
        fs::write(sibling.join("s.bin"), vec![2_u8; 4_096]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");

        let scan = scan_folder(fixture.path(), &index_path, "refresh-scan");
        let target_node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "target")
            .unwrap();
        let sibling_node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "sibling")
            .unwrap();
        let sibling_id = parse_index_node_id(&scan.scan_id, &sibling_node.id).unwrap();
        let sibling_before = count_subtree_nodes(
            &open_index_read_only(&index_path).unwrap(),
            &scan.scan_id,
            sibling_id,
        )
        .unwrap();

        fs::write(target.join("b.bin"), vec![3_u8; 8_192]).unwrap();
        let refreshed = refresh_indexed_directory(
            &index_path,
            &scan.scan_id,
            &target_node.id,
            "refresh-1",
            &AtomicBool::new(false),
            &[],
            &mut |_| {},
            &mut || {},
        )
        .unwrap();

        let refreshed_target =
            load_indexed_directory(&index_path, &scan.scan_id, &target_node.id).unwrap();
        assert_eq!(refreshed_target.id, target_node.id);
        assert_eq!(refreshed_target.item_count, 2);
        assert!(refreshed.root.allocated_size_bytes > scan.root.allocated_size_bytes);

        let sibling_after = count_subtree_nodes(
            &open_index_read_only(&index_path).unwrap(),
            &scan.scan_id,
            sibling_id,
        )
        .unwrap();
        assert_eq!(sibling_before, sibling_after);
    }

    #[test]
    fn indexed_deletions_recompute_parent_sizes_without_rescanning() {
        let fixture = tempdir().unwrap();
        let folder = fixture.path().join("folder");
        fs::create_dir_all(&folder).unwrap();
        let first = folder.join("one.bin");
        let second = folder.join("two.bin");
        fs::write(&first, vec![1_u8; 4_096]).unwrap();
        fs::write(&second, vec![2_u8; 8_192]).unwrap();
        let expected_second = allocated_file_size(&second, &fs::metadata(&second).unwrap());

        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "delete-recompute");
        let folder_node = scan
            .root
            .children
            .iter()
            .find(|node| node.name == "folder")
            .unwrap();
        let folder_details =
            load_indexed_directory(&index_path, &scan.scan_id, &folder_node.id).unwrap();
        let one_node = folder_details
            .children
            .iter()
            .find(|node| node.name == "one.bin")
            .unwrap();

        let updated = apply_indexed_deletions(
            &index_path,
            &scan.scan_id,
            std::slice::from_ref(&one_node.id),
        )
        .unwrap();
        assert_eq!(updated.root.item_count, 1);
        assert_eq!(updated.root.allocated_size_bytes, expected_second);
    }

    #[test]
    fn the_latest_and_previous_detailed_indexes_are_kept_for_each_target() {
        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");

        scan_folder(fixture.path(), &index_path, "oldest");
        std::thread::sleep(Duration::from_millis(5));
        scan_folder(fixture.path(), &index_path, "previous");
        std::thread::sleep(Duration::from_millis(5));
        let latest = scan_folder(fixture.path(), &index_path, "latest");

        assert_eq!(latest.scan_id, "latest");
        assert!(load_indexed_scan(&index_path, "oldest").is_ok());
        assert!(load_indexed_scan(&index_path, "previous").is_ok());
        maintain_cleanup_index(&index_path).unwrap();
        assert!(load_indexed_scan(&index_path, "oldest").is_err());
        assert!(load_indexed_scan(&index_path, "previous").is_ok());
        assert!(load_indexed_scan(&index_path, "latest").is_ok());
        let summary = cleanup_index_summary(&index_path).unwrap();
        assert_eq!(summary.scan_count, 2);
    }

    #[test]
    fn broken_primary_generation_falls_back_to_previous_valid_generation() {
        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("item.bin"), vec![1_u8; 1_024]).unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");

        scan_folder(fixture.path(), &index_path, "valid-prev");
        std::thread::sleep(Duration::from_millis(5));
        scan_folder(fixture.path(), &index_path, "broken-latest");
        // Corrupt the primary file so only the archived previous generation is valid.
        fs::write(&index_path, b"not a sqlite database").unwrap();

        let restored = load_latest_indexed_scan(&index_path).unwrap().unwrap();
        assert_eq!(restored.scan_id, "valid-prev");
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
    fn abandoned_index_cleanup_is_deferred_without_blocking_new_scans() {
        let fixture = tempdir().unwrap();
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        scan_folder(fixture.path(), &index_path, "old-job");
        defer_discard_indexed_scan(&index_path, "old-job").unwrap();
        assert!(load_indexed_scan(&index_path, "old-job").is_ok());
        maintain_cleanup_index(&index_path).unwrap();
        assert!(load_indexed_scan(&index_path, "old-job").is_err());
    }

    #[test]
    fn sqlite_work_reports_activity_without_relying_on_a_heartbeat() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let connection = Connection::open_in_memory().unwrap();
        let reports = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&reports);
        attach_index_activity(
            &connection,
            Arc::new(move || {
                observed.fetch_add(1, Ordering::Relaxed);
            }),
        )
        .unwrap();
        let total: i64 = connection
            .query_row(
                "WITH RECURSIVE work(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM work WHERE n<10000)
                 SELECT SUM(n) FROM work",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 50_005_000);
        assert!(reports.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn indexed_child_queries_stay_below_the_interaction_budget() {
        let fixture = tempdir().unwrap();
        for index in 0..200 {
            fs::write(
                fixture.path().join(format!("item-{index:04}.bin")),
                vec![1_u8; 1_024],
            )
            .unwrap();
        }
        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "query-budget");
        let started = Instant::now();
        let page = load_indexed_children(
            &index_path,
            &CleanupIndexedChildrenRequest {
                scan_id: scan.scan_id,
                directory_id: scan.root.id,
                cursor: Some(0),
                limit: Some(50),
                query: None,
                sort_by: Some(CleanupIndexedSort::Size),
                descending: Some(true),
            },
        )
        .unwrap();
        assert!(!page.items.is_empty());
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    #[test]
    fn deep_micro_directories_fold_without_losing_bytes_or_large_subtrees() {
        let fixture = tempdir().unwrap();
        // Depth 1 -> 2 -> 3 -> 4 -> 5: tiny micro-dir (< 256 KiB, < 64 items)
        let tiny_deep = fixture.path().join("d1/d2/d3/tiny-d4/tiny-d5");
        fs::create_dir_all(&tiny_deep).unwrap();
        let tiny_file = tiny_deep.join("small.txt");
        fs::write(&tiny_file, vec![1_u8; 4_096]).unwrap();

        // Depth 1 -> 2 -> 3 -> 4: large deep dir (>= 256 KiB) must be kept!
        let large_deep = fixture.path().join("d1/d2/d3/large-d4");
        fs::create_dir_all(&large_deep).unwrap();
        let large_file = large_deep.join("big.bin");
        fs::write(&large_file, vec![2_u8; 320 * 1024]).unwrap();

        let expected_tiny = allocated_file_size(&tiny_file, &fs::metadata(&tiny_file).unwrap());
        let expected_large = allocated_file_size(&large_file, &fs::metadata(&large_file).unwrap());

        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");
        let scan = scan_folder(fixture.path(), &index_path, "fold-check");

        // Total bytes and item counts are 100% conserved.
        assert_eq!(scan.root.item_count, 2);
        assert_eq!(
            scan.root.allocated_size_bytes,
            expected_tiny + expected_large
        );

        let connection = open_index_read_only(&index_path).unwrap();
        let tiny_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND name IN ('tiny-d4', 'tiny-d5')",
                params![&scan.scan_id],
                |row| row.get(0),
            )
            .unwrap();
        let large_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE scan_id = ?1 AND name = 'large-d4'",
                params![&scan.scan_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tiny_rows, 0, "deep micro-directories should be folded");
        assert_eq!(large_rows, 1, "deep directories >= 256 KiB must remain");
    }

    #[cfg(unix)]
    #[test]
    fn rescan_reuses_unchanged_app_bundles_and_invalidates_on_change() {
        let fixture = tempdir().unwrap();
        let app_root = fixture.path().join("Fixture.app");
        let contents = app_root.join("Contents");
        let macos = contents.join("MacOS");
        let resources = contents.join("Resources");
        fs::create_dir_all(&macos).unwrap();
        fs::create_dir_all(&resources).unwrap();
        let info_plist = contents.join("Info.plist");
        fs::write(
            &info_plist,
            b"<plist><dict><key>CFBundleVersion</key><string>1</string></dict></plist>",
        )
        .unwrap();
        fs::write(macos.join("Fixture"), vec![1_u8; 64 * 1024]).unwrap();
        fs::write(resources.join("asset.bin"), vec![2_u8; 128 * 1024]).unwrap();

        let storage = tempdir().unwrap();
        let index_path = storage.path().join("cleanup.sqlite");

        let first = scan_folder(fixture.path(), &index_path, "first-scan");
        let canonical_root = fixture.path().canonicalize().unwrap();
        let reusable_before = load_reusable_subtrees(
            &index_path,
            CleanupScanProfile::Complete,
            CleanupScanTargetKind::Folder,
            &canonical_root,
            &canonical_root,
            &canonical_root.to_string_lossy(),
            &[],
            &[],
        );
        assert!(
            reusable_before.contains_key(&canonical_root.join("Fixture.app")),
            "unchanged .app bundle should be eligible for subtree reuse"
        );

        std::thread::sleep(Duration::from_millis(5));
        let second = scan_folder(fixture.path(), &index_path, "second-scan");
        assert_eq!(second.root.item_count, first.root.item_count);
        assert_eq!(
            second.root.logical_size_bytes,
            first.root.logical_size_bytes
        );
        assert_eq!(
            second.root.allocated_size_bytes,
            first.root.allocated_size_bytes
        );

        // Mutating Info.plist must immediately invalidate reuse and reflect the new size.
        std::thread::sleep(Duration::from_millis(10));
        fs::write(
            &info_plist,
            b"<plist><dict><key>CFBundleVersion</key><string>2-updated-version</string></dict></plist>",
        )
        .unwrap();
        fs::write(resources.join("extra.bin"), vec![3_u8; 32 * 1024]).unwrap();

        let reusable_after = load_reusable_subtrees(
            &index_path,
            CleanupScanProfile::Complete,
            CleanupScanTargetKind::Folder,
            &canonical_root,
            &canonical_root,
            &canonical_root.to_string_lossy(),
            &[],
            &[],
        );
        assert!(
            !reusable_after.contains_key(&canonical_root.join("Fixture.app")),
            "mutated .app bundle must not be reused"
        );

        let third = scan_folder(fixture.path(), &index_path, "third-scan");
        assert_eq!(third.root.item_count, first.root.item_count + 1);
        assert!(third.root.logical_size_bytes > first.root.logical_size_bytes);
    }
}
