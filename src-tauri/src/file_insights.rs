use std::collections::HashMap;
use std::env;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use crate::cleanup::{FastEntryKind, read_dir_fast};
use crate::error::CommandError;
use crate::models::{
    DuplicateFileGroup, FileInsightFile, FileInsightsPhase, FileInsightsProgress, FileInsightsScan,
};
use crate::private_storage;

const MIN_DUPLICATE_SIZE_BYTES: u64 = 1024 * 1024;
const PARTIAL_HASH_WINDOW_BYTES: usize = 4 * 1024;
const MIN_LONG_UNMODIFIED_SIZE_BYTES: u64 = 100 * 1024 * 1024;
const LONG_UNMODIFIED_AGE: Duration = Duration::from_secs(180 * 24 * 60 * 60);
const MAX_SCANNED_ENTRIES: usize = 200_000;
const MAX_CANDIDATE_FILES: usize = 50_000;
const MAX_HASHED_FILES: usize = 2_000;
const MAX_HASHED_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_DUPLICATE_GROUPS: usize = 100;
const MAX_LONG_UNMODIFIED_FILES: usize = 200;
const MAX_FILE_INSIGHTS_CACHE_BYTES: u64 = 8 * 1_024 * 1_024;
const FILE_INSIGHTS_CACHE_VERSION: u8 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInsightsCachePayload<'a> {
    version: u8,
    saved_at_ms: u64,
    snapshot: &'a FileInsightsScan,
}

#[derive(Default)]
pub struct FileInsightsCoordinator {
    active: AtomicBool,
    cancellation: Mutex<Option<Arc<AtomicBool>>>,
}

impl FileInsightsCoordinator {
    pub fn begin(&self) -> Result<Arc<AtomicBool>, CommandError> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                CommandError::new(
                    "file_insights_scan_in_progress",
                    "A file insights scan is already running.",
                )
            })?;
        let cancellation = Arc::new(AtomicBool::new(false));
        match self.cancellation.lock() {
            Ok(mut slot) => *slot = Some(Arc::clone(&cancellation)),
            Err(_) => {
                self.active.store(false, Ordering::Release);
                return Err(CommandError::internal(
                    "The file insights cancellation lock was poisoned.",
                ));
            }
        }
        Ok(cancellation)
    }

    pub fn finish(&self, cancellation: &Arc<AtomicBool>) {
        if let Ok(mut slot) = self.cancellation.lock()
            && slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, cancellation))
        {
            *slot = None;
        }
        self.active.store(false, Ordering::Release);
    }

    pub fn cancel(&self) -> Result<(), CommandError> {
        let slot = self.cancellation.lock().map_err(|_| {
            CommandError::internal("The file insights cancellation lock was poisoned.")
        })?;
        if let Some(cancellation) = slot.as_ref() {
            cancellation.store(true, Ordering::Release);
        }
        Ok(())
    }
}

#[derive(Clone)]
struct CandidateFile {
    path: PathBuf,
    size_bytes: u64,
    allocated_size_bytes: u64,
    modified_at: Option<SystemTime>,
    device_id: Option<u64>,
    inode: Option<u64>,
}

pub fn scan_file_insights(
    cancellation: &AtomicBool,
    on_progress: &mut impl FnMut(FileInsightsProgress),
) -> Result<FileInsightsScan, CommandError> {
    let started_at = Instant::now();
    let home = home_directory().ok_or_else(|| {
        CommandError::new(
            "home_directory_unavailable",
            "The current user's home directory could not be determined.",
        )
    })?;
    let roots = [
        "Desktop",
        "Documents",
        "Downloads",
        "Movies",
        "Music",
        "Pictures",
    ]
    .into_iter()
    .map(|name| home.join(name))
    .filter(|path| {
        fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    })
    .collect::<Vec<_>>();

    scan_file_insights_in_roots(&roots, started_at, cancellation, on_progress)
}

fn scan_file_insights_in_roots(
    roots: &[PathBuf],
    started_at: Instant,
    cancellation: &AtomicBool,
    on_progress: &mut impl FnMut(FileInsightsProgress),
) -> Result<FileInsightsScan, CommandError> {
    let mut stack = roots.to_vec();
    let mut candidates = Vec::new();
    let mut long_unmodified_files = Vec::new();
    let mut scanned_entry_count = 0usize;
    let mut unreadable_entry_count = 0usize;
    let mut truncated = false;
    let old_before = SystemTime::now()
        .checked_sub(LONG_UNMODIFIED_AGE)
        .unwrap_or(UNIX_EPOCH);
    let mut bulk_buf = vec![0u8; 64 * 1024];

    while let Some(directory) = stack.pop() {
        ensure_not_cancelled(cancellation)?;
        let mut hit_cap = false;
        let read_result = read_dir_fast(&directory, &mut bulk_buf, &mut |entry| {
            if cancellation.load(Ordering::Acquire) {
                return false;
            }
            if scanned_entry_count >= MAX_SCANNED_ENTRIES {
                truncated = true;
                hit_cap = true;
                return false;
            }
            scanned_entry_count += 1;
            match entry.kind {
                FastEntryKind::Dir => {
                    stack.push(directory.join(&entry.name));
                }
                FastEntryKind::File => {
                    let logical = entry.logical_size;
                    let is_long_unmodified = logical >= MIN_LONG_UNMODIFIED_SIZE_BYTES
                        && entry
                            .modified_at
                            .is_some_and(|modified| modified <= old_before);
                    let is_dup_candidate = logical >= MIN_DUPLICATE_SIZE_BYTES;
                    if is_long_unmodified || is_dup_candidate {
                        let path = directory.join(&entry.name);
                        #[cfg(unix)]
                        let (device_id, inode) = (Some(entry.dev), Some(entry.ino));
                        #[cfg(not(unix))]
                        let (device_id, inode) = (None, None);
                        if is_long_unmodified {
                            long_unmodified_files.push(FileInsightFile {
                                name: entry.name.to_string_lossy().into_owned(),
                                path: path.to_string_lossy().into_owned(),
                                size_bytes: logical,
                                logical_size_bytes: logical,
                                allocated_size_bytes: entry.allocated_size,
                                modified_at_ms: entry.modified_at.and_then(system_time_millis),
                                modified_at_us: entry.modified_at.and_then(system_time_micros),
                                device_id,
                                inode,
                            });
                        }
                        if is_dup_candidate {
                            if candidates.len() >= MAX_CANDIDATE_FILES {
                                truncated = true;
                            } else {
                                candidates.push(CandidateFile {
                                    path,
                                    size_bytes: logical,
                                    allocated_size_bytes: entry.allocated_size,
                                    modified_at: entry.modified_at,
                                    device_id,
                                    inode,
                                });
                            }
                        }
                    }
                }
                FastEntryKind::Symlink | FastEntryKind::Other => {}
            }

            if scanned_entry_count.is_multiple_of(500) {
                on_progress(FileInsightsProgress {
                    phase: FileInsightsPhase::Discovering,
                    scanned_entry_count,
                    candidate_file_count: candidates.len(),
                    hashed_file_count: 0,
                    current_path: directory.to_string_lossy().into_owned(),
                });
            }
            true
        });
        ensure_not_cancelled(cancellation)?;
        match read_result {
            Ok(entry_errors) => {
                unreadable_entry_count = unreadable_entry_count.saturating_add(entry_errors);
            }
            Err(()) => {
                unreadable_entry_count = unreadable_entry_count.saturating_add(1);
            }
        }
        if hit_cap {
            stack.clear();
            break;
        }
    }

    long_unmodified_files.sort_by_key(|file| std::cmp::Reverse(file.size_bytes));
    long_unmodified_files.truncate(MAX_LONG_UNMODIFIED_FILES);

    // Stage 1: Group by exact byte size.
    let mut by_size: HashMap<u64, Vec<CandidateFile>> = HashMap::new();
    for candidate in candidates.iter().cloned() {
        by_size
            .entry(candidate.size_bytes)
            .or_default()
            .push(candidate);
    }
    let size_collision_candidates = by_size
        .into_values()
        .filter(|group| group.len() > 1)
        .flatten()
        .collect::<Vec<_>>();

    // Stage 2: Fast head+tail 4 KiB partial SHA-256 pre-filter (parallelized).
    // Files that collide only on byte length are eliminated with <= 8 KiB of
    // I/O instead of hashing gigabytes of content.
    let (partial_groups, partial_unreadable) =
        partial_filter_candidates(size_collision_candidates, cancellation)?;
    unreadable_entry_count = unreadable_entry_count.saturating_add(partial_unreadable);

    let mut hash_candidates = partial_groups
        .into_values()
        .filter(|group| group.len() > 1)
        .flatten()
        .collect::<Vec<_>>();
    hash_candidates.sort_by_key(|file| std::cmp::Reverse(file.size_bytes));

    // Stage 3: Full SHA-256 only on candidates that matched both size and
    // head+tail partial digest, respecting MAX_HASHED_FILES & MAX_HASHED_BYTES.
    let mut selected_for_full_hash = Vec::new();
    let mut planned_bytes = 0u64;
    for candidate in hash_candidates {
        if selected_for_full_hash.len() >= MAX_HASHED_FILES
            || planned_bytes.saturating_add(candidate.size_bytes) > MAX_HASHED_BYTES
        {
            truncated = true;
            break;
        }
        planned_bytes = planned_bytes.saturating_add(candidate.size_bytes);
        selected_for_full_hash.push(candidate);
    }

    let (by_digest, hashed_file_count, full_hash_unreadable) = hash_candidates_parallel(
        &selected_for_full_hash,
        scanned_entry_count,
        candidates.len(),
        cancellation,
        on_progress,
    )?;
    unreadable_entry_count = unreadable_entry_count.saturating_add(full_hash_unreadable);

    let mut duplicate_groups = by_digest
        .into_iter()
        .filter_map(|((size_bytes, digest), mut files)| {
            if files.len() < 2 {
                return None;
            }
            files.sort_by(|left, right| left.path.cmp(&right.path));
            Some(DuplicateFileGroup {
                digest,
                size_bytes,
                reclaimable_bytes: size_bytes.saturating_mul(files.len().saturating_sub(1) as u64),
                files,
            })
        })
        .collect::<Vec<_>>();
    duplicate_groups.sort_by_key(|group| std::cmp::Reverse(group.reclaimable_bytes));
    duplicate_groups.truncate(MAX_DUPLICATE_GROUPS);

    Ok(FileInsightsScan {
        sampled_at_ms: now_millis(),
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        scanned_entry_count,
        candidate_file_count: candidates.len(),
        hashed_file_count,
        duplicate_groups,
        long_unmodified_files,
        unreadable_entry_count,
        truncated,
    })
}

type PartialHashGroups = HashMap<(u64, [u8; 32]), Vec<CandidateFile>>;

fn partial_filter_candidates(
    candidates: Vec<CandidateFile>,
    cancellation: &AtomicBool,
) -> Result<(PartialHashGroups, usize), CommandError> {
    if candidates.is_empty() {
        return Ok((HashMap::new(), 0));
    }
    let worker_count = thread::available_parallelism()
        .map(|n| n.get().clamp(2, 4))
        .unwrap_or(2)
        .min(candidates.len());
    let next_idx = AtomicUsize::new(0);
    let groups = Mutex::new(HashMap::<(u64, [u8; 32]), Vec<CandidateFile>>::new());
    let unreadable = AtomicUsize::new(0);

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let candidates = &candidates;
            let next_idx = &next_idx;
            let groups = &groups;
            let unreadable = &unreadable;
            scope.spawn(move || {
                loop {
                    if cancellation.load(Ordering::Acquire) {
                        break;
                    }
                    let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                    let Some(candidate) = candidates.get(idx) else {
                        break;
                    };
                    match partial_hash_candidate(candidate) {
                        Ok(partial_digest) => {
                            if let Ok(mut map) = groups.lock() {
                                map.entry((candidate.size_bytes, partial_digest))
                                    .or_default()
                                    .push(candidate.clone());
                            }
                        }
                        Err(_) => {
                            unreadable.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            });
        }
    });
    ensure_not_cancelled(cancellation)?;
    Ok((
        groups.into_inner().unwrap_or_default(),
        unreadable.load(Ordering::Relaxed),
    ))
}

fn partial_hash_candidate(candidate: &CandidateFile) -> io::Result<[u8; 32]> {
    let mut file = open_file_no_follow(&candidate.path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() != candidate.size_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed before partial hashing",
        ));
    }
    let mut digest = Sha256::new();
    let mut buf = [0u8; PARTIAL_HASH_WINDOW_BYTES];
    let head_len = read_up_to(&mut file, &mut buf)?;
    digest.update(&buf[..head_len]);
    if candidate.size_bytes > PARTIAL_HASH_WINDOW_BYTES as u64 {
        let tail_offset = candidate
            .size_bytes
            .saturating_sub(PARTIAL_HASH_WINDOW_BYTES as u64);
        file.seek(SeekFrom::Start(tail_offset))?;
        let tail_len = read_up_to(&mut file, &mut buf)?;
        digest.update(&buf[..tail_len]);
    }
    Ok(digest.finalize().into())
}

fn read_up_to(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
}

#[allow(clippy::type_complexity)]
fn hash_candidates_parallel(
    candidates: &[CandidateFile],
    scanned_entry_count: usize,
    candidate_file_count: usize,
    cancellation: &AtomicBool,
    on_progress: &mut impl FnMut(FileInsightsProgress),
) -> Result<(HashMap<(u64, String), Vec<FileInsightFile>>, usize, usize), CommandError> {
    if candidates.is_empty() {
        return Ok((HashMap::new(), 0, 0));
    }
    let worker_count = thread::available_parallelism()
        .map(|n| n.get().clamp(2, 4))
        .unwrap_or(2)
        .min(candidates.len());
    let next_idx = AtomicUsize::new(0);
    let hashed_count = AtomicUsize::new(0);
    let unreadable = AtomicUsize::new(0);
    let by_digest = Mutex::new(HashMap::<(u64, String), Vec<FileInsightFile>>::new());
    let latest_path = Mutex::new(String::new());

    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let next_idx = &next_idx;
            let hashed_count = &hashed_count;
            let unreadable = &unreadable;
            let by_digest = &by_digest;
            let latest_path = &latest_path;
            handles.push(scope.spawn(move || {
                loop {
                    if cancellation.load(Ordering::Acquire) {
                        break;
                    }
                    let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                    let Some(candidate) = candidates.get(idx) else {
                        break;
                    };
                    if let Ok(mut slot) = latest_path.try_lock() {
                        *slot = candidate.path.to_string_lossy().into_owned();
                    }
                    if let Ok(digest) = hash_candidate(candidate) {
                        hashed_count.fetch_add(1, Ordering::Relaxed);
                        let insight = FileInsightFile {
                            name: candidate
                                .path
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned(),
                            path: candidate.path.to_string_lossy().into_owned(),
                            size_bytes: candidate.size_bytes,
                            logical_size_bytes: candidate.size_bytes,
                            allocated_size_bytes: candidate.allocated_size_bytes,
                            modified_at_ms: candidate.modified_at.and_then(system_time_millis),
                            modified_at_us: candidate.modified_at.and_then(system_time_micros),
                            device_id: candidate.device_id,
                            inode: candidate.inode,
                        };
                        if let Ok(mut map) = by_digest.lock() {
                            map.entry((candidate.size_bytes, digest))
                                .or_default()
                                .push(insight);
                        }
                    } else {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }));
        }

        let mut last_reported = 0usize;
        while handles.iter().any(|h| !h.is_finished()) {
            if cancellation.load(Ordering::Acquire) {
                break;
            }
            let current = hashed_count.load(Ordering::Relaxed);
            if current.saturating_sub(last_reported) >= 10 {
                last_reported = current;
                let current_path = latest_path.lock().map(|p| p.clone()).unwrap_or_default();
                on_progress(FileInsightsProgress {
                    phase: FileInsightsPhase::Hashing,
                    scanned_entry_count,
                    candidate_file_count,
                    hashed_file_count: current,
                    current_path,
                });
            }
            thread::sleep(Duration::from_millis(50));
        }

        for handle in handles {
            let _ = handle.join();
        }
    });

    ensure_not_cancelled(cancellation)?;
    Ok((
        by_digest.into_inner().unwrap_or_default(),
        hashed_count.load(Ordering::Relaxed),
        unreadable.load(Ordering::Relaxed),
    ))
}

pub fn load_file_insights_cache(path: &Path) -> Result<Option<String>, CommandError> {
    let bytes = match private_storage::read_limited(path, MAX_FILE_INSIGHTS_CACHE_BYTES) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    Ok(String::from_utf8(bytes).ok())
}

pub fn save_file_insights_snapshot_cache(
    path: &Path,
    snapshot: &FileInsightsScan,
) -> Result<(), CommandError> {
    save_file_insights_snapshot_cache_at(path, snapshot, now_millis())
}

pub fn save_file_insights_snapshot_cache_at(
    path: &Path,
    snapshot: &FileInsightsScan,
    saved_at_ms: u64,
) -> Result<(), CommandError> {
    let serialized = serde_json::to_string(&FileInsightsCachePayload {
        version: FILE_INSIGHTS_CACHE_VERSION,
        saved_at_ms,
        snapshot,
    })
    .map_err(|error| {
        CommandError::internal(format!("Could not encode the file insights cache: {error}"))
    })?;
    if u64::try_from(serialized.len()).unwrap_or(u64::MAX) > MAX_FILE_INSIGHTS_CACHE_BYTES {
        return Err(CommandError::new(
            "file_insights_cache_too_large",
            "The file insights cache is too large to retain safely.",
        ));
    }
    private_storage::write_atomic(path, serialized.as_bytes()).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely update the file insights cache: {error}"
        ))
    })
}

pub fn remove_file_insights_cache(path: &Path) -> Result<(), CommandError> {
    private_storage::remove(path).map_err(|error| {
        CommandError::internal(format!(
            "Could not securely clear the file insights cache: {error}"
        ))
    })
}

pub fn revalidate_file_insights_snapshot(
    mut snapshot: FileInsightsScan,
) -> Result<FileInsightsScan, CommandError> {
    let started_at = Instant::now();
    let mut duplicate_groups = std::mem::take(&mut snapshot.duplicate_groups)
        .into_iter()
        .filter_map(|group| {
            let mut files = group
                .files
                .into_iter()
                .filter_map(|cached| {
                    revalidate_duplicate_file(&cached, &group.digest, group.size_bytes)
                })
                .collect::<Vec<_>>();
            if files.len() < 2 {
                return None;
            }
            files.sort_by(|left, right| left.path.cmp(&right.path));
            Some(DuplicateFileGroup {
                digest: group.digest,
                size_bytes: group.size_bytes,
                reclaimable_bytes: group
                    .size_bytes
                    .saturating_mul(files.len().saturating_sub(1) as u64),
                files,
            })
        })
        .collect::<Vec<_>>();
    duplicate_groups.sort_by_key(|group| std::cmp::Reverse(group.reclaimable_bytes));

    let old_before = SystemTime::now()
        .checked_sub(LONG_UNMODIFIED_AGE)
        .unwrap_or(UNIX_EPOCH);
    let mut long_unmodified_files = std::mem::take(&mut snapshot.long_unmodified_files)
        .into_iter()
        .filter_map(|cached| {
            let metadata = safe_regular_file_metadata(Path::new(&cached.path))?;
            let modified_at = metadata.modified().ok()?;
            if metadata.len() < MIN_LONG_UNMODIFIED_SIZE_BYTES || modified_at > old_before {
                return None;
            }
            Some(to_file_insight(Path::new(&cached.path), &metadata))
        })
        .collect::<Vec<_>>();
    long_unmodified_files.sort_by_key(|file| std::cmp::Reverse(file.size_bytes));

    snapshot.sampled_at_ms = now_millis();
    snapshot.duration_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
    snapshot.duplicate_groups = duplicate_groups;
    snapshot.long_unmodified_files = long_unmodified_files;
    Ok(snapshot)
}

fn revalidate_duplicate_file(
    cached: &FileInsightFile,
    expected_digest: &str,
    expected_size: u64,
) -> Option<FileInsightFile> {
    let path = Path::new(&cached.path);
    let metadata = safe_regular_file_metadata(path)?;
    if metadata.len() != expected_size {
        return None;
    }
    let current = to_file_insight(path, &metadata);
    if file_fingerprint_matches(cached, &current) {
        return Some(current);
    }
    let candidate = CandidateFile {
        path: path.to_path_buf(),
        size_bytes: metadata.len(),
        allocated_size_bytes: file_allocated_size(&metadata),
        modified_at: metadata.modified().ok(),
        device_id: file_device_id(&metadata),
        inode: file_inode(&metadata),
    };
    (hash_candidate(&candidate).ok()?.as_str() == expected_digest).then_some(current)
}

fn safe_regular_file_metadata(path: &Path) -> Option<Metadata> {
    let metadata = fs::symlink_metadata(path).ok()?;
    (metadata.is_file() && !metadata.file_type().is_symlink()).then_some(metadata)
}

fn file_fingerprint_matches(cached: &FileInsightFile, current: &FileInsightFile) -> bool {
    cached.logical_size_bytes == current.logical_size_bytes
        && cached.modified_at_ms == current.modified_at_ms
        && cached
            .modified_at_us
            .is_some_and(|modified_at_us| Some(modified_at_us) == current.modified_at_us)
        && cached
            .device_id
            .is_none_or(|device_id| Some(device_id) == current.device_id)
        && cached
            .inode
            .is_none_or(|inode| Some(inode) == current.inode)
}

fn hash_candidate(candidate: &CandidateFile) -> io::Result<String> {
    let before = fs::symlink_metadata(&candidate.path)?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() != candidate.size_bytes
        || before.modified().ok() != candidate.modified_at
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed before hashing",
        ));
    }
    let mut file = open_file_no_follow(&candidate.path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let after = file.metadata()?;
    if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed while hashing",
        ));
    }
    let digest = digest.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(encoded)
}

#[cfg(unix)]
fn open_file_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_file_no_follow(path: &Path) -> io::Result<File> {
    File::open(path)
}

fn to_file_insight(path: &Path, metadata: &Metadata) -> FileInsightFile {
    let logical_size_bytes = metadata.len();
    FileInsightFile {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        size_bytes: logical_size_bytes,
        logical_size_bytes,
        allocated_size_bytes: file_allocated_size(metadata),
        modified_at_ms: metadata.modified().ok().and_then(system_time_millis),
        modified_at_us: metadata.modified().ok().and_then(system_time_micros),
        device_id: file_device_id(metadata),
        inode: file_inode(metadata),
    }
}

#[cfg(unix)]
fn file_device_id(metadata: &Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.dev())
}

#[cfg(not(unix))]
fn file_device_id(_metadata: &Metadata) -> Option<u64> {
    None
}

#[cfg(unix)]
fn file_inode(metadata: &Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.ino())
}

#[cfg(not(unix))]
fn file_inode(_metadata: &Metadata) -> Option<u64> {
    None
}

#[cfg(unix)]
fn file_allocated_size(metadata: &Metadata) -> u64 {
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn file_allocated_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

fn ensure_not_cancelled(cancellation: &AtomicBool) -> Result<(), CommandError> {
    if cancellation.load(Ordering::Acquire) {
        Err(CommandError::new(
            "file_insights_scan_cancelled",
            "The file insights scan was cancelled.",
        ))
    } else {
        Ok(())
    }
}

fn home_directory() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn system_time_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
}

fn system_time_micros(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_micros()).ok())
}

fn now_millis() -> u64 {
    system_time_millis(SystemTime::now()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        CandidateFile, FILE_INSIGHTS_CACHE_VERSION, hash_candidate, load_file_insights_cache,
        remove_file_insights_cache, revalidate_file_insights_snapshot,
        save_file_insights_snapshot_cache_at, to_file_insight,
    };
    use crate::models::{DuplicateFileGroup, FileInsightsScan};

    #[test]
    fn hashes_stable_regular_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("sample.bin");
        fs::write(&path, b"CoreRobin file insights").expect("write fixture");
        let metadata = fs::symlink_metadata(&path).expect("fixture metadata");
        let candidate = CandidateFile {
            path,
            size_bytes: metadata.len(),
            allocated_size_bytes: super::file_allocated_size(&metadata),
            modified_at: metadata.modified().ok(),
            device_id: super::file_device_id(&metadata),
            inode: super::file_inode(&metadata),
        };
        assert_eq!(
            hash_candidate(&candidate).expect("hash fixture"),
            "f05a8c8aee40ad12d55674e20d54ea5080329c1bf7452276f5cfbfd9270dfd35"
        );
    }

    #[test]
    fn records_logical_and_allocated_size_for_delete_revalidation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("evidence.bin");
        fs::write(&path, b"CoreRobin duplicate evidence").expect("write fixture");
        let metadata = fs::symlink_metadata(&path).expect("fixture metadata");

        let insight = to_file_insight(&path, &metadata);

        assert_eq!(insight.size_bytes, metadata.len());
        assert_eq!(insight.logical_size_bytes, metadata.len());
        assert!(insight.allocated_size_bytes > 0);
    }

    #[test]
    fn file_insights_cache_round_trips_and_clears() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let cache_path = directory.path().join("nested/file-insights-v1.json");
        let scan = FileInsightsScan {
            sampled_at_ms: 100,
            duration_ms: 20,
            scanned_entry_count: 3,
            candidate_file_count: 2,
            hashed_file_count: 2,
            duplicate_groups: Vec::new(),
            long_unmodified_files: Vec::new(),
            unreadable_entry_count: 0,
            truncated: false,
        };

        assert_eq!(load_file_insights_cache(&cache_path).unwrap(), None);
        save_file_insights_snapshot_cache_at(&cache_path, &scan, 1_234).unwrap();
        let serialized = load_file_insights_cache(&cache_path).unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            payload["version"].as_u64(),
            Some(u64::from(FILE_INSIGHTS_CACHE_VERSION)),
        );
        assert_eq!(payload["savedAtMs"].as_u64(), Some(1_234));
        assert_eq!(payload["snapshot"]["sampledAtMs"].as_u64(), Some(100));

        remove_file_insights_cache(&cache_path).unwrap();
        assert_eq!(load_file_insights_cache(&cache_path).unwrap(), None);
    }

    #[test]
    fn cached_duplicates_are_rehashed_only_when_their_fingerprint_changes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let left_path = directory.path().join("left.bin");
        let right_path = directory.path().join("right.bin");
        fs::write(&left_path, b"same duplicate bytes").expect("write left fixture");
        fs::write(&right_path, b"same duplicate bytes").expect("write right fixture");
        let left_metadata = fs::symlink_metadata(&left_path).expect("left metadata");
        let right_metadata = fs::symlink_metadata(&right_path).expect("right metadata");
        let digest = hash_candidate(&CandidateFile {
            path: left_path.clone(),
            size_bytes: left_metadata.len(),
            allocated_size_bytes: super::file_allocated_size(&left_metadata),
            modified_at: left_metadata.modified().ok(),
            device_id: super::file_device_id(&left_metadata),
            inode: super::file_inode(&left_metadata),
        })
        .expect("hash duplicate fixture");
        let scan = FileInsightsScan {
            sampled_at_ms: 100,
            duration_ms: 20,
            scanned_entry_count: 2,
            candidate_file_count: 2,
            hashed_file_count: 2,
            duplicate_groups: vec![DuplicateFileGroup {
                digest,
                size_bytes: left_metadata.len(),
                reclaimable_bytes: left_metadata.len(),
                files: vec![
                    to_file_insight(&left_path, &left_metadata),
                    to_file_insight(&right_path, &right_metadata),
                ],
            }],
            long_unmodified_files: Vec::new(),
            unreadable_entry_count: 0,
            truncated: false,
        };

        let unchanged =
            revalidate_file_insights_snapshot(scan.clone()).expect("revalidate unchanged cache");
        assert_eq!(unchanged.duplicate_groups.len(), 1);
        assert_eq!(unchanged.duplicate_groups[0].files.len(), 2);

        std::thread::sleep(std::time::Duration::from_millis(2));
        fs::write(&right_path, b"changed file content").expect("replace right fixture");
        let changed = revalidate_file_insights_snapshot(scan).expect("revalidate changed cache");
        assert!(changed.duplicate_groups.is_empty());
    }

    #[test]
    fn partial_hash_skips_full_hash_for_same_size_distinct_files_and_detects_real_duplicates() {
        use std::sync::atomic::AtomicBool;
        use std::time::Instant;

        let directory = tempfile::tempdir().expect("temporary directory");
        let size = 1024 * 1024 + 16 * 1024;
        // Two same-sized distinct files (different head bytes): should be
        // eliminated by the 4 KiB partial fingerprint without full hashing.
        let distinct_a = directory.path().join("distinct-a.bin");
        let distinct_b = directory.path().join("distinct-b.bin");
        fs::write(&distinct_a, vec![0x11_u8; size]).unwrap();
        fs::write(&distinct_b, vec![0x22_u8; size]).unwrap();

        // Two true duplicates of another size: should pass partial hash and be
        // grouped by full SHA-256.
        let dup_size = 1024 * 1024 + 32 * 1024;
        let dup_a = directory.path().join("dup-a.bin");
        let dup_b = directory.path().join("dup-b.bin");
        let payload = vec![0x5a_u8; dup_size];
        fs::write(&dup_a, &payload).unwrap();
        fs::write(&dup_b, &payload).unwrap();

        let result = super::scan_file_insights_in_roots(
            &[directory.path().to_path_buf()],
            Instant::now(),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .expect("scan file insights");

        assert_eq!(result.candidate_file_count, 4);
        // Only the 2 true duplicates entered full SHA-256 hashing!
        assert_eq!(result.hashed_file_count, 2);
        assert_eq!(result.duplicate_groups.len(), 1);
        assert_eq!(result.duplicate_groups[0].files.len(), 2);
    }
}
