use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
#[cfg(target_os = "macos")]
use std::time::UNIX_EPOCH;
use std::time::{Duration, Instant, SystemTime};

use sysinfo::{DiskKind, Disks};

use crate::error::CommandError;
use crate::models::{CleanupFile, CleanupProtectionReason, CleanupSafety, CleanupScanProgress};

use super::{
    FileIdentity, LARGE_FILE_THRESHOLD_BYTES, LocationDefinition, MAX_LARGE_FILES,
    MAX_UNREADABLE_PATHS, ScanFilesystemBoundary, allocated_file_size, can_inherit_file_protection,
    cleanup_node_name, cleanup_protection_for_scan_path_with_uid, display_path, ensure_scan_active,
    is_cloud_backed_cleanup_root, is_excluded_scan_namespace, matching_location_definition,
    system_time_millis,
};

pub(super) const VISIBLE_FILES_PER_DIRECTORY: usize = 64;
const PROGRESS_REPORT_INTERVAL: Duration = Duration::from_millis(500);
const PREVIEW_EMIT_INTERVAL: Duration = Duration::from_millis(1_500);
const SEEN_FILE_SHARDS: usize = 64;

#[derive(Clone, Debug, Default)]
pub(super) struct DirectoryTotals {
    pub(super) logical_size_bytes: u64,
    pub(super) allocated_size_bytes: u64,
    pub(super) item_count: usize,
    pub(super) direct_child_count: usize,
    pub(super) omitted_file_logical_bytes: u64,
    pub(super) omitted_file_allocated_bytes: u64,
    pub(super) omitted_file_count: usize,
    pub(super) omitted_directory_count: usize,
}

#[derive(Clone, Debug)]
pub(super) struct ScannedFile {
    pub(super) name: String,
    pub(super) logical_size_bytes: u64,
    pub(super) allocated_size_bytes: u64,
    pub(super) modified_at_ms: Option<u64>,
    pub(super) safety: CleanupSafety,
    pub(super) deletion_protected: bool,
    pub(super) protection_reason: Option<CleanupProtectionReason>,
    pub(super) device_id: Option<i64>,
    pub(super) inode: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ScannedDirKind {
    Folder,
    Restricted,
}

#[derive(Clone, Debug)]
pub(super) struct ScannedDir {
    pub(super) id: usize,
    pub(super) parent_id: Option<usize>,
    pub(super) name: String,
    pub(super) absolute_path: Option<String>,
    pub(super) display_path: Option<String>,
    pub(super) safety: CleanupSafety,
    pub(super) kind: ScannedDirKind,
    pub(super) deletion_protected: bool,
    pub(super) protection_reason: Option<CleanupProtectionReason>,
    pub(super) modified_at_ms: Option<u64>,
    pub(super) device_id: Option<i64>,
    pub(super) inode: Option<i64>,
    pub(super) totals: DirectoryTotals,
    pub(super) top_files: Vec<ScannedFile>,
}

/// A verified unchanged subtree loaded from the previous completed index.
///
/// Each entry in `dirs` holds only that directory's *own* contribution (direct
/// files + omitted counts) so the final O(N) bottom-up rollup in
/// `scan_tree_in_memory` produces exact totals across both reused and freshly
/// scanned subtrees without double-counting. `dirs[0]` is the subtree root and
/// all `parent_id` values are local indices into `dirs` (`parent < child`).
#[derive(Clone, Debug)]
#[cfg_attr(not(unix), allow(dead_code))]
pub(super) struct ReusedSubtree {
    pub(super) dirs: Vec<ScannedDir>,
    pub(super) largest_files: Vec<CleanupFile>,
    pub(super) total_logical_bytes: u64,
    pub(super) total_allocated_bytes: u64,
    pub(super) total_item_count: usize,
    pub(super) scanned_entry_count: usize,
}

#[derive(Clone, Debug)]
pub(super) struct PreviewChildSnapshot {
    pub(super) id: usize,
    pub(super) name: String,
    pub(super) display_path: String,
    pub(super) logical_size_bytes: u64,
    pub(super) allocated_size_bytes: u64,
    pub(super) item_count: usize,
    pub(super) safety: CleanupSafety,
    pub(super) protection_reason: Option<CleanupProtectionReason>,
}

#[derive(Clone, Debug)]
pub(super) struct PreviewSnapshot {
    pub(super) root_logical_size_bytes: u64,
    pub(super) root_allocated_size_bytes: u64,
    pub(super) root_item_count: usize,
    pub(super) scanned_entry_count: usize,
    pub(super) unreadable_entry_count: usize,
    pub(super) unreadable_paths: Vec<String>,
    pub(super) elapsed_ms: u64,
    pub(super) children: Vec<PreviewChildSnapshot>,
}

pub(super) struct ScannedTree {
    pub(super) dirs: Vec<ScannedDir>,
    pub(super) largest_files: Vec<CleanupFile>,
    pub(super) scanned_entry_count: usize,
    pub(super) unreadable_entry_count: usize,
    pub(super) unreadable_paths: Vec<String>,
    pub(super) elapsed_ms: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ScanRootItem {
    pub(super) path: PathBuf,
    pub(super) name_override: Option<String>,
    pub(super) safety: CleanupSafety,
    pub(super) protection_reason: Option<CleanupProtectionReason>,
    pub(super) skip_if_unreadable: bool,
}

pub(super) struct MemoryScanConfig<'a> {
    pub(super) scan_root: &'a Path,
    pub(super) home: &'a Path,
    pub(super) protection_root: &'a Path,
    pub(super) selected_cleanup_root: bool,
    pub(super) boundary: ScanFilesystemBoundary,
    pub(super) definitions: &'a [LocationDefinition],
    pub(super) excluded_paths: &'a [PathBuf],
    pub(super) synthetic_root_name: Option<&'a str>,
    pub(super) root_display_path: &'a str,
    pub(super) root_safety: CleanupSafety,
    pub(super) root_protection_reason: Option<CleanupProtectionReason>,
    /// When non-empty, the scan starts from these roots as direct children of
    /// the synthetic root (used by `CommonLocations` quick scan). When empty,
    /// `scan_root` itself is scanned as `dirs[0]`.
    pub(super) multi_roots: Vec<ScanRootItem>,
    pub(super) preserve_system_anchors: bool,
    pub(super) reusable_subtrees: HashMap<PathBuf, ReusedSubtree>,
}

struct PendingDir {
    dir_id: usize,
    parent_id: Option<usize>,
    path: PathBuf,
    name_override: Option<String>,
    safety: CleanupSafety,
    top_bucket: Option<usize>,
    modified_at_ms: Option<u64>,
    device_id: Option<i64>,
    inode: Option<i64>,
    skip_if_unreadable: bool,
    force_anchor: bool,
}

struct TopBucketAtomics {
    dir_id: usize,
    name: String,
    display_path: String,
    safety: CleanupSafety,
    protection_reason: Option<CleanupProtectionReason>,
    logical_bytes: AtomicU64,
    allocated_bytes: AtomicU64,
    item_count: AtomicU64,
}

struct WorkQueueState {
    global_stack: Vec<PendingDir>,
    done: bool,
}

struct SharedScanState<'a> {
    config: &'a MemoryScanConfig<'a>,
    definition_paths: HashSet<PathBuf>,
    cancelled: &'a AtomicBool,
    work: Mutex<WorkQueueState>,
    condvar: Condvar,
    idle_workers: AtomicUsize,
    active_tasks: AtomicUsize,
    next_dir_id: AtomicUsize,
    scanned_entries: AtomicUsize,
    discovered_bytes: AtomicU64,
    unreadable_entries: AtomicUsize,
    unreadable_paths: Mutex<Vec<String>>,
    latest_path: Mutex<String>,
    seen_files: Vec<Mutex<HashSet<FileIdentity>>>,
    top_buckets: Mutex<Vec<Arc<TopBucketAtomics>>>,
    root_direct_logical: AtomicU64,
    root_direct_allocated: AtomicU64,
    root_direct_items: AtomicU64,
    fatal_error: Mutex<Option<CommandError>>,
    started: Instant,
}

impl<'a> SharedScanState<'a> {
    fn new(config: &'a MemoryScanConfig<'a>, cancelled: &'a AtomicBool) -> Self {
        let mut definition_paths = HashSet::new();
        for def in config.definitions {
            for path in &def.paths {
                definition_paths.insert(path.clone());
            }
        }
        let mut seen_files = Vec::with_capacity(SEEN_FILE_SHARDS);
        for _ in 0..SEEN_FILE_SHARDS {
            seen_files.push(Mutex::new(HashSet::new()));
        }
        Self {
            config,
            definition_paths,
            cancelled,
            work: Mutex::new(WorkQueueState {
                global_stack: Vec::new(),
                done: false,
            }),
            condvar: Condvar::new(),
            idle_workers: AtomicUsize::new(0),
            active_tasks: AtomicUsize::new(0),
            next_dir_id: AtomicUsize::new(1),
            scanned_entries: AtomicUsize::new(0),
            discovered_bytes: AtomicU64::new(0),
            unreadable_entries: AtomicUsize::new(0),
            unreadable_paths: Mutex::new(Vec::new()),
            latest_path: Mutex::new(config.root_display_path.to_owned()),
            seen_files,
            top_buckets: Mutex::new(Vec::new()),
            root_direct_logical: AtomicU64::new(0),
            root_direct_allocated: AtomicU64::new(0),
            root_direct_items: AtomicU64::new(0),
            fatal_error: Mutex::new(None),
            started: Instant::now(),
        }
    }

    fn is_aborted(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
            || self
                .fatal_error
                .lock()
                .map(|slot| slot.is_some())
                .unwrap_or(true)
    }

    fn set_fatal_error(&self, error: CommandError) {
        if let Ok(mut slot) = self.fatal_error.lock()
            && slot.is_none()
        {
            *slot = Some(error);
        }
        if let Ok(mut queue) = self.work.lock() {
            queue.done = true;
            queue.global_stack.clear();
        }
        self.condvar.notify_all();
    }

    fn record_unreadable(&self, path: &Path) {
        self.unreadable_entries.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut list) = self.unreadable_paths.lock()
            && list.len() < MAX_UNREADABLE_PATHS
        {
            let formatted = display_path(path, self.config.home);
            if !list.contains(&formatted) {
                list.push(formatted);
            }
        }
    }

    fn update_latest_path(&self, path: &Path) {
        if let Ok(mut slot) = self.latest_path.try_lock() {
            *slot = display_path(path, self.config.home);
        }
    }

    fn mark_hardlink_seen(&self, identity: FileIdentity) -> bool {
        let shard = hardlink_shard(&identity);
        let Ok(mut set) = self.seen_files[shard].lock() else {
            return true;
        };
        set.insert(identity)
    }

    fn should_anchor(&self, path: &Path, force_anchor: bool) -> bool {
        if force_anchor || path == self.config.scan_root {
            return true;
        }
        if self.definition_paths.contains(path) {
            return true;
        }
        if self.config.preserve_system_anchors && !self.config.selected_cleanup_root {
            return path.parent() == Some(self.config.scan_root)
                || path == self.config.home
                || path.parent() == Some(self.config.home)
                || self.config.home.starts_with(path);
        }
        false
    }

    fn build_progress(&self) -> CleanupScanProgress {
        let current_path = self
            .latest_path
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| self.config.root_display_path.to_owned());
        CleanupScanProgress {
            scanned_entry_count: self.scanned_entries.load(Ordering::Relaxed),
            discovered_bytes: self.discovered_bytes.load(Ordering::Relaxed),
            current_path,
            elapsed_ms: self.elapsed_ms(),
        }
    }

    fn build_preview(&self) -> PreviewSnapshot {
        let buckets = self
            .top_buckets
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let mut root_logical = self.root_direct_logical.load(Ordering::Relaxed);
        let mut root_allocated = self.root_direct_allocated.load(Ordering::Relaxed);
        let mut root_items = self.root_direct_items.load(Ordering::Relaxed) as usize;
        let mut children = Vec::with_capacity(buckets.len());
        for bucket in &buckets {
            let logical = bucket.logical_bytes.load(Ordering::Relaxed);
            let allocated = bucket.allocated_bytes.load(Ordering::Relaxed);
            let items = bucket.item_count.load(Ordering::Relaxed) as usize;
            root_logical = root_logical.saturating_add(logical);
            root_allocated = root_allocated.saturating_add(allocated);
            root_items = root_items.saturating_add(items);
            children.push(PreviewChildSnapshot {
                id: bucket.dir_id,
                name: bucket.name.clone(),
                display_path: bucket.display_path.clone(),
                logical_size_bytes: logical,
                allocated_size_bytes: allocated,
                item_count: items,
                safety: bucket.safety,
                protection_reason: bucket.protection_reason,
            });
        }
        children.sort_by(|left, right| {
            right
                .allocated_size_bytes
                .cmp(&left.allocated_size_bytes)
                .then_with(|| left.name.cmp(&right.name))
        });
        let unreadable_paths = self
            .unreadable_paths
            .lock()
            .map(|list| list.clone())
            .unwrap_or_default();
        PreviewSnapshot {
            root_logical_size_bytes: root_logical,
            root_allocated_size_bytes: root_allocated,
            root_item_count: root_items,
            scanned_entry_count: self.scanned_entries.load(Ordering::Relaxed),
            unreadable_entry_count: self.unreadable_entries.load(Ordering::Relaxed),
            unreadable_paths,
            elapsed_ms: self.elapsed_ms(),
            children,
        }
    }

    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }
}

pub(super) fn scan_parallelism(scan_root: &Path) -> usize {
    let disks = Disks::new_with_refreshed_list();
    let is_internal_ssd = disks
        .list()
        .iter()
        .filter(|disk| scan_root.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .is_some_and(|disk| !disk.is_removable() && disk.kind() == DiskKind::SSD);
    if !is_internal_ssd {
        return 1;
    }
    thread::available_parallelism()
        .map(|count| count.get().saturating_mul(2).clamp(6, 12))
        .unwrap_or(8)
}

pub(super) fn scan_tree_in_memory(
    config: &MemoryScanConfig<'_>,
    cancelled: &AtomicBool,
    on_progress: &mut dyn FnMut(CleanupScanProgress),
    on_preview: &mut dyn FnMut(&PreviewSnapshot),
) -> Result<ScannedTree, CommandError> {
    ensure_scan_active(cancelled)?;
    let shared = Arc::new(SharedScanState::new(config, cancelled));
    let parallelism = scan_parallelism(config.scan_root);

    let mut initial_dirs = Vec::<ScannedDir>::new();
    let mut initial_tasks = Vec::<PendingDir>::new();

    if config.multi_roots.is_empty() {
        let root_meta = fs::symlink_metadata(config.scan_root).map_err(|error| {
            CommandError::new(
                "cleanup_scan_root_unavailable",
                format!("CoreRobin could not read the selected scan root: {error}"),
            )
        })?;
        if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
            return Err(CommandError::new(
                "cleanup_scan_root_unavailable",
                "The selected scan root is not a readable directory.",
            ));
        }
        initial_tasks.push(PendingDir {
            dir_id: 0,
            parent_id: None,
            path: config.scan_root.to_path_buf(),
            name_override: config.synthetic_root_name.map(str::to_owned),
            safety: config.root_safety,
            top_bucket: None,
            modified_at_ms: root_meta.modified().ok().and_then(system_time_millis),
            device_id: metadata_device_id(&root_meta),
            inode: metadata_inode(&root_meta),
            skip_if_unreadable: false,
            force_anchor: true,
        });
    } else {
        // Synthetic root for CommonLocations quick scan.
        initial_dirs.push(ScannedDir {
            id: 0,
            parent_id: None,
            name: config
                .synthetic_root_name
                .unwrap_or("Common locations")
                .to_owned(),
            absolute_path: Some(config.scan_root.to_string_lossy().into_owned()),
            display_path: Some(config.root_display_path.to_owned()),
            safety: config.root_safety,
            kind: ScannedDirKind::Folder,
            deletion_protected: config.root_protection_reason.is_some(),
            protection_reason: config.root_protection_reason,
            modified_at_ms: None,
            device_id: None,
            inode: None,
            totals: DirectoryTotals::default(),
            top_files: Vec::new(),
        });
        let mut buckets = Vec::with_capacity(config.multi_roots.len());
        for root_item in &config.multi_roots {
            if path_is_excluded(&root_item.path, config.excluded_paths) {
                shared.record_unreadable(&root_item.path);
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&root_item.path) else {
                if root_item.skip_if_unreadable {
                    shared.record_unreadable(&root_item.path);
                    continue;
                }
                return Err(CommandError::new(
                    "cleanup_scan_root_unavailable",
                    format!(
                        "CoreRobin could not read the scan root {}.",
                        root_item.path.display()
                    ),
                ));
            };
            if !meta.is_dir()
                || meta.file_type().is_symlink()
                || !config.boundary.allows_directory(&meta)
            {
                if root_item.skip_if_unreadable {
                    shared.record_unreadable(&root_item.path);
                    continue;
                }
                continue;
            }
            let dir_id = shared.next_dir_id.fetch_add(1, Ordering::Relaxed);
            let bucket_idx = buckets.len();
            let node_name = root_item
                .name_override
                .clone()
                .unwrap_or_else(|| cleanup_node_name(&root_item.path));
            buckets.push(Arc::new(TopBucketAtomics {
                dir_id,
                name: node_name.clone(),
                display_path: display_path(&root_item.path, config.home),
                safety: root_item.safety,
                protection_reason: root_item.protection_reason,
                logical_bytes: AtomicU64::new(0),
                allocated_bytes: AtomicU64::new(0),
                item_count: AtomicU64::new(0),
            }));
            initial_tasks.push(PendingDir {
                dir_id,
                parent_id: Some(0),
                path: root_item.path.clone(),
                name_override: Some(node_name),
                safety: root_item.safety,
                top_bucket: Some(bucket_idx),
                modified_at_ms: meta.modified().ok().and_then(system_time_millis),
                device_id: metadata_device_id(&meta),
                inode: metadata_inode(&meta),
                skip_if_unreadable: root_item.skip_if_unreadable,
                force_anchor: true,
            });
        }
        if let Ok(mut guard) = shared.top_buckets.lock() {
            *guard = buckets;
        }
    }

    let initial_count = initial_tasks.len();
    if initial_count == 0 {
        return Ok(ScannedTree {
            dirs: initial_dirs,
            largest_files: Vec::new(),
            scanned_entry_count: 0,
            unreadable_entry_count: shared.unreadable_entries.load(Ordering::Relaxed),
            unreadable_paths: shared
                .unreadable_paths
                .lock()
                .map(|list| list.clone())
                .unwrap_or_default(),
            elapsed_ms: shared.elapsed_ms(),
        });
    }

    shared.active_tasks.store(initial_count, Ordering::Release);
    {
        let mut queue = shared.work.lock().expect("work queue lock");
        // Reverse so LIFO pop visits earlier roots first.
        initial_tasks.reverse();
        queue.global_stack = initial_tasks;
    }

    let worker_count = parallelism.max(1);
    let mut worker_outputs: Vec<(Vec<ScannedDir>, Vec<CleanupFile>)> =
        Vec::with_capacity(worker_count);

    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let shared = Arc::clone(&shared);
            handles.push(scope.spawn(move || run_worker_loop(&shared)));
        }

        // Coordinator loop on the calling thread: reports progress and emits
        // lightweight in-memory preview snapshots without touching SQLite.
        let mut last_progress_at = Instant::now() - PROGRESS_REPORT_INTERVAL;
        let mut last_preview_at = Instant::now();
        let mut last_preview_entries = 0usize;
        let mut emitted_preview = false;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                if let Ok(mut queue) = shared.work.lock() {
                    queue.done = true;
                }
                shared.condvar.notify_all();
                break;
            }
            let finished = shared.work.lock().map(|queue| queue.done).unwrap_or(true);
            if last_progress_at.elapsed() >= PROGRESS_REPORT_INTERVAL || finished {
                on_progress(shared.build_progress());
                last_progress_at = Instant::now();
            }
            let current_entries = shared.scanned_entries.load(Ordering::Relaxed);
            if (last_preview_at.elapsed() >= PREVIEW_EMIT_INTERVAL
                && current_entries != last_preview_entries)
                || (finished && !emitted_preview)
            {
                let preview = shared.build_preview();
                on_preview(&preview);
                last_preview_at = Instant::now();
                last_preview_entries = current_entries;
                emitted_preview = true;
            }
            if finished {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        for handle in handles {
            if let Ok(output) = handle.join() {
                worker_outputs.push(output);
            }
        }
    });

    ensure_scan_active(cancelled)?;
    if let Ok(mut fatal) = shared.fatal_error.lock()
        && let Some(error) = fatal.take()
    {
        return Err(error);
    }

    // Merge worker-local directories into a dense topology-ordered Vec where
    // every child has id > parent_id.
    let total_slots = shared.next_dir_id.load(Ordering::Acquire);
    let mut slots: Vec<Option<ScannedDir>> = Vec::with_capacity(total_slots);
    slots.resize_with(total_slots, || None);
    for dir in initial_dirs {
        let id = dir.id;
        if id < slots.len() {
            slots[id] = Some(dir);
        }
    }
    let mut largest_files = Vec::<CleanupFile>::new();
    for (dirs, local_largest) in worker_outputs {
        for dir in dirs {
            let id = dir.id;
            if id < slots.len() {
                slots[id] = Some(dir);
            }
        }
        largest_files.extend(local_largest);
    }

    // Compact any skipped/unreadable multi-root gaps and remap parent IDs in
    // one O(N) pass. Every remaining node still satisfies child_idx > parent_idx.
    let mut remap = vec![usize::MAX; slots.len()];
    let mut dense_dirs = Vec::<ScannedDir>::with_capacity(slots.len());
    for (old_id, slot) in slots.into_iter().enumerate() {
        if let Some(mut dir) = slot {
            let new_id = dense_dirs.len();
            remap[old_id] = new_id;
            dir.id = new_id;
            dir.parent_id = dir.parent_id.and_then(|parent| {
                let mapped = remap[parent];
                (mapped != usize::MAX).then_some(mapped)
            });
            dense_dirs.push(dir);
        }
    }

    // Single O(N) bottom-up rollup: because parent_id < id for every directory,
    // iterating in reverse computes exact subtree totals in a few milliseconds.
    for idx in (1..dense_dirs.len()).rev() {
        let parent_id = dense_dirs[idx].parent_id;
        let child_logical = dense_dirs[idx].totals.logical_size_bytes;
        let child_allocated = dense_dirs[idx].totals.allocated_size_bytes;
        let child_items = dense_dirs[idx].totals.item_count;
        if let Some(parent_idx) = parent_id {
            let parent = &mut dense_dirs[parent_idx];
            parent.totals.logical_size_bytes = parent
                .totals
                .logical_size_bytes
                .saturating_add(child_logical);
            parent.totals.allocated_size_bytes = parent
                .totals
                .allocated_size_bytes
                .saturating_add(child_allocated);
            parent.totals.item_count = parent.totals.item_count.saturating_add(child_items);
            parent.totals.direct_child_count = parent.totals.direct_child_count.saturating_add(1);
        }
    }

    largest_files.sort_by(|left, right| {
        right
            .size_bytes
            .cmp(&left.size_bytes)
            .then_with(|| left.path.cmp(&right.path))
    });
    largest_files.dedup_by(|left, right| left.path == right.path);
    largest_files.truncate(MAX_LARGE_FILES);

    let unreadable_paths = shared
        .unreadable_paths
        .lock()
        .map(|list| list.clone())
        .unwrap_or_default();

    let final_progress = shared.build_progress();
    on_progress(final_progress);

    Ok(ScannedTree {
        dirs: dense_dirs,
        largest_files,
        scanned_entry_count: shared.scanned_entries.load(Ordering::Relaxed),
        unreadable_entry_count: shared.unreadable_entries.load(Ordering::Relaxed),
        unreadable_paths,
        elapsed_ms: shared.elapsed_ms(),
    })
}

fn run_worker_loop(shared: &SharedScanState<'_>) -> (Vec<ScannedDir>, Vec<CleanupFile>) {
    let mut local_stack = Vec::<PendingDir>::with_capacity(64);
    let mut local_dirs = Vec::<ScannedDir>::with_capacity(1024);
    let mut local_largest = Vec::<CleanupFile>::with_capacity(MAX_LARGE_FILES * 2);
    #[cfg(target_os = "macos")]
    let mut bulk_buffer = vec![0u8; 128 * 1024];

    loop {
        if shared.is_aborted() {
            break;
        }
        let task = if let Some(task) = local_stack.pop() {
            // Share upper-level work whenever peer workers are idle.
            if local_stack.len() > 1 && shared.idle_workers.load(Ordering::Relaxed) > 0 {
                let split_count = (local_stack.len() / 2).max(1);
                if let Ok(mut queue) = shared.work.try_lock() {
                    let stolen: Vec<_> = local_stack.drain(..split_count).collect();
                    queue.global_stack.extend(stolen);
                    shared.condvar.notify_all();
                }
            }
            task
        } else {
            match pop_global_task(shared) {
                Some(task) => task,
                None => break,
            }
        };

        let child_tasks = scan_single_directory(
            shared,
            task,
            &mut local_dirs,
            &mut local_largest,
            #[cfg(target_os = "macos")]
            &mut bulk_buffer,
        );

        let spawned = child_tasks.len();
        if spawned > 0 {
            // Increment active_tasks BEFORE releasing children and BEFORE
            // decrementing for the completed parent, so active_tasks never
            // prematurely hits 0.
            shared.active_tasks.fetch_add(spawned, Ordering::AcqRel);
            if shared.idle_workers.load(Ordering::Relaxed) > 0 && spawned > 1 {
                // Hand half of the children to idle peers immediately.
                let share_count = spawned / 2;
                let mut iter = child_tasks.into_iter().rev();
                let mut to_share = Vec::with_capacity(share_count);
                for _ in 0..share_count {
                    if let Some(item) = iter.next() {
                        to_share.push(item);
                    }
                }
                local_stack.extend(iter);
                if let Ok(mut queue) = shared.work.lock() {
                    queue.global_stack.extend(to_share);
                }
                shared.condvar.notify_all();
            } else {
                // Push in reverse so LIFO pop visits higher-priority dirs first.
                local_stack.extend(child_tasks.into_iter().rev());
            }
        }

        if shared.active_tasks.fetch_sub(1, Ordering::AcqRel) == 1 {
            if let Ok(mut queue) = shared.work.lock() {
                queue.done = true;
            }
            shared.condvar.notify_all();
        }
    }

    (local_dirs, local_largest)
}

fn pop_global_task(shared: &SharedScanState<'_>) -> Option<PendingDir> {
    let mut queue = shared.work.lock().ok()?;
    loop {
        if shared.is_aborted() {
            return None;
        }
        if let Some(task) = queue.global_stack.pop() {
            return Some(task);
        }
        if queue.done {
            return None;
        }
        shared.idle_workers.fetch_add(1, Ordering::AcqRel);
        let (next_queue, _) = shared
            .condvar
            .wait_timeout(queue, Duration::from_millis(100))
            .ok()?;
        shared.idle_workers.fetch_sub(1, Ordering::AcqRel);
        queue = next_queue;
    }
}

struct ChildDirCandidate {
    path: PathBuf,
    name: String,
    modified_at_ms: Option<u64>,
    device_id: Option<i64>,
    inode: Option<i64>,
}

fn scan_single_directory(
    shared: &SharedScanState<'_>,
    task: PendingDir,
    local_dirs: &mut Vec<ScannedDir>,
    local_largest: &mut Vec<CleanupFile>,
    #[cfg(target_os = "macos")] bulk_buffer: &mut Vec<u8>,
) -> Vec<PendingDir> {
    let config = shared.config;
    if path_is_excluded(&task.path, config.excluded_paths) {
        shared.record_unreadable(&task.path);
        return Vec::new();
    }
    if task.dir_id != 0
        && (is_excluded_scan_namespace(&task.path, config.scan_root)
            || is_cloud_backed_cleanup_root(&task.path, config.home))
    {
        return Vec::new();
    }

    shared.update_latest_path(&task.path);

    let dir_safety = matching_location_definition(config.definitions, &task.path)
        .map_or(task.safety, |(_, def)| def.safety);
    let dir_protection = cleanup_protection_for_scan_path_with_uid(
        &task.path,
        config.home,
        config.protection_root,
        config.selected_cleanup_root,
        None,
    );
    let path_anchor = shared.should_anchor(&task.path, task.force_anchor);
    let node_name = task
        .name_override
        .unwrap_or_else(|| cleanup_node_name(&task.path));

    let mut totals = DirectoryTotals::default();
    let mut top_files = Vec::<ScannedFile>::new();
    let mut min_kept_size = 0_u64;
    let mut child_candidates = Vec::<ChildDirCandidate>::new();
    let mut local_entries = 0_usize;
    let mut local_discovered = 0_u64;

    let inherit_file_protection = can_inherit_file_protection(
        &task.path,
        config.home,
        config.selected_cleanup_root,
        dir_protection,
    );

    let read_outcome = enumerate_directory(
        shared,
        &task.path,
        dir_safety,
        dir_protection,
        inherit_file_protection,
        &mut totals,
        &mut top_files,
        &mut min_kept_size,
        &mut child_candidates,
        local_largest,
        &mut local_entries,
        &mut local_discovered,
        #[cfg(target_os = "macos")]
        bulk_buffer,
    );

    if local_entries > 0 {
        shared
            .scanned_entries
            .fetch_add(local_entries, Ordering::Relaxed);
    }
    if local_discovered > 0 {
        shared
            .discovered_bytes
            .fetch_add(local_discovered, Ordering::Relaxed);
    }

    match read_outcome {
        Ok(()) => {}
        Err(DirReadError::Cancelled) => return Vec::new(),
        Err(DirReadError::Unreadable) => {
            shared.record_unreadable(&task.path);
            if task.dir_id == 0 && !task.skip_if_unreadable {
                shared.set_fatal_error(CommandError::new(
                    "cleanup_scan_root_unavailable",
                    format!(
                        "CoreRobin could not read the selected scan root {}.",
                        task.path.display()
                    ),
                ));
                return Vec::new();
            }
            if task.skip_if_unreadable {
                return Vec::new();
            }
            local_dirs.push(ScannedDir {
                id: task.dir_id,
                parent_id: task.parent_id,
                name: node_name,
                absolute_path: path_anchor.then(|| task.path.to_string_lossy().into_owned()),
                display_path: path_anchor.then(|| display_path(&task.path, config.home)),
                safety: dir_safety,
                kind: ScannedDirKind::Restricted,
                deletion_protected: true,
                protection_reason: Some(CleanupProtectionReason::Restricted),
                modified_at_ms: task.modified_at_ms,
                device_id: task.device_id,
                inode: task.inode,
                totals: DirectoryTotals::default(),
                top_files: Vec::new(),
            });
            return Vec::new();
        }
    }

    // Update lock-free top-level bucket progress counters.
    if totals.item_count > 0 {
        if let Some(bucket_idx) = task.top_bucket {
            if let Ok(buckets) = shared.top_buckets.lock()
                && let Some(bucket) = buckets.get(bucket_idx)
            {
                bucket
                    .logical_bytes
                    .fetch_add(totals.logical_size_bytes, Ordering::Relaxed);
                bucket
                    .allocated_bytes
                    .fetch_add(totals.allocated_size_bytes, Ordering::Relaxed);
                bucket
                    .item_count
                    .fetch_add(totals.item_count as u64, Ordering::Relaxed);
            }
        } else if task.dir_id == 0 {
            shared
                .root_direct_logical
                .fetch_add(totals.logical_size_bytes, Ordering::Relaxed);
            shared
                .root_direct_allocated
                .fetch_add(totals.allocated_size_bytes, Ordering::Relaxed);
            shared
                .root_direct_items
                .fetch_add(totals.item_count as u64, Ordering::Relaxed);
        }
    }

    top_files.sort_by(|left, right| {
        right
            .allocated_size_bytes
            .cmp(&left.allocated_size_bytes)
            .then_with(|| left.name.cmp(&right.name))
    });

    local_dirs.push(ScannedDir {
        id: task.dir_id,
        parent_id: task.parent_id,
        name: node_name,
        absolute_path: path_anchor.then(|| task.path.to_string_lossy().into_owned()),
        display_path: path_anchor.then(|| display_path(&task.path, config.home)),
        safety: dir_safety,
        kind: ScannedDirKind::Folder,
        deletion_protected: dir_protection.is_some(),
        protection_reason: dir_protection,
        modified_at_ms: task.modified_at_ms,
        device_id: task.device_id,
        inode: task.inode,
        totals,
        top_files,
    });

    if child_candidates.is_empty() {
        return Vec::new();
    }

    // Sort top-level directories by priority for better preview ordering.
    if task.dir_id == 0 || task.parent_id == Some(0) {
        child_candidates.sort_by(|left, right| {
            directory_scan_priority(&left.path, config.home)
                .cmp(&directory_scan_priority(&right.path, config.home))
                .then_with(|| left.path.cmp(&right.path))
        });
    }

    // If this is the single-root scan's root (dir_id == 0), register each
    // direct child directory as a preview bucket so progressive preview shows
    // top-level folders growing live.
    let register_buckets = task.dir_id == 0 && config.multi_roots.is_empty();
    let mut new_buckets = if register_buckets {
        Vec::with_capacity(child_candidates.len())
    } else {
        Vec::new()
    };

    let mut pending_children = Vec::with_capacity(child_candidates.len());
    for child in child_candidates {
        if let Some(reused) = config.reusable_subtrees.get(&child.path)
            && !reused.dirs.is_empty()
        {
            let subtree_base = shared
                .next_dir_id
                .fetch_add(reused.dirs.len(), Ordering::Relaxed);
            for (local_idx, dir) in reused.dirs.iter().enumerate() {
                let mut cloned = dir.clone();
                cloned.id = subtree_base + local_idx;
                cloned.parent_id = if local_idx == 0 {
                    Some(task.dir_id)
                } else {
                    dir.parent_id.map(|parent| subtree_base + parent)
                };
                local_dirs.push(cloned);
            }
            if !reused.largest_files.is_empty() {
                local_largest.extend(reused.largest_files.iter().cloned());
            }
            shared
                .scanned_entries
                .fetch_add(reused.scanned_entry_count, Ordering::Relaxed);
            shared
                .discovered_bytes
                .fetch_add(reused.total_allocated_bytes, Ordering::Relaxed);
            if register_buckets {
                let root_dir = &reused.dirs[0];
                new_buckets.push(Arc::new(TopBucketAtomics {
                    dir_id: subtree_base,
                    name: root_dir.name.clone(),
                    display_path: root_dir
                        .display_path
                        .clone()
                        .unwrap_or_else(|| display_path(&child.path, config.home)),
                    safety: root_dir.safety,
                    protection_reason: root_dir.protection_reason,
                    logical_bytes: AtomicU64::new(reused.total_logical_bytes),
                    allocated_bytes: AtomicU64::new(reused.total_allocated_bytes),
                    item_count: AtomicU64::new(reused.total_item_count as u64),
                }));
            } else if let Some(bucket_idx) = task.top_bucket
                && let Ok(buckets) = shared.top_buckets.lock()
                && let Some(bucket) = buckets.get(bucket_idx)
            {
                bucket
                    .logical_bytes
                    .fetch_add(reused.total_logical_bytes, Ordering::Relaxed);
                bucket
                    .allocated_bytes
                    .fetch_add(reused.total_allocated_bytes, Ordering::Relaxed);
                bucket
                    .item_count
                    .fetch_add(reused.total_item_count as u64, Ordering::Relaxed);
            }
            continue;
        }

        let child_id = shared.next_dir_id.fetch_add(1, Ordering::Relaxed);
        let child_bucket = if register_buckets {
            let child_safety = matching_location_definition(config.definitions, &child.path)
                .map_or(dir_safety, |(_, def)| def.safety);
            let child_protection = cleanup_protection_for_scan_path_with_uid(
                &child.path,
                config.home,
                config.protection_root,
                config.selected_cleanup_root,
                None,
            );
            let bucket_idx = new_buckets.len();
            new_buckets.push(Arc::new(TopBucketAtomics {
                dir_id: child_id,
                name: child.name,
                display_path: display_path(&child.path, config.home),
                safety: child_safety,
                protection_reason: child_protection,
                logical_bytes: AtomicU64::new(0),
                allocated_bytes: AtomicU64::new(0),
                item_count: AtomicU64::new(0),
            }));
            Some(bucket_idx)
        } else {
            task.top_bucket
        };
        pending_children.push(PendingDir {
            dir_id: child_id,
            parent_id: Some(task.dir_id),
            path: child.path,
            name_override: None,
            safety: dir_safety,
            top_bucket: child_bucket,
            modified_at_ms: child.modified_at_ms,
            device_id: child.device_id,
            inode: child.inode,
            skip_if_unreadable: false,
            force_anchor: false,
        });
    }

    if register_buckets
        && !new_buckets.is_empty()
        && let Ok(mut guard) = shared.top_buckets.lock()
    {
        *guard = new_buckets;
    }

    pending_children
}

enum DirReadError {
    Cancelled,
    Unreadable,
}

#[allow(clippy::too_many_arguments)]
fn enumerate_directory(
    shared: &SharedScanState<'_>,
    directory: &Path,
    dir_safety: CleanupSafety,
    dir_protection: Option<CleanupProtectionReason>,
    inherit_file_protection: bool,
    totals: &mut DirectoryTotals,
    top_files: &mut Vec<ScannedFile>,
    min_kept_size: &mut u64,
    child_candidates: &mut Vec<ChildDirCandidate>,
    local_largest: &mut Vec<CleanupFile>,
    local_entries: &mut usize,
    local_discovered: &mut u64,
    #[cfg(target_os = "macos")] bulk_buffer: &mut Vec<u8>,
) -> Result<(), DirReadError> {
    #[cfg(target_os = "macos")]
    {
        match enumerate_directory_macos_bulk(
            shared,
            directory,
            dir_safety,
            dir_protection,
            inherit_file_protection,
            totals,
            top_files,
            min_kept_size,
            child_candidates,
            local_largest,
            local_entries,
            local_discovered,
            bulk_buffer,
        ) {
            Ok(()) => return Ok(()),
            Err(BulkReadError::Cancelled) => return Err(DirReadError::Cancelled),
            Err(BulkReadError::Unreadable) => return Err(DirReadError::Unreadable),
            Err(BulkReadError::Fallback) => {
                // Reset any partial state only if fallback happened before
                // processing entries (open/first call ENOTSUP).
            }
        }
    }

    enumerate_directory_std(
        shared,
        directory,
        dir_safety,
        dir_protection,
        inherit_file_protection,
        totals,
        top_files,
        min_kept_size,
        child_candidates,
        local_largest,
        local_entries,
        local_discovered,
    )
}

#[allow(clippy::too_many_arguments)]
fn enumerate_directory_std(
    shared: &SharedScanState<'_>,
    directory: &Path,
    dir_safety: CleanupSafety,
    dir_protection: Option<CleanupProtectionReason>,
    inherit_file_protection: bool,
    totals: &mut DirectoryTotals,
    top_files: &mut Vec<ScannedFile>,
    min_kept_size: &mut u64,
    child_candidates: &mut Vec<ChildDirCandidate>,
    local_largest: &mut Vec<CleanupFile>,
    local_entries: &mut usize,
    local_discovered: &mut u64,
) -> Result<(), DirReadError> {
    let config = shared.config;
    let entries = fs::read_dir(directory).map_err(|_| DirReadError::Unreadable)?;
    let mut batch_count = 0usize;
    for entry in entries {
        batch_count += 1;
        if batch_count.is_multiple_of(1024) {
            if shared.is_aborted() {
                return Err(DirReadError::Cancelled);
            }
            shared.scanned_entries.fetch_add(1024, Ordering::Relaxed);
            *local_entries = local_entries.saturating_sub(1024);
        }
        *local_entries += 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                shared.record_unreadable(directory);
                continue;
            }
        };
        let path = entry.path();
        if path_is_excluded(&path, config.excluded_paths) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                shared.record_unreadable(&path);
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
                    shared.record_unreadable(&path);
                    continue;
                }
            };
            if !config.boundary.allows_directory(&metadata)
                || is_excluded_scan_namespace(&path, config.scan_root)
                || is_cloud_backed_cleanup_root(&path, config.home)
            {
                continue;
            }
            child_candidates.push(ChildDirCandidate {
                name: entry.file_name().to_string_lossy().into_owned(),
                path,
                modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
                device_id: metadata_device_id(&metadata),
                inode: metadata_inode(&metadata),
            });
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                shared.record_unreadable(&path);
                continue;
            }
        };
        if let Some(identity) = super::file_identity(&path, &metadata)
            && !shared.mark_hardlink_seen(identity)
        {
            continue;
        }
        let logical = metadata.len();
        let allocated = allocated_file_size(&path, &metadata);
        #[cfg(unix)]
        let owner_uid = Some(std::os::unix::fs::MetadataExt::uid(&metadata));
        #[cfg(not(unix))]
        let owner_uid = None;
        record_regular_file(
            shared,
            &path,
            &entry.file_name().to_string_lossy(),
            logical,
            allocated,
            metadata.modified().ok().and_then(system_time_millis),
            metadata_device_id(&metadata),
            metadata_inode(&metadata),
            owner_uid,
            dir_safety,
            dir_protection,
            inherit_file_protection,
            totals,
            top_files,
            min_kept_size,
            local_largest,
            local_discovered,
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_regular_file(
    shared: &SharedScanState<'_>,
    path: &Path,
    name_str: &str,
    logical: u64,
    allocated: u64,
    modified_at_ms: Option<u64>,
    device_id: Option<i64>,
    inode: Option<i64>,
    owner_uid: Option<u32>,
    dir_safety: CleanupSafety,
    dir_protection: Option<CleanupProtectionReason>,
    inherit_file_protection: bool,
    totals: &mut DirectoryTotals,
    top_files: &mut Vec<ScannedFile>,
    min_kept_size: &mut u64,
    local_largest: &mut Vec<CleanupFile>,
    local_discovered: &mut u64,
) {
    record_regular_file_opt_path(
        shared,
        Some(path),
        name_str,
        logical,
        allocated,
        modified_at_ms,
        device_id,
        inode,
        owner_uid,
        dir_safety,
        dir_protection,
        inherit_file_protection,
        totals,
        top_files,
        min_kept_size,
        local_largest,
        local_discovered,
    );
}

#[allow(clippy::too_many_arguments)]
fn record_regular_file_opt_path(
    shared: &SharedScanState<'_>,
    path: Option<&Path>,
    name_str: &str,
    logical: u64,
    allocated: u64,
    modified_at_ms: Option<u64>,
    device_id: Option<i64>,
    inode: Option<i64>,
    owner_uid: Option<u32>,
    dir_safety: CleanupSafety,
    dir_protection: Option<CleanupProtectionReason>,
    inherit_file_protection: bool,
    totals: &mut DirectoryTotals,
    top_files: &mut Vec<ScannedFile>,
    min_kept_size: &mut u64,
    local_largest: &mut Vec<CleanupFile>,
    local_discovered: &mut u64,
) {
    *local_discovered = local_discovered.saturating_add(allocated);
    totals.logical_size_bytes = totals.logical_size_bytes.saturating_add(logical);
    totals.allocated_size_bytes = totals.allocated_size_bytes.saturating_add(allocated);
    totals.item_count = totals.item_count.saturating_add(1);
    totals.direct_child_count = totals.direct_child_count.saturating_add(1);

    if allocated >= LARGE_FILE_THRESHOLD_BYTES
        && let Some(full_path) = path
    {
        local_largest.push(CleanupFile {
            name: name_str.to_owned(),
            path: full_path.to_string_lossy().into_owned(),
            size_bytes: allocated,
            modified_at_ms,
        });
        if local_largest.len() >= MAX_LARGE_FILES * 2 {
            local_largest.sort_by_key(|file| Reverse(file.size_bytes));
            local_largest.truncate(MAX_LARGE_FILES);
        }
    }

    // Fast reject: if we already have 64 kept files and this file isn't larger
    // than the smallest kept file, avoid String allocation and protection checks.
    if top_files.len() >= VISIBLE_FILES_PER_DIRECTORY && allocated <= *min_kept_size {
        totals.omitted_file_logical_bytes =
            totals.omitted_file_logical_bytes.saturating_add(logical);
        totals.omitted_file_allocated_bytes = totals
            .omitted_file_allocated_bytes
            .saturating_add(allocated);
        totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
        return;
    }

    let protection_reason = if inherit_file_protection && !is_photos_library_name(name_str) {
        dir_protection
    } else if let Some(full_path) = path {
        cleanup_protection_for_scan_path_with_uid(
            full_path,
            shared.config.home,
            shared.config.protection_root,
            shared.config.selected_cleanup_root,
            owner_uid,
        )
    } else {
        dir_protection
    };

    let candidate = ScannedFile {
        name: name_str.to_owned(),
        logical_size_bytes: logical,
        allocated_size_bytes: allocated,
        modified_at_ms,
        safety: dir_safety,
        deletion_protected: protection_reason.is_some(),
        protection_reason,
        device_id,
        inode,
    };

    if top_files.len() < VISIBLE_FILES_PER_DIRECTORY {
        top_files.push(candidate);
        if top_files.len() == VISIBLE_FILES_PER_DIRECTORY {
            *min_kept_size = top_files
                .iter()
                .map(|file| file.allocated_size_bytes)
                .min()
                .unwrap_or(0);
        }
        return;
    }

    if let Some((smallest_index, _)) = top_files
        .iter()
        .enumerate()
        .min_by_key(|(_, file)| file.allocated_size_bytes)
        && candidate.allocated_size_bytes > top_files[smallest_index].allocated_size_bytes
    {
        let omitted = std::mem::replace(&mut top_files[smallest_index], candidate);
        totals.omitted_file_logical_bytes = totals
            .omitted_file_logical_bytes
            .saturating_add(omitted.logical_size_bytes);
        totals.omitted_file_allocated_bytes = totals
            .omitted_file_allocated_bytes
            .saturating_add(omitted.allocated_size_bytes);
        totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
        *min_kept_size = top_files
            .iter()
            .map(|file| file.allocated_size_bytes)
            .min()
            .unwrap_or(0);
    } else {
        totals.omitted_file_logical_bytes = totals
            .omitted_file_logical_bytes
            .saturating_add(candidate.logical_size_bytes);
        totals.omitted_file_allocated_bytes = totals
            .omitted_file_allocated_bytes
            .saturating_add(candidate.allocated_size_bytes);
        totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
    }
}

fn is_photos_library_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 13
        && (name
            .get(name.len().saturating_sub(14)..)
            .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".photoslibrary"))
            || name
                .get(name.len().saturating_sub(13)..)
                .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".photolibrary")))
}

// ---------------------------------------------------------------------------
// macOS getattrlistbulk(2) fast directory enumeration
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
enum BulkReadError {
    Cancelled,
    Unreadable,
    Fallback,
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn enumerate_directory_macos_bulk(
    shared: &SharedScanState<'_>,
    directory: &Path,
    dir_safety: CleanupSafety,
    dir_protection: Option<CleanupProtectionReason>,
    inherit_file_protection: bool,
    totals: &mut DirectoryTotals,
    top_files: &mut Vec<ScannedFile>,
    min_kept_size: &mut u64,
    child_candidates: &mut Vec<ChildDirCandidate>,
    local_largest: &mut Vec<CleanupFile>,
    local_entries: &mut usize,
    local_discovered: &mut u64,
    bulk_buffer: &mut Vec<u8>,
) -> Result<(), BulkReadError> {
    use std::ffi::{CString, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    // Darwin sys/attr.h & sys/vnode.h & sys/stat.h constants.
    const ATTR_CMN_NAME: u32 = 0x0000_0001;
    const ATTR_CMN_DEVID: u32 = 0x0000_0002;
    const ATTR_CMN_OBJTYPE: u32 = 0x0000_0008;
    const ATTR_CMN_MODTIME: u32 = 0x0000_0400;
    const ATTR_CMN_OWNERID: u32 = 0x0000_8000;
    const ATTR_CMN_FLAGS: u32 = 0x0004_0000;
    const ATTR_CMN_FILEID: u32 = 0x0200_0000;
    const ATTR_CMN_ERROR: u32 = 0x2000_0000;
    const ATTR_CMN_RETURNED_ATTRS: u32 = 0x8000_0000;

    const ATTR_DIR_MOUNTSTATUS: u32 = 0x0000_0004;
    const DIR_MNTSTATUS_MNTPOINT: u32 = 0x0000_0001;

    const ATTR_FILE_LINKCOUNT: u32 = 0x0000_0001;
    const ATTR_FILE_ALLOCSIZE: u32 = 0x0000_0004;
    const ATTR_FILE_DATALENGTH: u32 = 0x0000_0200;

    const SF_FIRMLINK: u32 = 0x0080_0000;

    const VREG: u32 = 1;
    const VDIR: u32 = 2;
    const VLNK: u32 = 5;

    let c_path =
        CString::new(directory.as_os_str().as_bytes()).map_err(|_| BulkReadError::Unreadable)?;
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(BulkReadError::Unreadable);
    }

    struct FdGuard(libc::c_int);
    impl Drop for FdGuard {
        fn drop(&mut self) {
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let _fd_guard = FdGuard(fd);

    let mut attr_list: libc::attrlist = unsafe { std::mem::zeroed() };
    attr_list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    attr_list.commonattr = ATTR_CMN_RETURNED_ATTRS
        | ATTR_CMN_NAME
        | ATTR_CMN_DEVID
        | ATTR_CMN_OBJTYPE
        | ATTR_CMN_MODTIME
        | ATTR_CMN_OWNERID
        | ATTR_CMN_FLAGS
        | ATTR_CMN_FILEID
        | ATTR_CMN_ERROR;
    attr_list.dirattr = ATTR_DIR_MOUNTSTATUS;
    attr_list.fileattr = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;

    let config = shared.config;
    let dir_has_excluded_descendant = config
        .excluded_paths
        .iter()
        .any(|excluded| excluded.starts_with(directory));
    let mut processed_any_batch = false;
    let mut batch_entries = 0usize;

    loop {
        if shared.is_aborted() {
            return Err(BulkReadError::Cancelled);
        }
        let count = unsafe {
            libc::getattrlistbulk(
                fd,
                (&mut attr_list as *mut libc::attrlist).cast(),
                bulk_buffer.as_mut_ptr().cast(),
                bulk_buffer.len(),
                0,
            )
        };
        if count == 0 {
            return Ok(());
        }
        if count < 0 {
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            if !processed_any_batch
                && matches!(errno, libc::ENOTSUP | libc::EINVAL | libc::EOPNOTSUPP)
            {
                return Err(BulkReadError::Fallback);
            }
            return Err(BulkReadError::Unreadable);
        }
        processed_any_batch = true;

        let buf = bulk_buffer.as_slice();
        let mut record_offset = 0usize;
        for _ in 0..count {
            batch_entries += 1;
            if batch_entries.is_multiple_of(1024) {
                if shared.is_aborted() {
                    return Err(BulkReadError::Cancelled);
                }
                shared.scanned_entries.fetch_add(1024, Ordering::Relaxed);
                *local_entries = local_entries.saturating_sub(1024);
            }

            let Some(entry_len) = read_u32_ne(buf, record_offset).map(|v| v as usize) else {
                break;
            };
            if entry_len < 24 || record_offset.saturating_add(entry_len) > buf.len() {
                break;
            }
            let record = &buf[record_offset..record_offset + entry_len];
            record_offset += entry_len;

            // ATTR_CMN_RETURNED_ATTRS is always first right after entry_len.
            let Some(ret_common) = read_u32_ne(record, 4) else {
                continue;
            };
            let Some(ret_dir) = read_u32_ne(record, 12) else {
                continue;
            };
            let Some(ret_file) = read_u32_ne(record, 16) else {
                continue;
            };
            let mut pos = 24usize;

            // ATTR_CMN_ERROR immediately follows ATTR_CMN_RETURNED_ATTRS when present.
            if ret_common & ATTR_CMN_ERROR != 0 {
                let err_code = read_u32_ne(record, pos).unwrap_or(1);
                pos += 4;
                if err_code != 0 {
                    *local_entries += 1;
                    shared.record_unreadable(directory);
                    continue;
                }
            }

            let name_bytes = if ret_common & ATTR_CMN_NAME != 0 {
                let ref_pos = pos;
                let data_offset = read_i32_ne(record, pos).unwrap_or(0);
                let data_len = read_u32_ne(record, pos + 4).unwrap_or(0) as usize;
                pos += 8;
                if data_offset < 0 || data_len == 0 {
                    None
                } else {
                    let start = ref_pos.saturating_add(data_offset as usize);
                    let end = start.saturating_add(data_len);
                    record.get(start..end).map(|slice| {
                        // Trim trailing NUL terminator(s).
                        let mut trimmed = slice;
                        while let Some((&0, rest)) = trimmed.split_last() {
                            trimmed = rest;
                        }
                        trimmed
                    })
                }
            } else {
                None
            };

            let Some(name_bytes) = name_bytes else {
                continue;
            };
            if name_bytes.is_empty() || name_bytes == b"." || name_bytes == b".." {
                continue;
            }

            let dev_id = if ret_common & ATTR_CMN_DEVID != 0 {
                let value = read_i32_ne(record, pos).map(|v| v as u64);
                pos += 4;
                value
            } else {
                None
            };
            let obj_type = if ret_common & ATTR_CMN_OBJTYPE != 0 {
                let value = read_u32_ne(record, pos);
                pos += 4;
                value
            } else {
                None
            };
            let modified_at_ms = if ret_common & ATTR_CMN_MODTIME != 0 {
                let tv_sec = read_i64_ne(record, pos).unwrap_or(0);
                let tv_nsec = read_i64_ne(record, pos + 8).unwrap_or(0);
                pos += 16;
                timespec_to_millis(tv_sec, tv_nsec)
            } else {
                None
            };
            let owner_uid = if ret_common & ATTR_CMN_OWNERID != 0 {
                let value = read_u32_ne(record, pos);
                pos += 4;
                value
            } else {
                None
            };
            let flags = if ret_common & ATTR_CMN_FLAGS != 0 {
                let value = read_u32_ne(record, pos).unwrap_or(0);
                pos += 4;
                value
            } else {
                0
            };
            let file_id = if ret_common & ATTR_CMN_FILEID != 0 {
                let value = read_u64_ne(record, pos);
                pos += 8;
                value
            } else {
                None
            };
            let mount_status = if ret_dir & ATTR_DIR_MOUNTSTATUS != 0 {
                let value = read_u32_ne(record, pos).unwrap_or(0);
                pos += 4;
                value
            } else {
                0
            };
            let link_count = if ret_file & ATTR_FILE_LINKCOUNT != 0 {
                let value = read_u32_ne(record, pos);
                pos += 4;
                value
            } else {
                None
            };
            let alloc_size = if ret_file & ATTR_FILE_ALLOCSIZE != 0 {
                let value = read_i64_ne(record, pos).and_then(|v| u64::try_from(v).ok());
                pos += 8;
                value
            } else {
                None
            };
            let data_length = if ret_file & ATTR_FILE_DATALENGTH != 0 {
                let value = read_i64_ne(record, pos).and_then(|v| u64::try_from(v).ok());
                let _ = pos + 8;
                value
            } else {
                None
            };

            *local_entries += 1;

            let name_os = OsStr::from_bytes(name_bytes);
            if dir_has_excluded_descendant
                && path_is_excluded(&directory.join(name_os), config.excluded_paths)
            {
                continue;
            }

            match obj_type {
                Some(VLNK) => continue,
                Some(VDIR) => {
                    let child_path = directory.join(name_os);
                    if is_excluded_scan_namespace(&child_path, config.scan_root)
                        || is_cloud_backed_cleanup_root(&child_path, config.home)
                    {
                        continue;
                    }
                    // For mount points and APFS firmlinks, getattrlistbulk
                    // returns the underlying filesystem's attributes rather
                    // than the mounted/target directory. Query symlink_metadata
                    // to match ScanFilesystemBoundary accurately.
                    let needs_lstat = (mount_status & DIR_MNTSTATUS_MNTPOINT != 0)
                        || (flags & SF_FIRMLINK != 0)
                        || dev_id.is_none();
                    let (final_dev, final_ino, final_mtime) = if needs_lstat {
                        let Ok(meta) = fs::symlink_metadata(&child_path) else {
                            shared.record_unreadable(&child_path);
                            continue;
                        };
                        if !config.boundary.allows_directory(&meta) {
                            continue;
                        }
                        (
                            Some(meta.dev()),
                            Some(meta.ino()),
                            meta.modified().ok().and_then(system_time_millis),
                        )
                    } else {
                        let dev = dev_id.unwrap();
                        if !config.boundary.allows_device(dev) {
                            continue;
                        }
                        (Some(dev), file_id, modified_at_ms)
                    };
                    child_candidates.push(ChildDirCandidate {
                        name: name_os.to_string_lossy().into_owned(),
                        path: child_path,
                        modified_at_ms: final_mtime,
                        device_id: final_dev.and_then(|v| i64::try_from(v).ok()),
                        inode: final_ino.and_then(|v| i64::try_from(v).ok()),
                    });
                }
                Some(VREG) => {
                    let (logical, allocated, dev, ino, mtime, nlink, uid) = if let (
                        Some(logical),
                        Some(allocated),
                        Some(dev),
                        Some(ino),
                        Some(nlink),
                    ) =
                        (data_length, alloc_size, dev_id, file_id, link_count)
                    {
                        (
                            logical,
                            allocated,
                            dev,
                            ino,
                            modified_at_ms,
                            nlink,
                            owner_uid,
                        )
                    } else {
                        let child_path = directory.join(name_os);
                        let Ok(meta) = fs::symlink_metadata(&child_path) else {
                            shared.record_unreadable(&child_path);
                            continue;
                        };
                        if meta.file_type().is_symlink() || !meta.is_file() {
                            continue;
                        }
                        (
                            meta.len(),
                            allocated_file_size(&child_path, &meta),
                            meta.dev(),
                            meta.ino(),
                            meta.modified().ok().and_then(system_time_millis),
                            meta.nlink() as u32,
                            Some(meta.uid()),
                        )
                    };
                    if nlink > 1 && !shared.mark_hardlink_seen((dev, ino)) {
                        continue;
                    }
                    // Ultra-fast path: when this file is neither a large-file
                    // candidate nor large enough to enter the directory's
                    // Top-64 list, accumulate totals with zero PathBuf or
                    // String heap allocations.
                    if allocated < LARGE_FILE_THRESHOLD_BYTES
                        && top_files.len() >= VISIBLE_FILES_PER_DIRECTORY
                        && allocated <= *min_kept_size
                    {
                        *local_discovered = local_discovered.saturating_add(allocated);
                        totals.logical_size_bytes =
                            totals.logical_size_bytes.saturating_add(logical);
                        totals.allocated_size_bytes =
                            totals.allocated_size_bytes.saturating_add(allocated);
                        totals.item_count = totals.item_count.saturating_add(1);
                        totals.direct_child_count = totals.direct_child_count.saturating_add(1);
                        totals.omitted_file_logical_bytes =
                            totals.omitted_file_logical_bytes.saturating_add(logical);
                        totals.omitted_file_allocated_bytes = totals
                            .omitted_file_allocated_bytes
                            .saturating_add(allocated);
                        totals.omitted_file_count = totals.omitted_file_count.saturating_add(1);
                        continue;
                    }
                    let name_str = name_os.to_string_lossy();
                    let needs_path = allocated >= LARGE_FILE_THRESHOLD_BYTES
                        || !inherit_file_protection
                        || is_photos_library_name(&name_str);
                    let child_path = if needs_path {
                        Some(directory.join(name_os))
                    } else {
                        None
                    };
                    record_regular_file_opt_path(
                        shared,
                        child_path.as_deref(),
                        &name_str,
                        logical,
                        allocated,
                        mtime,
                        i64::try_from(dev).ok(),
                        i64::try_from(ino).ok(),
                        uid,
                        dir_safety,
                        dir_protection,
                        inherit_file_protection,
                        totals,
                        top_files,
                        min_kept_size,
                        local_largest,
                        local_discovered,
                    );
                }
                _ => {
                    // FIFOs, sockets, device nodes, or unknown objects are skipped.
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn read_u32_ne(buf: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = buf.get(offset..offset + 4)?.try_into().ok()?;
    Some(u32::from_ne_bytes(bytes))
}

#[cfg(target_os = "macos")]
fn read_i32_ne(buf: &[u8], offset: usize) -> Option<i32> {
    let bytes: [u8; 4] = buf.get(offset..offset + 4)?.try_into().ok()?;
    Some(i32::from_ne_bytes(bytes))
}

#[cfg(target_os = "macos")]
fn read_i64_ne(buf: &[u8], offset: usize) -> Option<i64> {
    let bytes: [u8; 8] = buf.get(offset..offset + 8)?.try_into().ok()?;
    Some(i64::from_ne_bytes(bytes))
}

#[cfg(target_os = "macos")]
fn read_u64_ne(buf: &[u8], offset: usize) -> Option<u64> {
    let bytes: [u8; 8] = buf.get(offset..offset + 8)?.try_into().ok()?;
    Some(u64::from_ne_bytes(bytes))
}

#[cfg(target_os = "macos")]
fn timespec_to_millis(tv_sec: i64, tv_nsec: i64) -> Option<u64> {
    if tv_sec < 0 || tv_nsec < 0 {
        return None;
    }
    let sec_ms = u64::try_from(tv_sec).ok()?.checked_mul(1_000)?;
    let nsec_ms = u64::try_from(tv_nsec).ok()? / 1_000_000;
    sec_ms.checked_add(nsec_ms)
}

fn directory_scan_priority(path: &Path, home: &Path) -> u8 {
    if path == home.join("Library") {
        return 0;
    }
    if path.starts_with(home) {
        return if path
            .file_name()
            .is_some_and(|name| !name.to_string_lossy().starts_with('.'))
        {
            1
        } else {
            2
        };
    }
    3
}

fn path_is_excluded(path: &Path, excluded_paths: &[PathBuf]) -> bool {
    excluded_paths
        .iter()
        .any(|excluded| path == excluded || path.starts_with(excluded))
}

#[cfg(unix)]
fn metadata_device_id(metadata: &Metadata) -> Option<i64> {
    i64::try_from(std::os::unix::fs::MetadataExt::dev(metadata)).ok()
}

#[cfg(not(unix))]
fn metadata_device_id(_metadata: &Metadata) -> Option<i64> {
    None
}

#[cfg(unix)]
fn metadata_inode(metadata: &Metadata) -> Option<i64> {
    i64::try_from(std::os::unix::fs::MetadataExt::ino(metadata)).ok()
}

#[cfg(not(unix))]
fn metadata_inode(_metadata: &Metadata) -> Option<i64> {
    None
}

#[cfg(unix)]
fn hardlink_shard(identity: &FileIdentity) -> usize {
    ((identity.0 ^ identity.1.rotate_left(17)) as usize) % SEEN_FILE_SHARDS
}

#[cfg(windows)]
fn hardlink_shard(identity: &FileIdentity) -> usize {
    ((u64::from(identity.0) ^ identity.1.rotate_left(17)) as usize) % SEEN_FILE_SHARDS
}

#[cfg(not(any(unix, windows)))]
fn hardlink_shard(identity: &FileIdentity) -> usize {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    identity.hash(&mut hasher);
    (hasher.finish() as usize) % SEEN_FILE_SHARDS
}

// ---------------------------------------------------------------------------
// Reusable fast directory enumeration & parallel bundle size measurement
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FastEntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug)]
pub(crate) struct FastDirEntry {
    pub(crate) name: OsString,
    pub(crate) kind: FastEntryKind,
    pub(crate) logical_size: u64,
    pub(crate) allocated_size: u64,
    pub(crate) modified_at: Option<SystemTime>,
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) nlink: u32,
}

/// Enumerates a single directory using macOS `getattrlistbulk(2)` (with
/// transparent fallback to `fs::read_dir`) and invokes `on_entry` for each
/// item. Returning `false` from `on_entry` stops enumeration early.
pub(crate) fn read_dir_fast(
    directory: &Path,
    bulk_buf: &mut Vec<u8>,
    on_entry: &mut dyn FnMut(FastDirEntry) -> bool,
) -> Result<usize, ()> {
    #[cfg(target_os = "macos")]
    {
        match read_dir_fast_macos(directory, bulk_buf, on_entry) {
            Ok(errors) => return Ok(errors),
            Err(true) => {} // ENOTSUP/EINVAL fallback
            Err(false) => return Err(()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = bulk_buf;

    let entries = fs::read_dir(directory).map_err(|_| ())?;
    let mut entry_errors = 0usize;
    for entry in entries {
        let Ok(entry) = entry else {
            entry_errors += 1;
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            entry_errors += 1;
            continue;
        };
        let ft = meta.file_type();
        let kind = if ft.is_symlink() {
            FastEntryKind::Symlink
        } else if ft.is_dir() {
            FastEntryKind::Dir
        } else if ft.is_file() {
            FastEntryKind::File
        } else {
            FastEntryKind::Other
        };
        #[cfg(unix)]
        let (dev, ino, nlink) = {
            use std::os::unix::fs::MetadataExt;
            (meta.dev(), meta.ino(), meta.nlink() as u32)
        };
        #[cfg(not(unix))]
        let (dev, ino, nlink) = (0, 0, 1);

        let keep_going = on_entry(FastDirEntry {
            name: entry.file_name(),
            kind,
            logical_size: meta.len(),
            allocated_size: allocated_file_size(&path, &meta),
            modified_at: meta.modified().ok(),
            dev,
            ino,
            nlink,
        });
        if !keep_going {
            break;
        }
    }
    Ok(entry_errors)
}

#[cfg(target_os = "macos")]
fn read_dir_fast_macos(
    directory: &Path,
    bulk_buf: &mut Vec<u8>,
    on_entry: &mut dyn FnMut(FastDirEntry) -> bool,
) -> Result<usize, bool> {
    use std::ffi::{CString, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    const ATTR_CMN_NAME: u32 = 0x0000_0001;
    const ATTR_CMN_DEVID: u32 = 0x0000_0002;
    const ATTR_CMN_OBJTYPE: u32 = 0x0000_0008;
    const ATTR_CMN_MODTIME: u32 = 0x0000_0400;
    const ATTR_CMN_FILEID: u32 = 0x0200_0000;
    const ATTR_CMN_ERROR: u32 = 0x2000_0000;
    const ATTR_CMN_RETURNED_ATTRS: u32 = 0x8000_0000;
    const ATTR_FILE_LINKCOUNT: u32 = 0x0000_0001;
    const ATTR_FILE_ALLOCSIZE: u32 = 0x0000_0004;
    const ATTR_FILE_DATALENGTH: u32 = 0x0000_0200;
    const VREG: u32 = 1;
    const VDIR: u32 = 2;
    const VLNK: u32 = 5;

    if bulk_buf.len() < 64 * 1024 {
        bulk_buf.resize(64 * 1024, 0);
    }

    let c_path = CString::new(directory.as_os_str().as_bytes()).map_err(|_| false)?;
    let fd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(false);
    }
    struct FdGuard(libc::c_int);
    impl Drop for FdGuard {
        fn drop(&mut self) {
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let _guard = FdGuard(fd);

    let mut attr_list: libc::attrlist = unsafe { std::mem::zeroed() };
    attr_list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    attr_list.commonattr = ATTR_CMN_RETURNED_ATTRS
        | ATTR_CMN_NAME
        | ATTR_CMN_DEVID
        | ATTR_CMN_OBJTYPE
        | ATTR_CMN_MODTIME
        | ATTR_CMN_FILEID
        | ATTR_CMN_ERROR;
    attr_list.fileattr = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE | ATTR_FILE_DATALENGTH;

    let mut processed_any = false;
    let mut entry_errors = 0usize;

    loop {
        let count = unsafe {
            libc::getattrlistbulk(
                fd,
                (&mut attr_list as *mut libc::attrlist).cast(),
                bulk_buf.as_mut_ptr().cast(),
                bulk_buf.len(),
                0,
            )
        };
        if count == 0 {
            return Ok(entry_errors);
        }
        if count < 0 {
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            if !processed_any && matches!(errno, libc::ENOTSUP | libc::EINVAL | libc::EOPNOTSUPP) {
                return Err(true);
            }
            return Err(false);
        }
        processed_any = true;

        let buf = bulk_buf.as_slice();
        let mut offset = 0usize;
        for _ in 0..count {
            let Some(entry_len) = read_u32_ne(buf, offset).map(|v| v as usize) else {
                break;
            };
            if entry_len < 24 || offset.saturating_add(entry_len) > buf.len() {
                break;
            }
            let record = &buf[offset..offset + entry_len];
            offset += entry_len;

            let Some(ret_common) = read_u32_ne(record, 4) else {
                continue;
            };
            let Some(ret_file) = read_u32_ne(record, 16) else {
                continue;
            };
            let mut pos = 24usize;

            if ret_common & ATTR_CMN_ERROR != 0 {
                let err = read_u32_ne(record, pos).unwrap_or(1);
                pos += 4;
                if err != 0 {
                    entry_errors += 1;
                    continue;
                }
            }
            let name_bytes = if ret_common & ATTR_CMN_NAME != 0 {
                let ref_pos = pos;
                let data_offset = read_i32_ne(record, pos).unwrap_or(0);
                let data_len = read_u32_ne(record, pos + 4).unwrap_or(0) as usize;
                pos += 8;
                if data_offset < 0 || data_len == 0 {
                    None
                } else {
                    let start = ref_pos.saturating_add(data_offset as usize);
                    let end = start.saturating_add(data_len);
                    record.get(start..end).map(|slice| {
                        let mut trimmed = slice;
                        while let Some((&0, rest)) = trimmed.split_last() {
                            trimmed = rest;
                        }
                        trimmed
                    })
                }
            } else {
                None
            };
            let Some(name_bytes) = name_bytes else {
                continue;
            };
            if name_bytes.is_empty() || name_bytes == b"." || name_bytes == b".." {
                continue;
            }

            let dev_id = if ret_common & ATTR_CMN_DEVID != 0 {
                let value = read_i32_ne(record, pos).map(|v| v as u64);
                pos += 4;
                value
            } else {
                None
            };
            let obj_type = if ret_common & ATTR_CMN_OBJTYPE != 0 {
                let value = read_u32_ne(record, pos);
                pos += 4;
                value
            } else {
                None
            };
            let modified_at = if ret_common & ATTR_CMN_MODTIME != 0 {
                let tv_sec = read_i64_ne(record, pos).unwrap_or(0);
                let tv_nsec = read_i64_ne(record, pos + 8).unwrap_or(0);
                pos += 16;
                timespec_to_system_time(tv_sec, tv_nsec)
            } else {
                None
            };
            let file_id = if ret_common & ATTR_CMN_FILEID != 0 {
                let value = read_u64_ne(record, pos);
                pos += 8;
                value
            } else {
                None
            };
            let link_count = if ret_file & ATTR_FILE_LINKCOUNT != 0 {
                let value = read_u32_ne(record, pos);
                pos += 4;
                value
            } else {
                None
            };
            let alloc_size = if ret_file & ATTR_FILE_ALLOCSIZE != 0 {
                let value = read_i64_ne(record, pos).and_then(|v| u64::try_from(v).ok());
                pos += 8;
                value
            } else {
                None
            };
            let data_length = if ret_file & ATTR_FILE_DATALENGTH != 0 {
                let value = read_i64_ne(record, pos).and_then(|v| u64::try_from(v).ok());
                let _ = pos + 8;
                value
            } else {
                None
            };

            let name_os = OsStr::from_bytes(name_bytes);
            let kind = match obj_type {
                Some(VREG) => FastEntryKind::File,
                Some(VDIR) => FastEntryKind::Dir,
                Some(VLNK) => FastEntryKind::Symlink,
                _ => FastEntryKind::Other,
            };

            let (logical_size, allocated_size, dev, ino, nlink, mtime) =
                if kind == FastEntryKind::File {
                    if let (Some(l), Some(a), Some(d), Some(i), Some(n)) =
                        (data_length, alloc_size, dev_id, file_id, link_count)
                    {
                        (l, a, d, i, n, modified_at)
                    } else {
                        let full = directory.join(name_os);
                        let Ok(meta) = fs::symlink_metadata(&full) else {
                            entry_errors += 1;
                            continue;
                        };
                        (
                            meta.len(),
                            allocated_file_size(&full, &meta),
                            meta.dev(),
                            meta.ino(),
                            meta.nlink() as u32,
                            meta.modified().ok(),
                        )
                    }
                } else {
                    (
                        0,
                        0,
                        dev_id.unwrap_or(0),
                        file_id.unwrap_or(0),
                        1,
                        modified_at,
                    )
                };

            let keep_going = on_entry(FastDirEntry {
                name: name_os.to_os_string(),
                kind,
                logical_size,
                allocated_size,
                modified_at: mtime,
                dev,
                ino,
                nlink,
            });
            if !keep_going {
                return Ok(entry_errors);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn timespec_to_system_time(tv_sec: i64, tv_nsec: i64) -> Option<SystemTime> {
    if tv_sec < 0 || tv_nsec < 0 {
        return None;
    }
    let secs = u64::try_from(tv_sec).ok()?;
    let nanos = u32::try_from(tv_nsec).ok()?;
    UNIX_EPOCH.checked_add(Duration::new(secs, nanos))
}

/// Measures allocated disk sizes for multiple independent root directories in
/// parallel using `read_dir_fast`, deduplicating hard links per root.
#[cfg(target_os = "macos")]
pub(super) fn measure_directory_sizes_parallel(
    roots: &[PathBuf],
    cancelled: &AtomicBool,
) -> HashMap<PathBuf, u64> {
    if roots.is_empty() {
        return HashMap::new();
    }
    let worker_count = thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4)
        .min(roots.len());
    let next_index = AtomicUsize::new(0);
    let results = Mutex::new(HashMap::with_capacity(roots.len()));

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let next_index = &next_index;
            let results = &results;
            scope.spawn(move || {
                let mut bulk_buf = vec![0u8; 64 * 1024];
                let mut stack = Vec::<PathBuf>::new();
                let mut seen = HashSet::<(u64, u64)>::new();
                loop {
                    if cancelled.load(Ordering::Relaxed) {
                        break;
                    }
                    let idx = next_index.fetch_add(1, Ordering::Relaxed);
                    let Some(root) = roots.get(idx) else {
                        break;
                    };
                    stack.clear();
                    seen.clear();
                    stack.push(root.clone());
                    let mut total_bytes = 0_u64;
                    while let Some(dir) = stack.pop() {
                        if cancelled.load(Ordering::Relaxed) {
                            break;
                        }
                        let _ = read_dir_fast(&dir, &mut bulk_buf, &mut |entry| {
                            if cancelled.load(Ordering::Relaxed) {
                                return false;
                            }
                            match entry.kind {
                                FastEntryKind::Dir => {
                                    stack.push(dir.join(&entry.name));
                                }
                                FastEntryKind::File => {
                                    if entry.nlink > 1 && !seen.insert((entry.dev, entry.ino)) {
                                        return true;
                                    }
                                    total_bytes = total_bytes.saturating_add(entry.allocated_size);
                                }
                                _ => {}
                            }
                            true
                        });
                    }
                    if let Ok(mut map) = results.lock() {
                        map.insert(root.clone(), total_bytes);
                    }
                }
            });
        }
    });

    results.into_inner().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn memory_scanner_rolls_up_nested_tree_and_deduplicates_hardlinks() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        let file1 = root.join("a/b/c/big.bin");
        fs::write(&file1, vec![42u8; 8192]).unwrap();
        #[cfg(unix)]
        fs::hard_link(&file1, root.join("a/hardlink.bin")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file1, root.join("a/symlink.bin")).unwrap();

        let canonical_root = root.canonicalize().unwrap();
        let boundary = ScanFilesystemBoundary::for_root(&canonical_root).unwrap();
        let config = MemoryScanConfig {
            scan_root: &canonical_root,
            home: &canonical_root,
            protection_root: &canonical_root,
            selected_cleanup_root: true,
            boundary,
            definitions: &[],
            excluded_paths: &[],
            synthetic_root_name: None,
            root_display_path: "~",
            root_safety: CleanupSafety::Review,
            root_protection_reason: Some(CleanupProtectionReason::SystemLocation),
            multi_roots: Vec::new(),
            preserve_system_anchors: false,
            reusable_subtrees: HashMap::new(),
        };
        let cancelled = AtomicBool::new(false);
        let mut previews = 0usize;
        let tree = scan_tree_in_memory(&config, &cancelled, &mut |_| {}, &mut |_| {
            previews += 1;
        })
        .unwrap();

        assert!(previews >= 1);
        assert_eq!(tree.dirs.len(), 5); // root, a, b, c, empty
        assert_eq!(tree.dirs[0].totals.item_count, 1);
        assert_eq!(tree.dirs[0].totals.logical_size_bytes, 8192);
        assert!(tree.dirs[0].totals.allocated_size_bytes >= 8192);
        assert_eq!(tree.largest_files.len(), 1);
        assert!(
            tree.largest_files[0].path.ends_with("big.bin")
                || tree.largest_files[0].path.ends_with("hardlink.bin")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_getattrlistbulk_matches_symlink_metadata_fields() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempdir().unwrap();
        let root = dir.path().join("bulk-check");
        fs::create_dir_all(root.join("sub")).unwrap();
        let sample = root.join("sample.dat");
        fs::write(&sample, vec![7u8; 12_345]).unwrap();
        let meta = fs::symlink_metadata(&sample).unwrap();

        let canonical_root = root.canonicalize().unwrap();
        let boundary = ScanFilesystemBoundary::for_root(&canonical_root).unwrap();
        let config = MemoryScanConfig {
            scan_root: &canonical_root,
            home: &canonical_root,
            protection_root: &canonical_root,
            selected_cleanup_root: true,
            boundary,
            definitions: &[],
            excluded_paths: &[],
            synthetic_root_name: None,
            root_display_path: "~",
            root_safety: CleanupSafety::Review,
            root_protection_reason: None,
            multi_roots: Vec::new(),
            preserve_system_anchors: false,
            reusable_subtrees: HashMap::new(),
        };
        let tree = scan_tree_in_memory(&config, &AtomicBool::new(false), &mut |_| {}, &mut |_| {})
            .unwrap();

        assert_eq!(tree.dirs[0].totals.logical_size_bytes, meta.len());
        assert_eq!(
            tree.dirs[0].totals.allocated_size_bytes,
            meta.blocks().saturating_mul(512)
        );
        let kept = &tree.dirs[0].top_files[0];
        assert_eq!(kept.name, "sample.dat");
        assert_eq!(kept.device_id, i64::try_from(meta.dev()).ok());
        assert_eq!(kept.inode, i64::try_from(meta.ino()).ok());
        assert_eq!(
            kept.modified_at_ms,
            meta.modified().ok().and_then(system_time_millis)
        );
    }
}
